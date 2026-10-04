#!/usr/bin/env python3
"""Claude Code trajectory viewer: a web page that drives Claude Code headless.

Standard library only.  Run:   python3 proto/server.py [--port 8000] [--host 0.0.0.0]
(or PORT=... HOST=... python3 proto/server.py), then open http://localhost:8000

What the server does, and nothing more:
  * POST /api/run          start a run. Body: {"mode": "live"|"replay", "prompt", "cwd",
                           "resume": <session_id or null>, "fixture": <file name>}
  * GET  /api/events/<id>  Server-Sent Events: every stream-json line of that run, as it
                           arrives, plus a few events the SERVER adds (type "server") so the
                           page can tell "process failed to start" from "agent still working".
  * POST /api/stop/<id>    kill a live run.
  * GET  /api/fixtures     list fixtures/*.jsonl for the replay picker.
  * GET  /                 the static page.

The agent loop itself is not reimplemented: `claude -p` does all the work, we only forward
its stdout line by line.
"""
import argparse
import atexit
import glob
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
FIXTURES = os.path.join(HERE, "..", "fixtures")
RUNS_DIR = os.path.join(HERE, "runs")            # every run's events, one file each, so a restart loses nothing

# Permissions for live runs. Headless has nobody to click "allow", so we pre-approve a narrow
# list. Adjust with the CLAUDE_ALLOWED_TOOLS environment variable if your demo needs more.
# Wide enough that an agent exploring a small repo does not spend turns re-splitting refused
# commands, narrow enough that it cannot commit or push into the repository this demo lives in:
# git is read-only here. Compound commands pass when every part is allowed; `$(...)` never does.
ALLOWED_TOOLS = os.environ.get(
    "CLAUDE_ALLOWED_TOOLS",
    ",".join([
        "Read", "Glob", "Grep", "Task", "Edit", "Write",
        "Bash(python3:*)", "Bash(python:*)", "Bash(pytest:*)",
        "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)",
        "Bash(git ls-files:*)", "Bash(git blame:*)", "Bash(git grep:*)",
        "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(find:*)",
        "Bash(grep:*)", "Bash(rg:*)", "Bash(sort:*)", "Bash(uniq:*)", "Bash(echo:*)", "Bash(pwd)", "Bash(tree:*)",
    ]),
)
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
REPLAY_DELAY_S = float(os.environ.get("REPLAY_DELAY_S", "0.15"))
MAX_BUDGET_USD = os.environ.get("MAX_BUDGET_USD", "3")        # per live run; "" disables the cap

RUNS = {}          # run_id -> Run
RUNS_LOCK = threading.Lock()


class Run:
    """One run = one subprocess (or one replayed file) and a list of subscribers."""

    def __init__(self, run_id, spec, started=None, persist=True):
        self.id = run_id
        self.spec = spec
        self.events = []            # every JSON object we forwarded, in order (for late joiners)
        self.subscribers = []       # queue.Queue per open SSE connection
        self.done = False
        self.proc = None
        self.started = started or time.time()
        self.lock = threading.Lock()
        self.file = None
        if persist:
            os.makedirs(RUNS_DIR, exist_ok=True)
            self.file = open(self.path(), "a", encoding="utf-8")
            self.file.write(json.dumps({"type": "server", "subtype": "spec", "spec": spec, "started": self.started}) + "\n")
            self.file.flush()

    def path(self):
        return os.path.join(RUNS_DIR, f"{self.id}.jsonl")

    def publish(self, event):
        with self.lock:
            self.events.append(event)
            subs = list(self.subscribers)
            if self.file:
                self.file.write(json.dumps(event) + "\n")
                self.file.flush()
        for q in subs:
            q.put(event)

    def finish(self):
        with self.lock:
            self.done = True
            subs = list(self.subscribers)
            if self.file:
                self.file.close()
                self.file = None
        for q in subs:
            q.put(None)             # sentinel: stream over

    def subscribe(self):
        q = queue.Queue()
        with self.lock:
            backlog = list(self.events)
            if not self.done:
                self.subscribers.append(q)
            done = self.done
        for e in backlog:
            q.put(e)
        if done:
            q.put(None)
        return q

    def unsubscribe(self, q):
        with self.lock:
            if q in self.subscribers:
                self.subscribers.remove(q)


def read_meta(jsonl_path):
    """record.sh writes <name>.meta next to each recording: the prompt, cwd, flags, exit code.
    The stream itself never echoes the prompt, so this sidecar is the only place it lives."""
    meta_path = jsonl_path[:-len(".jsonl")] + ".meta"
    meta = {}
    if os.path.isfile(meta_path):
        for line in open(meta_path, encoding="utf-8"):
            k, _, v = line.rstrip("\n").partition("=")
            if k:
                meta[k] = v
    return meta


def list_fixtures():
    if not os.path.isdir(FIXTURES):
        return []
    out = []
    for n in sorted(x for x in os.listdir(FIXTURES) if x.endswith(".jsonl")):
        m = read_meta(os.path.join(FIXTURES, n))
        out.append({"name": n, "prompt": m.get("prompt"), "cwd": m.get("cwd"), "flags": m.get("flags"),
                    "exit": m.get("exit"), "seconds": m.get("seconds")})
    return out


def load_saved_runs():
    """Runs written by an earlier server process. One that never reached its exit event was
    interrupted (the server was restarted under it); say so instead of leaving it 'running'."""
    for path in sorted(glob.glob(os.path.join(RUNS_DIR, "*.jsonl")), key=os.path.getmtime):
        try:
            lines = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
        except (OSError, json.JSONDecodeError):
            continue
        if not lines or lines[0].get("subtype") != "spec":
            continue
        run_id = os.path.basename(path)[:-len(".jsonl")]
        run = Run(run_id, lines[0].get("spec") or {}, started=lines[0].get("started"), persist=False)
        run.events = lines[1:]
        if not any(e.get("type") == "server" and e.get("subtype") == "exit" for e in run.events):
            run.events.append(server_event("error", message="interrupted: the server was restarted while this run was in progress"))
            run.events.append(server_event("exit", code=None, stderr=""))
            with open(path, "a", encoding="utf-8") as f:
                for e in run.events[-2:]:
                    f.write(json.dumps(e) + "\n")
        run.done = True
        RUNS[run_id] = run
    return len(RUNS)


def stop_children(*_):
    """On shutdown, take the agent processes down too; an orphaned claude keeps spending."""
    for r in list(RUNS.values()):
        if r.proc and r.proc.poll() is None:
            try:
                r.proc.terminate()
            except OSError:
                pass
    raise SystemExit(0)


def server_event(subtype, **fields):
    """Events the server adds. type="server" so the page never confuses them with Claude's."""
    return {"type": "server", "subtype": subtype, "ts": time.time(), **fields}


def build_command(spec):
    cmd = [CLAUDE_BIN, "-p", spec["prompt"], "--output-format", "stream-json", "--verbose",
           "--permission-mode", "acceptEdits", "--allowedTools", ALLOWED_TOOLS]
    if spec.get("resume"):
        cmd += ["--resume", spec["resume"]]
    if spec.get("partial"):
        cmd += ["--include-partial-messages"]
    budget = spec.get("max_budget_usd") or MAX_BUDGET_USD      # never let a demo run away
    if budget:
        cmd += ["--max-budget-usd", str(budget)]
    return cmd


def run_live(run):
    spec = run.spec
    cwd = os.path.expanduser(spec.get("cwd") or "")
    if not cwd or not os.path.isdir(cwd):
        # Feature 4: a bad working directory must produce a visible error, not a page that waits.
        run.publish(server_event("error", message=f"working directory does not exist: {cwd!r}"))
        run.finish()
        return
    cmd = build_command(spec)
    run.publish(server_event("spawn", command=cmd, cwd=cwd, prompt=spec.get("prompt")))
    try:
        # stdin=DEVNULL matters: with an open, silent stdin claude waits 3 s for piped input
        # ("Warning: no stdin data received in 3s") before it starts.
        proc = subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, bufsize=1)
    except OSError as e:
        run.publish(server_event("error", message=f"could not start claude: {e}"))
        run.finish()
        return
    run.proc = proc
    stderr_lines = []
    threading.Thread(target=lambda: stderr_lines.extend(proc.stderr), daemon=True).start()

    saw_result = False
    for line in proc.stdout:          # one JSON object per line; forward each as it arrives
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            run.publish(server_event("stderr", text=line))   # not JSON: show it, don't crash
            continue
        if event.get("type") == "result":
            saw_result = True
        run.publish(event)
    code = proc.wait()
    tail = "".join(stderr_lines[-30:]).strip()
    if run.spec.get("stopped"):
        run.publish(server_event("stopped", code=code))          # the user asked for this; not a failure
    elif not saw_result:
        # The process died without a result event: that is a failed run.
        run.publish(server_event("error", message=f"claude exited with code {code} before sending a result", stderr=tail))
    run.publish(server_event("exit", code=code, stderr=tail))
    run.finish()


def run_replay(run):
    """Read a recorded events.jsonl and emit it line by line with a small delay, so the page
    exercises the same 'render as it arrives' path as a live run, for free."""
    name = os.path.basename(run.spec.get("fixture") or "")
    path = os.path.join(FIXTURES, name)
    if not name or not os.path.isfile(path):
        run.publish(server_event("error", message=f"no such fixture: {name!r}"))
        run.finish()
        return
    meta = read_meta(path)
    if not run.spec.get("prompt"):
        run.spec["prompt"] = meta.get("prompt") or "(prompt not recorded — stream-json does not echo it)"
    run.spec.setdefault("recorded_cwd", meta.get("cwd"))
    run.spec.setdefault("recorded_flags", meta.get("flags"))
    run.publish(server_event("spawn", command=["<replay>", name], cwd=meta.get("cwd"), prompt=run.spec.get("prompt")))
    delay = float(run.spec.get("delay", REPLAY_DELAY_S))
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                run.publish(json.loads(line))
            except json.JSONDecodeError:
                run.publish(server_event("stderr", text=line))
            if run.spec.get("stopped"):
                break
            time.sleep(delay)
    run.publish(server_event("exit", code=0, stderr=""))
    run.finish()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):   # quieter log: one line per request
        sys.stderr.write("%s %s\n" % (self.command, self.path))

    def end_headers(self):                # static files change while you iterate: never cache them
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ---- helpers -------------------------------------------------------------------------
    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    # ---- routes --------------------------------------------------------------------------
    def do_GET(self):
        if self.path == "/":
            self.path = "/index.html"
        if self.path.startswith("/api/events/"):
            return self.stream_events(self.path.rsplit("/", 1)[1])
        if self.path == "/api/config":
            default_cwd = os.environ.get("DEFAULT_CWD") or os.path.abspath(os.path.join(HERE, "..", "demo-repo"))
            return self.send_json({"default_cwd": default_cwd, "allowed_tools": ALLOWED_TOOLS, "claude_bin": CLAUDE_BIN})
        if self.path == "/api/fixtures":
            return self.send_json({"fixtures": list_fixtures()})
        if self.path == "/api/runs":
            with RUNS_LOCK:
                return self.send_json({"runs": [{"id": r.id, "done": r.done, "spec": r.spec, "started": r.started} for r in RUNS.values()]})
        return super().do_GET()

    def do_POST(self):
        if self.path == "/api/run":
            spec = self.read_json()
            run_id = uuid.uuid4().hex[:8]
            run = Run(run_id, spec)
            with RUNS_LOCK:
                RUNS[run_id] = run
            target = run_replay if spec.get("mode") == "replay" else run_live
            threading.Thread(target=target, args=(run,), daemon=True).start()
            return self.send_json({"run_id": run_id})
        if self.path == "/api/clear":          # forget finished runs so a demo starts on a clean page
            with RUNS_LOCK:
                gone = [rid for rid, r in RUNS.items() if r.done]
                for rid in gone:
                    try:
                        os.remove(RUNS[rid].path())
                    except OSError:
                        pass
                    del RUNS[rid]
            return self.send_json({"cleared": len(gone), "kept": len(RUNS)})
        if self.path.startswith("/api/stop/"):
            run = RUNS.get(self.path.rsplit("/", 1)[1])
            if not run:
                return self.send_json({"error": "no such run"}, HTTPStatus.NOT_FOUND)
            run.spec["stopped"] = True
            if run.proc and run.proc.poll() is None:
                run.proc.terminate()
            return self.send_json({"ok": True})
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def stream_events(self, run_id):
        run = RUNS.get(run_id)
        if not run:
            return self.send_json({"error": "no such run"}, HTTPStatus.NOT_FOUND)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        q = run.subscribe()
        try:
            while True:
                event = q.get()
                if event is None:
                    self.wfile.write(b"event: done\ndata: {}\n\n")
                    self.wfile.flush()
                    break
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            run.unsubscribe(q)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT") or 8000))
    ap.add_argument("--host", default=os.environ.get("HOST") or "0.0.0.0")
    args = ap.parse_args()
    global RUNS_DIR
    RUNS_DIR = os.environ.get("RUNS_DIR") or os.path.join(HERE, "runs", str(args.port))   # one store per server instance
    restored = load_saved_runs()
    signal.signal(signal.SIGTERM, stop_children)
    signal.signal(signal.SIGINT, stop_children)
    atexit.register(lambda: [r.proc.terminate() for r in RUNS.values() if r.proc and r.proc.poll() is None])
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"serving on {args.host}:{args.port}, open http://localhost:{args.port}  (fixtures: {os.path.abspath(FIXTURES)}; {restored} saved runs restored from {RUNS_DIR})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
