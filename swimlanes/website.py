#!/usr/bin/env python3
"""
website.py -- a single-file web frontend for headless Claude Code.

    python3 website.py [--port 8000] [--host 0.0.0.0] [--dir ~/scratch/demo-repo]
    open http://localhost:8000

PORT and HOST environment variables override the defaults (8000, 0.0.0.0);
--port / --host override those. --dir defaults to the bundled
claude_scratchpad/ toy project next to this file.

The server spawns `claude -p ... --output-format stream-json --verbose` as a
subprocess, forwards every event line to the browser over SSE (tagged with the
wall-clock time the line was *read*, which is what the timeline plots), and
keeps the session id so a follow-up prompt can --resume it.

Standard library only. No agent framework, no SDK, no API key -- the child
process uses the same stored credential as interactive Claude Code, and
ANTHROPIC_API_KEY is stripped from its environment on purpose.
"""

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
MODELS = ["opus", "sonnet", "haiku", "fable"]
APP_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DIR = os.path.join(APP_DIR, "claude_scratchpad")


def resolve_replay(path):
    """A relative replay path is tried against the server's cwd first, then
    against this file's folder, so `recordings/...` works from anywhere."""
    path = os.path.expanduser(path)
    if os.path.isabs(path) or os.path.exists(path):
        return path
    alt = os.path.join(APP_DIR, path)
    return alt if os.path.exists(alt) else path

# ---------------------------------------------------------------- event bus --

LOCK = threading.RLock()
LOG = []          # every event ever emitted, so a reload replays the session
SUBS = []         # one queue.Queue per connected browser
SEQ = 0

STATE = {
    "session_id": None,     # last session id claude reported; used for --resume
    "cwd": os.getcwd(),
    "model": "sonnet",
    "subagents": "auto",
    "run": None,            # the currently active run dict, or None
}


def emit(kind, **kw):
    """Append an event to the log and push it to every connected browser."""
    global SEQ
    with LOCK:
        SEQ += 1
        item = {"seq": SEQ, "t": int(time.time() * 1000), "kind": kind}
        item.update(kw)
        LOG.append(item)
        dead = []
        for q in SUBS:
            try:
                q.put_nowait(item)
            except Exception:
                dead.append(q)
        for q in dead:
            SUBS.remove(q)
    return item


# ------------------------------------------------------- subagent model rule --

_PROMPT_HEAD = """\
## Model selection for delegated work

This session is being driven by a web frontend that visualises your trajectory,
and that frontend lets its user pick which model your subagents run on.

When you delegate work with the Task tool, pass the tool's `model` parameter
explicitly. Accepted values: `haiku`, `sonnet`, `opus`, `fable`.
"""

_PROMPT_AUTO = """\
Policy for this run: choose the model per task, matching weight to difficulty.
  - `haiku`  -- light mechanical work: file surveys, greps, listings, collecting
                facts, short summaries.
  - `sonnet` -- ordinary multi-step coding work: reading and editing a few
                files, running tests, straightforward fixes.
  - `opus`   -- genuinely hard work: subtle debugging, cross-cutting refactors,
                design or architecture decisions, ambiguous requirements.
Say in one short clause why you picked the model when you delegate.
"""

_PROMPT_FIXED = """\
Policy for this run: pass `model: "%s"` for every Task call.
"""

_PROMPT_TAIL = """\
The user's own prompt overrides this policy completely. If they name a model for
a piece of work ("use a big model for the refactor, a light one for the survey"),
obey them exactly and pass that model, even where the policy above disagrees.
"""


def build_append_prompt(policy):
    if policy == "off":
        return None
    if policy == "auto":
        body = _PROMPT_AUTO
    else:
        body = _PROMPT_FIXED % policy
    return _PROMPT_HEAD + "\n" + body + "\n" + _PROMPT_TAIL


# ------------------------------------------------------------------- running --

def child_env():
    env = dict(os.environ)
    # An exported key would take precedence over the stored Claude Code login
    # and bill that API account instead, so make sure the child never sees one.
    env.pop("ANTHROPIC_API_KEY", None)
    env.pop("ANTHROPIC_AUTH_TOKEN", None)
    return env


def finish_run(run, status, error=None, exit_code=None):
    with LOCK:
        if run.get("done"):
            return
        run["done"] = True
        if STATE["run"] is run:
            STATE["run"] = None
    emit("run_end", run_id=run["id"], status=status, error=error,
         exit_code=exit_code)


def pump_stderr(run, pipe):
    tail = run["stderr"]
    for line in iter(pipe.readline, ""):
        line = line.rstrip("\n")
        if not line:
            continue
        tail.append(line)
        del tail[:-40]
        emit("stderr", run_id=run["id"], line=line)
    try:
        pipe.close()
    except Exception:
        pass


def run_live(run):
    cmd = [CLAUDE_BIN, "-p", run["prompt"],
           "--output-format", "stream-json",
           "--verbose",
           "--forward-subagent-text",
           "--dangerously-skip-permissions"]
    if run["model"]:
        cmd += ["--model", run["model"]]
    if run["resume"]:
        cmd += ["--resume", run["resume"]]
    ap = build_append_prompt(run["subagents"])
    if ap:
        cmd += ["--append-system-prompt", ap]

    emit("command", run_id=run["id"], argv=cmd)

    try:
        proc = subprocess.Popen(cmd, cwd=run["cwd"], env=child_env(),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, bufsize=1)
    except FileNotFoundError:
        finish_run(run, "failed",
                   "Could not run %r. Is Claude Code installed and on PATH?"
                   % CLAUDE_BIN)
        return
    except Exception as exc:
        finish_run(run, "failed", "Failed to start Claude Code: %s" % exc)
        return

    run["proc"] = proc
    threading.Thread(target=pump_stderr, args=(run, proc.stderr),
                     daemon=True).start()

    saw_result = False
    for line in iter(proc.stdout.readline, ""):
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            emit("stderr", run_id=run["id"], line=line)
            continue
        if ev.get("type") == "system" and ev.get("subtype") == "init":
            sid = ev.get("session_id")
            if sid:
                STATE["session_id"] = sid
        if ev.get("type") == "result":
            saw_result = True
            sid = ev.get("session_id")
            if sid:
                STATE["session_id"] = sid
        emit("cc", run_id=run["id"], ev=ev)

    code = proc.wait()
    if run.get("stopping"):
        finish_run(run, "stopped", "Stopped from the page.", code)
    elif saw_result and code == 0:
        finish_run(run, "finished", None, code)
    else:
        tail = "\n".join(run["stderr"][-12:]).strip()
        msg = tail or ("Claude Code exited with code %s and no result event."
                       % code)
        finish_run(run, "failed", msg, code)


def run_replay(run):
    """Replay a saved events.jsonl, pacing events by their own timestamps."""
    path = run["replay"]
    try:
        with open(path, "r") as fh:
            lines = [l for l in fh if l.strip()]
    except Exception as exc:
        finish_run(run, "failed", "Cannot read %s: %s" % (path, exc))
        return

    emit("command", run_id=run["id"],
         argv=["(replay)", path, "%d events" % len(lines)])

    speed = run.get("speed") or 4.0
    prev = None
    saw_result = False
    for raw in lines:
        if run.get("stopping"):
            finish_run(run, "stopped", "Stopped from the page.")
            return
        try:
            ev = json.loads(raw)
        except ValueError:
            continue
        stamp = ev.get("timestamp")
        now = None
        if isinstance(stamp, str):
            try:
                now = time.mktime(time.strptime(stamp[:19], "%Y-%m-%dT%H:%M:%S"))
            except ValueError:
                now = None
        if prev is not None and now is not None:
            delay = max(0.0, min(5.0, (now - prev) / speed))
        else:
            delay = 0.12
        prev = now if now is not None else prev
        time.sleep(delay)
        if ev.get("type") == "result":
            saw_result = True
        # a replayed session id is not resumable, so it never becomes the
        # session that follow-up prompts continue
        emit("cc", run_id=run["id"], ev=ev)

    finish_run(run, "finished" if saw_result else "failed",
               None if saw_result else "Replay file had no result event.")


def start_run(body):
    prompt = (body.get("prompt") or "").strip()
    cwd = os.path.expanduser((body.get("cwd") or "").strip() or STATE["cwd"])
    model = (body.get("model") or "").strip()
    subagents = (body.get("subagents") or "auto").strip()
    replay = (body.get("replay") or "").strip()
    fresh = bool(body.get("fresh"))

    with LOCK:
        if STATE["run"] is not None:
            return False, "A run is already in progress."
    if not prompt and not replay:
        return False, "Type a prompt first."

    resume = None if fresh else STATE["session_id"]
    if fresh:
        STATE["session_id"] = None

    STATE["cwd"] = cwd
    STATE["model"] = model
    STATE["subagents"] = subagents

    run = {
        "id": "run-%d" % int(time.time() * 1000),
        "prompt": prompt or "(replay %s)" % os.path.basename(replay),
        "cwd": cwd,
        "model": model,
        "subagents": subagents,
        "resume": resume,
        "replay": resolve_replay(replay) if replay else None,
        "speed": body.get("speed") or 4.0,
        "proc": None,
        "stderr": [],
        "done": False,
        "stopping": False,
    }
    with LOCK:
        STATE["run"] = run

    emit("run_start", run_id=run["id"], prompt=run["prompt"], cwd=cwd,
         model=model or "(default)", subagents=subagents, resume=resume,
         replay=run["replay"])

    if run["replay"]:
        threading.Thread(target=run_replay, args=(run,), daemon=True).start()
        return True, run["id"]

    if not os.path.isdir(cwd):
        # A bad working directory is a visible failed run, not a
        # page that waits forever.
        finish_run(run, "failed", "%s is not a directory." % cwd)
        return True, run["id"]

    threading.Thread(target=run_live, args=(run,), daemon=True).start()
    return True, run["id"]


def stop_run():
    with LOCK:
        run = STATE["run"]
    if run is None:
        return False, "Nothing is running."
    run["stopping"] = True
    proc = run.get("proc")
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
        except Exception:
            pass
    else:
        finish_run(run, "stopped", "Stopped from the page.")
    return True, "stopping"


# ----------------------------------------------------------------- http app --

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ClaudeCodeFrontend/1.0"

    def log_message(self, fmt, *args):
        pass

    # -- helpers --

    def _send(self, code, ctype, payload):
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _json(self, code, obj):
        self._send(code, "application/json", json.dumps(obj))

    def _sse(self, item):
        self.wfile.write(("data: %s\n\n" % json.dumps(item)).encode("utf-8"))
        self.wfile.flush()

    # -- routes --

    def do_GET(self):
        url = urlparse(self.path)
        qs = parse_qs(url.query)

        if url.path in ("/", "/index.html"):
            self._send(200, "text/html; charset=utf-8", PAGE)
            return

        if url.path == "/api/config":
            self._json(200, {
                "cwd": STATE["cwd"],
                "model": STATE["model"],
                "subagents": STATE["subagents"],
                "models": MODELS,
                "session_id": STATE["session_id"],
            })
            return

        if url.path == "/api/stream":
            try:
                start = int(qs.get("from", ["0"])[0])
            except ValueError:
                start = 0
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            q = queue.Queue()
            with LOCK:
                backlog = [i for i in LOG if i["seq"] > start]
                SUBS.append(q)
            try:
                for item in backlog:
                    self._sse(item)
                while True:
                    try:
                        item = q.get(timeout=15)
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        continue
                    self._sse(item)
            except Exception:
                pass
            finally:
                with LOCK:
                    if q in SUBS:
                        SUBS.remove(q)
            return

        self._json(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            self._json(400, {"error": "bad json"})
            return

        if url.path == "/api/run":
            ok, msg = start_run(body)
            self._json(200 if ok else 409,
                       {"run_id": msg} if ok else {"error": msg})
            return

        if url.path == "/api/stop":
            ok, msg = stop_run()
            self._json(200 if ok else 409,
                       {"ok": msg} if ok else {"error": msg})
            return

        if url.path == "/api/new_session":
            STATE["session_id"] = None
            emit("session_reset")
            self._json(200, {"ok": True})
            return

        self._json(404, {"error": "not found"})


# --------------------------------------------------------------------- page --

PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code -- trajectory viewer</title>
<style>
:root{
  --bg:#0f1116; --panel:#161922; --panel2:#1c2029; --line:#272c38;
  --fg:#e6e8ee; --dim:#9aa3b2; --faint:#6b7382;
  --accent:#d19a66; --ok:#6fcf97; --err:#f0716f; --pend:#e5c07b;
  --bash:#e5c07b; --read:#61afef; --write:#6fcf97; --search:#c678dd;
  --task:#ef7fb0; --text:#7f8899;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
:root[data-theme="light"]{
  --bg:#f6f7f9; --panel:#ffffff; --panel2:#f0f2f6; --line:#dde1e9;
  --fg:#1a1d24; --dim:#5a6273; --faint:#8b93a3;
  --read:#3878c8; --search:#8a4fbf; --task:#c9407f; --bash:#a8761d;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{
  background:var(--bg);color:var(--fg);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  display:flex;flex-direction:column;overflow:hidden;
}
button,select,input,textarea{font:inherit;color:inherit}
kbd{font:11px var(--mono);background:var(--panel2);border:1px solid var(--line);
    border-radius:4px;padding:1px 5px}

/* ---- header ---- */
header{
  display:flex;align-items:center;gap:14px;padding:9px 16px;
  border-bottom:1px solid var(--line);background:var(--panel);flex:0 0 auto;
}
.brand{font-weight:600;letter-spacing:.2px;white-space:nowrap}
.brand small{color:var(--faint);font-weight:400;margin-left:8px}
.tabs{display:flex;background:var(--panel2);border:1px solid var(--line);
      border-radius:8px;padding:2px}
.tabs button{
  background:none;border:0;padding:5px 14px;border-radius:6px;cursor:pointer;
  color:var(--dim);
}
.tabs button.on{background:var(--bg);color:var(--fg);box-shadow:0 1px 2px #0004}
.spacer{flex:1}
.pill{
  display:inline-flex;align-items:center;gap:6px;padding:3px 10px;
  border-radius:999px;font-size:12px;border:1px solid var(--line);
  background:var(--panel2);color:var(--dim);white-space:nowrap;
}
.pill.running{color:var(--pend);border-color:#5a4a22}
.pill.finished{color:var(--ok);border-color:#2c4c3a}
.pill.failed,.pill.stopped{color:var(--err);border-color:#5a2c2c}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor}
.pill.running .dot{animation:pulse 1s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
.iconbtn{background:none;border:1px solid var(--line);border-radius:7px;
  padding:4px 10px;cursor:pointer;color:var(--dim)}
.iconbtn:hover{color:var(--fg);border-color:var(--faint)}

/* ---- views ---- */
main{flex:1;min-height:0;display:none}
main.on{display:flex}

/* chat view */
#chat{flex-direction:row}
#outline{
  width:250px;flex:0 0 250px;border-right:1px solid var(--line);
  overflow:auto;padding:12px 8px 40px;background:var(--panel);
}
#outline h3{margin:0 0 8px 8px;font-size:11px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--faint);font-weight:600}
.ol-run{margin:2px 0 10px}
.ol-head{
  display:flex;gap:6px;align-items:baseline;padding:4px 8px;border-radius:6px;
  cursor:pointer;font-size:12px;color:var(--dim);
}
.ol-head:hover{background:var(--panel2)}
.ol-head b{color:var(--fg);font-weight:600}
.ol-item{
  display:flex;gap:7px;align-items:center;padding:2px 8px;border-radius:6px;
  cursor:pointer;font-size:12px;color:var(--dim);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;
}
.ol-item:hover{background:var(--panel2);color:var(--fg)}
.ol-item .nm{font-family:var(--mono);font-size:11px}
.ol-item .ar{color:var(--faint);overflow:hidden;text-overflow:ellipsis}
.ol-item.sub{padding-left:24px}
.ol-item.err .nm{color:var(--err)}
.sw{width:6px;height:6px;border-radius:2px;flex:0 0 auto}

#dialogue{flex:1;overflow:auto;padding:18px 22px 60px;scroll-behavior:smooth}
.wrap{max-width:900px;margin:0 auto}

.run{border:1px solid var(--line);border-radius:12px;margin-bottom:18px;
     background:var(--panel);overflow:hidden}
.run.failed{border-color:#5a2c2c}
.run-head{padding:12px 14px;border-bottom:1px solid var(--line);
  background:var(--panel2)}
.you{display:flex;gap:9px;align-items:flex-start}
.you .tag{font-size:11px;color:var(--faint);padding-top:2px;
  text-transform:uppercase;letter-spacing:.1em}
.you .txt{white-space:pre-wrap;flex:1}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.chip{font-size:11px;font-family:var(--mono);color:var(--dim);
  background:var(--bg);border:1px solid var(--line);border-radius:6px;
  padding:1px 7px}
.chip.model{color:var(--accent)}
.chip.resume{color:var(--search)}
.body{padding:10px 14px 14px}
.foldbar{
  font-size:12px;color:var(--dim);cursor:pointer;padding:5px 8px;
  border:1px dashed var(--line);border-radius:7px;margin:4px 0;
}
.foldbar:hover{color:var(--fg);border-color:var(--faint)}

.ev{margin:7px 0}
.evtext{color:var(--fg)}
.evtext p{margin:.45em 0}
.evtext h1,.evtext h2,.evtext h3{margin:.7em 0 .3em;font-size:1.05em}
.evtext ul,.evtext ol{margin:.4em 0;padding-left:1.4em}
.evtext code{font-family:var(--mono);font-size:12.5px;background:var(--panel2);
  border:1px solid var(--line);border-radius:4px;padding:0 4px}
.evtext pre{background:var(--panel2);border:1px solid var(--line);
  border-radius:8px;padding:9px 11px;overflow:auto;margin:.5em 0}
.evtext pre code{background:none;border:0;padding:0;font-size:12px}
.evtext a{color:var(--read)}
.evtext blockquote{border-left:2px solid var(--line);margin:.4em 0;
  padding-left:10px;color:var(--dim)}
.thinking{font-size:12.5px;color:var(--faint);font-style:italic;
  border-left:2px solid var(--line);padding-left:10px;white-space:pre-wrap}

.tool{border:1px solid var(--line);border-radius:9px;background:var(--bg);
      overflow:hidden}
.tool.error{border-color:#5a2c2c}
.tool-head{display:flex;align-items:center;gap:9px;padding:6px 10px;
  cursor:pointer;user-select:none}
.tool-head:hover{background:var(--panel2)}
.tname{font-family:var(--mono);font-size:12px;font-weight:600;flex:0 0 auto}
.targ{font-family:var(--mono);font-size:12px;color:var(--dim);flex:1;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st{font-size:11px;flex:0 0 auto;display:flex;align-items:center;gap:5px;
  color:var(--faint)}
.st.ok{color:var(--ok)} .st.error{color:var(--err)} .st.pending{color:var(--pend)}
.spin{width:9px;height:9px;border:1.5px solid currentColor;border-right-color:
  transparent;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.tool-body{border-top:1px solid var(--line);padding:9px 11px;
  background:var(--panel)}
.lbl{font-size:10px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--faint);margin:6px 0 3px}
.lbl:first-child{margin-top:0}
pre.out{font-family:var(--mono);font-size:12px;white-space:pre-wrap;
  word-break:break-word;margin:0;color:var(--dim);max-height:340px;
  overflow:auto}
pre.out.err{color:var(--err)}
.more{font-size:11.5px;color:var(--read);cursor:pointer;margin-top:5px;
  display:inline-block}
.more:hover{text-decoration:underline}

.subagent{margin:6px 0 6px 0;border-left:2px solid var(--task);
  padding-left:11px}
.sub-head{font-size:11px;color:var(--task);cursor:pointer;
  display:flex;gap:6px;align-items:center;margin-bottom:5px}
.sub-head:hover{opacity:.8}

.result{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
.nums{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;font-size:12px;
  font-family:var(--mono);color:var(--dim)}
.nums b{color:var(--fg);font-weight:600}
.errbox{border:1px solid #5a2c2c;background:#2a1618;border-radius:8px;
  padding:9px 11px;font-family:var(--mono);font-size:12px;color:var(--err);
  white-space:pre-wrap;margin-top:8px}
:root[data-theme="light"] .errbox{background:#fdeceb}
.empty{color:var(--faint);text-align:center;padding:60px 20px}
.empty code{font-family:var(--mono);background:var(--panel2);padding:1px 5px;
  border-radius:4px}

/* timeline view */
#timeline{flex-direction:column}
.tlbar{display:flex;align-items:center;gap:12px;padding:7px 16px;
  border-bottom:1px solid var(--line);background:var(--panel);
  font-size:12px;color:var(--dim);flex:0 0 auto;flex-wrap:wrap}
.tlbar input[type=range]{width:130px;accent-color:var(--accent)}
.legend{display:flex;gap:10px;flex-wrap:wrap}
.legend span{display:inline-flex;align-items:center;gap:5px;font-size:11px}
#tlscroll{flex:1;overflow:auto;position:relative}
#tlinner{position:relative;min-width:100%}
.ruler{position:sticky;top:0;height:26px;background:var(--panel);
  border-bottom:1px solid var(--line);z-index:5}
.tick{position:absolute;top:0;height:26px;border-left:1px solid var(--line);
  font-size:10px;color:var(--faint);padding-left:4px;white-space:nowrap}
.grid{position:absolute;top:0;bottom:0;border-left:1px solid var(--line);
  opacity:.45;pointer-events:none}
.lane{position:relative;height:36px;border-bottom:1px solid var(--line)}
.lane:nth-child(even){background:#ffffff05}
:root[data-theme="light"] .lane:nth-child(even){background:#00000004}
.lanelabel{
  position:sticky;left:0;z-index:4;display:inline-flex;align-items:center;
  gap:6px;height:36px;padding:0 10px;background:var(--panel);
  border-right:1px solid var(--line);font-size:11px;color:var(--dim);
  min-width:140px;max-width:140px;overflow:hidden;white-space:nowrap;
  text-overflow:ellipsis;
}
.blocks{position:absolute;inset:0;margin-left:140px}
.blk{
  position:absolute;top:7px;height:22px;border-radius:5px;cursor:pointer;
  font-size:10.5px;font-family:var(--mono);line-height:22px;padding:0 6px;
  overflow:hidden;white-space:nowrap;color:#0d0f14;font-weight:600;
  border:1px solid #0003;
}
:root[data-theme="light"] .blk{color:#fff;border-color:#0002}
.blk:hover{filter:brightness(1.15);z-index:3}
.blk.pending{background-image:repeating-linear-gradient(45deg,
  #ffffff30 0 6px,transparent 6px 12px);animation:slide 1s linear infinite}
@keyframes slide{to{background-position:17px 0}}
.blk.err{outline:2px solid var(--err);outline-offset:-2px}
.blk.txt{background:var(--text);color:#fff}
.mark{position:absolute;top:0;bottom:0;width:2px;background:var(--accent);
  z-index:2;pointer-events:none}
.marklbl{position:absolute;top:2px;font-size:10px;color:var(--accent);
  padding-left:5px;white-space:nowrap;z-index:6;pointer-events:none;
  max-width:300px;overflow:hidden;text-overflow:ellipsis}
.mark.end{background:var(--faint);opacity:.6}

/* modal */
#modal{position:fixed;inset:0;background:#000a;display:none;z-index:50;
  align-items:center;justify-content:center;padding:24px}
#modal.on{display:flex}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  max-width:820px;width:100%;max-height:82vh;display:flex;flex-direction:column;
  box-shadow:0 20px 60px #0008}
.card header{background:none;border-bottom:1px solid var(--line)}
.card .cbody{overflow:auto;padding:14px 16px}

/* composer */
footer{flex:0 0 auto;border-top:1px solid var(--line);background:var(--panel);
  padding:10px 16px 12px}
.cwrap{max-width:1100px;margin:0 auto}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.field{display:flex;align-items:center;gap:6px;background:var(--bg);
  border:1px solid var(--line);border-radius:8px;padding:3px 8px}
.field label{font-size:11px;color:var(--faint);white-space:nowrap}
.field input,.field select{background:none;border:0;outline:none;font-size:12.5px}
.field input{width:260px;font-family:var(--mono)}
.field.grow{flex:1}
.field.grow input{width:100%}
.sendrow{display:flex;gap:8px;align-items:flex-end}
textarea{flex:1;background:var(--bg);border:1px solid var(--line);
  border-radius:9px;padding:9px 11px;resize:none;outline:none;min-height:44px;
  max-height:170px;line-height:1.45}
textarea:focus{border-color:var(--faint)}
.go{background:var(--accent);color:#11131a;border:0;border-radius:9px;
  padding:0 20px;height:44px;font-weight:600;cursor:pointer}
.go:disabled{opacity:.4;cursor:not-allowed}
.stop{background:none;border:1px solid var(--err);color:var(--err);
  border-radius:9px;padding:0 14px;height:44px;cursor:pointer}
.hint{font-size:11px;color:var(--faint);margin-top:6px}
.toast{position:fixed;bottom:130px;left:50%;transform:translateX(-50%);
  background:var(--err);color:#fff;padding:8px 16px;border-radius:8px;
  font-size:13px;z-index:60;opacity:0;transition:opacity .2s;pointer-events:none}
.toast.on{opacity:1}
@media (max-width:900px){
  #outline{display:none}
  .field input{width:150px}
}
</style>
</head>
<body>

<header>
  <div class="brand">Claude Code <small>trajectory viewer</small></div>
  <div class="tabs">
    <button id="tabChat" class="on">Conversation</button>
    <button id="tabTl">Timeline</button>
  </div>
  <div class="spacer"></div>
  <span id="sessPill" class="pill" style="display:none"></span>
  <span id="statusPill" class="pill"><span class="dot"></span><span id="statusTxt">idle</span></span>
  <button class="iconbtn" id="themeBtn" title="Toggle theme">&#9788;</button>
</header>

<main id="chat" class="on">
  <nav id="outline"><h3>Outline</h3><div id="olBody"></div></nav>
  <div id="dialogue"><div class="wrap" id="feed"></div></div>
</main>

<main id="timeline">
  <div class="tlbar">
    <span>zoom</span>
    <input type="range" id="zoom" min="4" max="400" value="60">
    <span id="zoomTxt" style="font-family:var(--mono);min-width:72px"></span>
    <label style="display:flex;gap:5px;align-items:center;cursor:pointer">
      <input type="checkbox" id="pin" checked> follow live
    </label>
    <div class="spacer"></div>
    <div class="legend" id="legend"></div>
  </div>
  <div id="tlscroll"><div id="tlinner"></div></div>
</main>

<footer>
 <div class="cwrap">
  <div class="row">
    <div class="field grow">
      <label>working dir</label>
      <input id="cwd" spellcheck="false" placeholder="~/scratch/demo-repo">
    </div>
    <div class="field">
      <label>model</label>
      <select id="model"></select>
    </div>
    <div class="field">
      <label>subagents</label>
      <select id="subagents">
        <option value="auto">auto (agent picks per task)</option>
        <option value="haiku">always haiku</option>
        <option value="sonnet">always sonnet</option>
        <option value="opus">always opus</option>
        <option value="off">inherit (no instruction)</option>
      </select>
    </div>
    <button class="iconbtn" id="newSess">New session</button>
    <button class="iconbtn" id="replayBtn" title="Replay a saved stream-json recording (.jsonl)">Replay&hellip;</button>
  </div>
  <div class="sendrow">
    <textarea id="prompt" rows="1" placeholder="Ask Claude Code to do something in that directory&hellip;"></textarea>
    <button class="stop" id="stopBtn" style="display:none">Stop</button>
    <button class="go" id="goBtn">Run</button>
  </div>
  <div class="hint" id="hint"></div>
 </div>
</footer>

<div id="modal"><div class="card">
  <header><div class="brand" id="mTitle"></div><div class="spacer"></div>
    <button class="iconbtn" id="mClose">close</button></header>
  <div class="cbody" id="mBody"></div>
</div></div>
<div class="toast" id="toast"></div>

<script>
"use strict";
/* ============================================================ state ======= */
var S = {
  seq: 0,
  runs: [],
  byRun: {},
  view: "chat",
  pps: 60,            // pixels per second on the timeline
  pin: true,
  active: null,       // active run id
  folded: {},         // collapse state keyed by dom id
};
var $ = function(id){ return document.getElementById(id); };
var TOOL_COLORS = {
  Bash:"#e5c07b", Read:"#61afef", Edit:"#6fcf97", Write:"#6fcf97",
  NotebookEdit:"#6fcf97", Grep:"#c678dd", Glob:"#c678dd", Task:"#ef7fb0",
  WebFetch:"#56b6c2", WebSearch:"#56b6c2", TodoWrite:"#9aa3b2",
  Skill:"#d19a66", Agent:"#ef7fb0"
};
function colorFor(n){ return TOOL_COLORS[n] || "#8d94a5"; }
function shortModel(m){
  return String(m || "").replace(/^claude-/, "").replace(/-\d{8}$/, "")
                        .replace(/\[1m\]$/, "");
}

/* ============================================================ helpers ===== */
function esc(s){
  return String(s == null ? "" : s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}
function fmtDur(ms){
  if (ms == null) return "";
  if (ms < 1000) return ms + " ms";
  var s = ms / 1000;
  if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + " s";
  var m = Math.floor(s / 60);
  return m + "m " + Math.round(s - m * 60) + "s";
}
function fmtCost(c){
  if (c == null) return "";
  return "$" + (c < 0.01 ? c.toFixed(4) : c.toFixed(2));
}
function clockTime(ms){
  var d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}
function toast(msg){
  var t = $("toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(t._h); t._h = setTimeout(function(){ t.classList.remove("on"); }, 3200);
}

/* -- a small markdown renderer: assistant text is markdown, so render it -- */
function md(src){
  var text = String(src == null ? "" : src);
  var blocks = [];
  text = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, function(m, lang, code){
    blocks.push('<pre><code>' + esc(code.replace(/\n$/, "")) + '</code></pre>');
    return "\u0000B" + (blocks.length - 1) + "\u0000";
  });
  function inline(s){
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, function(m, c){ return "<code>" + c + "</code>"; });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return s;
  }
  var out = [], lines = text.split("\n"), i = 0;
  function flushList(tag, items){
    out.push("<" + tag + ">" + items.map(function(x){ return "<li>" + inline(x) + "</li>"; }).join("") + "</" + tag + ">");
  }
  while (i < lines.length){
    var ln = lines[i];
    var ph = ln.match(/^\u0000B(\d+)\u0000$/);
    if (ph){ out.push(blocks[+ph[1]]); i++; continue; }
    if (/^\s*$/.test(ln)){ i++; continue; }
    var h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h){ var lv = Math.min(6, h[1].length + 1); out.push("<h" + lv + ">" + inline(h[2]) + "</h" + lv + ">"); i++; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(ln)){ out.push("<hr>"); i++; continue; }
    if (/^\s*[-*+]\s+/.test(ln)){
      var items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])){ items.push(lines[i].replace(/^\s*[-*+]\s+/, "")); i++; }
      flushList("ul", items); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(ln)){
      var it2 = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])){ it2.push(lines[i].replace(/^\s*\d+[.)]\s+/, "")); i++; }
      flushList("ol", it2); continue;
    }
    if (/^\s*>\s?/.test(ln)){
      var q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])){ q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      out.push("<blockquote>" + inline(q.join(" ")) + "</blockquote>"); continue;
    }
    var para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\u0000B\d+\u0000$/.test(lines[i])
           && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])
           && !/^\s*\d+[.)]\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i])){
      para.push(lines[i]); i++;
    }
    out.push("<p>" + inline(para.join("\n")).replace(/\n/g, "<br>") + "</p>");
  }
  return out.join("");
}

/* -- one-line summary of a tool call's input -- */
function toolArg(name, inp){
  if (!inp) return "";
  switch (name){
    case "Bash": return inp.command || inp.cmd || "";
    case "Read": case "Edit": case "Write": case "NotebookEdit":
      return inp.file_path || inp.path || "";
    case "Grep": return (inp.pattern || "") + (inp.path ? "  in " + inp.path : "");
    case "Glob": return inp.pattern || "";
    case "Task": case "Agent":
      return (inp.description || inp.subagent_type || "subagent");
    case "WebFetch": return inp.url || "";
    case "WebSearch": return inp.query || "";
    case "TodoWrite": return ((inp.todos || []).length) + " todos";
    case "Skill": return inp.skill || "";
  }
  var s = JSON.stringify(inp);
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
}
function resultText(c){
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)){
    return c.map(function(b){
      if (!b || typeof b !== "object") return String(b);
      if (b.type === "text") return b.text;
      if (b.type === "image") return "[image]";
      return JSON.stringify(b);
    }).join("\n");
  }
  return JSON.stringify(c, null, 2);
}

/* ============================================================ ingest ====== */
function newRun(e){
  var r = {
    id: e.run_id, prompt: e.prompt, cwd: e.cwd, model: e.model,
    subagents: e.subagents, resume: e.resume, replay: e.replay,
    t0: e.t, t1: null, status: "running", error: null,
    items: [], byId: {}, sessionId: null, initModel: null,
    result: null, stderr: [], subAgents: {}
  };
  S.runs.push(r); S.byRun[r.id] = r; S.active = r.id;
  return r;
}
function ingest(e){
  S.seq = Math.max(S.seq, e.seq || 0);
  if (e.kind === "run_start"){ newRun(e); return; }
  var r = S.byRun[e.run_id];
  if (e.kind === "run_end"){
    if (!r) return;
    r.status = e.status; r.error = e.error; r.t1 = e.t;
    if (S.active === r.id) S.active = null;
    // any still-pending tool call never got a result
    r.items.forEach(function(it){
      if (it.kind === "tool" && it.status === "pending"){
        it.status = "aborted"; it.tEnd = e.t;
      }
    });
    return;
  }
  if (e.kind === "command"){ if (r) r.argv = e.argv; return; }
  if (e.kind === "stderr"){ if (r) r.stderr.push(e.line); return; }
  if (e.kind === "session_reset"){ return; }
  if (e.kind !== "cc" || !r) return;

  var ev = e.ev, p = ev.parent_tool_use_id || null, t = e.t;

  if (ev.type === "system" && ev.subtype === "init"){
    r.sessionId = ev.session_id; r.initModel = ev.model;
    r.tools = ev.tools; return;
  }
  if (ev.type === "assistant" && ev.message){
    var model = ev.message.model || null;
    if (p && !r.subAgents[p]) r.subAgents[p] = { model: model };
    if (p && model && r.subAgents[p]) r.subAgents[p].model = model;
    (ev.message.content || []).forEach(function(b){
      if (b.type === "text" && String(b.text).trim()){
        r.items.push({ kind:"text", parent:p, t:t, text:b.text, model:model });
      } else if (b.type === "thinking" && String(b.thinking || "").trim()){
        r.items.push({ kind:"thinking", parent:p, t:t, text:b.thinking });
      } else if (b.type === "tool_use"){
        var it = { kind:"tool", id:b.id, parent:p, t:t, name:b.name,
                   input:b.input || {}, status:"pending", result:null,
                   tEnd:null, model:model };
        r.items.push(it); r.byId[b.id] = it;
        if (b.name === "Task" || b.name === "Agent"){
          r.subAgents[b.id] = {
            desc: (b.input && (b.input.description || b.input.subagent_type)) || "subagent",
            model: (b.input && b.input.model) || null,
            requested: (b.input && b.input.model) || null,
            t0: t
          };
        }
      }
    });
    return;
  }
  if (ev.type === "user" && ev.message){
    var content = ev.message.content;
    if (typeof content === "string") return;
    (content || []).forEach(function(b){
      if (b.type !== "tool_result") return;
      var it = r.byId[b.tool_use_id];
      if (!it) return;
      it.status = b.is_error ? "error" : "ok";
      it.result = resultText(b.content);
      it.tEnd = t;
      if (r.subAgents[b.tool_use_id]) r.subAgents[b.tool_use_id].t1 = t;
    });
    return;
  }
  if (ev.type === "result"){
    r.result = ev;
    if (ev.session_id) r.sessionId = ev.session_id;
    return;
  }
}

/* ============================================================ chat view === */
function statusMark(st){
  if (st === "ok") return '<span class="st ok">&#10003;</span>';
  if (st === "error") return '<span class="st error">&#10007; error</span>';
  if (st === "aborted") return '<span class="st error">&#9633; no result</span>';
  return '<span class="st pending"><span class="spin"></span>pending</span>';
}
function foldKey(k){ return S.folded[k]; }
function toggleFold(k, el){
  S.folded[k] = !S.folded[k];
  render();
}
window._tf = toggleFold;

var FOLD_LINES = 12, FOLD_CHARS = 1400;
function foldedOutput(text, key, isErr){
  var t = String(text == null ? "" : text);
  var lines = t.split("\n");
  var open = !!S.folded["open:" + key];
  var longEnough = lines.length > FOLD_LINES || t.length > FOLD_CHARS;
  var shown = t;
  if (longEnough && !open){
    shown = lines.slice(0, FOLD_LINES).join("\n");
    if (shown.length > FOLD_CHARS) shown = shown.slice(0, FOLD_CHARS);
  }
  var html = '<pre class="out' + (isErr ? " err" : "") + '">' + esc(shown) + "</pre>";
  if (longEnough){
    var hidden = lines.length - FOLD_LINES;
    html += '<span class="more" onclick="_tf(\'open:' + key + '\')">'
         + (open ? "▾ fold back" : "▸ " + (hidden > 0 ? hidden + " more lines" : "show all")
            + ", folded")
         + "</span>";
  }
  return html;
}

function renderItems(r, items, depth){
  var html = "";
  items.forEach(function(it){
    var idx = r.items.indexOf(it);
    var domId = "it-" + r.id + "-" + idx;
    if (it.kind === "text"){
      html += '<div class="ev evtext" id="' + domId + '">' + md(it.text) + "</div>";
      return;
    }
    if (it.kind === "thinking"){
      var tk = "think:" + domId;
      html += '<div class="ev" id="' + domId + '">'
        + '<div class="foldbar" onclick="_tf(\'' + tk + '\')">'
        + (S.folded[tk] ? "▾" : "▸") + " thinking</div>"
        + (S.folded[tk] ? '<div class="thinking">' + esc(it.text) + "</div>" : "")
        + "</div>";
      return;
    }
    // tool call
    var isTask = (it.name === "Task" || it.name === "Agent");
    var openKey = "tool:" + domId;
    var open = !!S.folded[openKey];
    var dur = it.tEnd ? it.tEnd - it.t : (Date.now() - it.t);
    html += '<div class="ev" id="' + domId + '">';
    html += '<div class="tool' + (it.status === "error" ? " error" : "") + '">';
    html += '<div class="tool-head" onclick="_tf(\'' + openKey + '\')">'
      + '<span class="sw" style="background:' + colorFor(it.name) + '"></span>'
      + '<span class="tname" style="color:' + colorFor(it.name) + '">' + esc(it.name) + "</span>"
      + '<span class="targ">' + esc(toolArg(it.name, it.input)) + "</span>"
      + (it.input && it.input.model
          ? '<span class="chip model">' + esc(it.input.model) + "</span>" : "")
      + '<span class="st">' + fmtDur(dur) + "</span>"
      + statusMark(it.status)
      + "</div>";
    if (open){
      html += '<div class="tool-body">';
      html += '<div class="lbl">input</div>'
        + foldedOutput(JSON.stringify(it.input, null, 2), domId + ":in", false);
      if (it.result != null){
        html += '<div class="lbl">result</div>'
          + foldedOutput(it.result, domId + ":out", it.status === "error");
      } else if (it.status === "pending"){
        html += '<div class="lbl">result</div><pre class="out">waiting…</pre>';
      }
      html += "</div>";
    } else if (it.result != null && !isTask){
      // a short preview of the result stays visible without expanding
      var first = String(it.result).split("\n").slice(0, 3).join("\n").slice(0, 400);
      if (first.trim()){
        html += '<div class="tool-body"><pre class="out'
          + (it.status === "error" ? " err" : "") + '">' + esc(first)
          + (String(it.result).length > first.length ? "\n…" : "") + "</pre></div>";
      }
    }
    html += "</div>";

    if (isTask){
      var kids = r.items.filter(function(x){ return x.parent === it.id; });
      var sa = r.subAgents[it.id] || {};
      var sk = "sub:" + domId;
      var so = S.folded[sk] !== true;   // subagents expand by default
      html += '<div class="subagent">'
        + '<div class="sub-head" onclick="_tf(\'' + sk + '\')">'
        + (so ? "▾" : "▸") + " subagent"
        + (sa.requested ? " · asked for " + esc(sa.requested) : "")
        + (sa.model ? " · ran on " + esc(shortModel(sa.model)) : "")
        + " · " + kids.length + " event" + (kids.length === 1 ? "" : "s")
        + (so ? "" : ", collapsed") + "</div>";
      if (so) html += renderItems(r, kids, depth + 1);
      html += "</div>";
    }
    html += "</div>";
  });
  return html;
}

function runHtml(r){
  var h = '<div class="run ' + r.status + '" id="run-' + r.id + '">';
  h += '<div class="run-head"><div class="you">'
    + '<span class="tag">you</span><div class="txt">' + esc(r.prompt) + "</div></div>";
  h += '<div class="meta">'
    + '<span class="chip">' + esc(r.cwd) + "</span>"
    + '<span class="chip model">' + esc(shortModel(r.initModel || r.model)) + "</span>"
    + '<span class="chip">subagents: ' + esc(r.subagents) + "</span>"
    + (r.resume ? '<span class="chip resume">resumed ' + esc(String(r.resume).slice(0, 8)) + "…</span>" : "")
    + (r.replay ? '<span class="chip">replay</span>' : "")
    + '<span class="chip">' + clockTime(r.t0) + "</span>"
    + "</div></div>";

  h += '<div class="body">';
  var top = r.items.filter(function(x){ return !x.parent; });
  // fold a long finished run down to its tail
  var fk = "run:" + r.id;
  if (r.status !== "running" && top.length > 14 && !S.folded[fk]){
    var hidden = top.length - 6;
    h += '<div class="foldbar" onclick="_tf(\'' + fk + '\')">▸ '
      + hidden + " earlier events, folded</div>";
    top = top.slice(-6);
  } else if (r.status !== "running" && S.folded[fk]){
    h += '<div class="foldbar" onclick="_tf(\'' + fk + '\')">▾ fold earlier events</div>';
  }
  h += renderItems(r, top, 0);

  if (r.status === "running"){
    h += '<div class="ev"><span class="st pending"><span class="spin"></span>'
      + "running…</span></div>";
  }
  if (r.error){
    h += '<div class="errbox">' + esc(r.error) + "</div>";
  }
  if (r.result || r.status !== "running"){
    var res = r.result || {};
    h += '<div class="result">';
    var badge = r.status === "finished"
      ? '<span class="st ok">&#10003; finished</span>'
      : (r.status === "stopped" ? '<span class="st error">&#9632; stopped</span>'
                                : '<span class="st error">&#10007; failed</span>');
    h += badge;
    if (res.total_cost_usd != null || res.duration_ms != null || res.num_turns != null){
      h += '<div class="nums">'
        + '<span><b>' + fmtCost(res.total_cost_usd) + "</b> cost</span>"
        + "<span>·</span>"
        + '<span><b>' + fmtDur(res.duration_ms) + "</b> wall clock</span>"
        + "<span>·</span>"
        + '<span><b>' + (res.num_turns != null ? res.num_turns : "?") + "</b> turns</span>"
        + (r.sessionId ? "<span>·</span><span>session " + esc(r.sessionId) + "</span>" : "")
        + "</div>";
    } else if (r.sessionId){
      h += '<div class="nums"><span>session ' + esc(r.sessionId) + "</span></div>";
    }
    h += "</div>";
  }
  h += "</div></div>";
  return h;
}

function renderChat(){
  var feed = $("feed");
  if (!S.runs.length){
    feed.innerHTML = '<div class="empty">No runs yet.<br><br>'
      + "Point the working directory at a scratch repo and ask for something "
      + "concrete, e.g.<br><code>find the bug that makes test_parse fail and fix it</code>"
      + "<br><br>Tip: name a model per piece of work &mdash; "
      + "<code>use a haiku subagent to list the files, then an opus subagent for the refactor</code>"
      + "</div>";
    return;
  }
  var pane = $("dialogue");
  var atBottom = isNearBottom(pane);
  var keep = pane.scrollTop;
  feed.innerHTML = S.runs.map(runHtml).join("");
  pane.scrollTop = atBottom ? pane.scrollHeight : keep;
}
function isNearBottom(el){
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

/* ---- outline (table of contents beside the dialogue) ---- */
function outlineItems(r, items, sub, out){
  items.forEach(function(it){
    if (it.kind !== "tool") return;
    var idx = r.items.indexOf(it);
    out.push('<div class="ol-item' + (sub ? " sub" : "")
      + (it.status === "error" ? " err" : "")
      + '" onclick="_jump(\'it-' + r.id + "-" + idx + '\')">'
      + '<span class="sw" style="background:' + colorFor(it.name) + '"></span>'
      + '<span class="nm">' + esc(it.name) + "</span>"
      + '<span class="ar">' + esc(toolArg(it.name, it.input)) + "</span>"
      + (it.status === "pending" ? '<span class="st pending"><span class="spin"></span></span>' : "")
      + "</div>");
    if (it.name === "Task" || it.name === "Agent"){
      outlineItems(r, r.items.filter(function(x){ return x.parent === it.id; }), true, out);
    }
  });
}
function renderOutline(){
  var out = [];
  S.runs.forEach(function(r, i){
    out.push('<div class="ol-run">');
    out.push('<div class="ol-head" onclick="_jump(\'run-' + r.id + '\')">'
      + "<b>#" + (i + 1) + "</b><span>" + esc(r.prompt.slice(0, 40))
      + (r.prompt.length > 40 ? "…" : "") + "</span></div>");
    outlineItems(r, r.items.filter(function(x){ return !x.parent; }), false, out);
    out.push("</div>");
  });
  $("olBody").innerHTML = out.join("") ||
    '<div class="ol-item" style="color:var(--faint)">nothing yet</div>';
}
window._jump = function(id){
  $("modal").classList.remove("on");
  showView("chat");
  var el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.style.transition = "none";
  el.style.outline = "2px solid var(--accent)";
  el.style.borderRadius = "8px";
  setTimeout(function(){ el.style.transition = "outline .6s"; el.style.outline = "none"; }, 700);
};

/* ============================================================ timeline ==== */
/* Lanes: lane 0 is the main agent; every Task call gets its own lane, reusing
   a lane once its subagent has finished, so concurrent subagents stack above
   one another and you can see they overlap in time. */
function buildLanes(){
  var all = [];
  S.runs.forEach(function(r){ all.push(r); });
  if (!all.length) return null;
  var t0 = all[0].t0;
  var tEnd = t0 + 1;
  var lanes = [{ label: "main agent", color: "#9aa3b2", blocks: [], busyUntil: 0 }];
  var laneOf = {};   // task id -> lane index

  all.forEach(function(r){
    tEnd = Math.max(tEnd, r.t1 || Date.now());
    r.items.forEach(function(it){
      var parent = it.parent;
      var lane = 0;
      if (parent){
        if (laneOf[parent] == null) laneOf[parent] = allocLane(lanes, parent, r);
        lane = laneOf[parent];
      }
      var start = it.t;
      var end = it.kind === "tool"
        ? (it.tEnd || (it.status === "pending" ? Date.now() : it.t + 400))
        : it.t + 300;
      tEnd = Math.max(tEnd, end);
      lanes[lane].blocks.push({ it: it, run: r, start: start, end: end });
      lanes[lane].busyUntil = Math.max(lanes[lane].busyUntil, end);
      if (it.kind === "tool" && (it.name === "Task" || it.name === "Agent")){
        // give the subagent its lane the moment the Task call is made, so the
        // lane order follows the order the subagents were spawned in
        if (laneOf[it.id] == null) laneOf[it.id] = allocLane(lanes, it.id);
      }
    });
  });
  return { t0: t0, tEnd: tEnd, lanes: lanes, runs: all };
}
/* One lane per subagent, never reused: two subagents running at the same time
   therefore sit one above the other, which is the point of the view. */
function allocLane(lanes, key){
  var sa = null;
  for (var i = 0; i < S.runs.length; i++){
    if (S.runs[i].subAgents[key]){ sa = S.runs[i].subAgents[key]; break; }
  }
  var label = (sa && sa.desc) || "subagent";
  var m = sa && (sa.model || sa.requested);
  if (m) label += " · " + shortModel(m);
  lanes.push({ label: label, blocks: [], busyUntil: 0 });
  return lanes.length - 1;
}

function renderTimeline(){
  var m = buildLanes();
  var inner = $("tlinner");
  if (!m){
    inner.innerHTML = '<div class="empty">Run something and the timeline fills in '
      + "from left to right.</div>";
    return;
  }
  var pps = S.pps, t0 = m.t0;
  var span = Math.max(4000, m.tEnd - t0 + 2000);
  var w = (span / 1000) * pps;
  var x = function(t){ return ((t - t0) / 1000) * pps; };

  var html = "";
  // ruler
  var step = pickStep(pps);
  var ruler = '<div class="ruler" style="width:' + (w + 160) + 'px">';
  for (var s = 0; s * 1000 <= span; s += step){
    ruler += '<div class="tick" style="left:' + (140 + s * pps) + 'px">' + s + "s</div>";
  }
  ruler += "</div>";

  var lanesHtml = "";
  m.lanes.forEach(function(lane, li){
    var blocks = "";
    // pack overlapping blocks into sub-rows, so two calls that were in flight
    // at the same time sit above one another instead of on top of each other
    var rowEnds = [];
    lane.blocks.sort(function(a, b){ return a.start - b.start; });
    lane.blocks.forEach(function(b){
      var row = 0;
      while (row < rowEnds.length && rowEnds[row] > b.start) row++;
      b.row = row;
      rowEnds[row] = Math.max(b.end, b.start + (14 / pps) * 1000);
    });
    var rows = Math.max(1, rowEnds.length);
    var laneH = 14 + rows * 26;
    lane.blocks.forEach(function(b){
      var it = b.it;
      var left = x(b.start);
      var width = Math.max(10, x(b.end) - x(b.start));
      var cls = "blk";
      var style, label;
      if (it.kind === "tool"){
        style = "background:" + colorFor(it.name);
        label = it.name + (toolArg(it.name, it.input) ? "  " + toolArg(it.name, it.input) : "");
        if (it.status === "pending") cls += " pending";
        if (it.status === "error" || it.status === "aborted") cls += " err";
      } else {
        cls += " txt";
        style = "";
        label = it.kind === "thinking" ? "thinking" : String(it.text).slice(0, 60).replace(/\n/g, " ");
      }
      var idx = b.run.items.indexOf(it);
      blocks += '<div class="' + cls + '" style="top:' + (7 + b.row * 26)
        + "px;left:" + left + "px;width:" + width
        + "px;" + style + '" title="' + esc(label) + '" onclick="_pop(\''
        + b.run.id + "','" + idx + "')\">" + esc(label) + "</div>";
    });
    lanesHtml += '<div class="lane" style="width:' + (w + 160) + "px;height:"
      + laneH + 'px">'
      + '<div class="lanelabel" style="height:' + laneH + 'px" title="'
      + esc(lane.label) + '">'
      + '<span class="sw" style="background:' + (li === 0 ? "#9aa3b2" : "#ef7fb0") + '"></span>'
      + esc(lane.label) + "</div>"
      + '<div class="blocks">' + blocks + "</div></div>";
  });

  // run submission markers, drawn over every lane
  var marks = "";
  m.runs.forEach(function(r, i){
    marks += '<div class="mark" style="left:' + (140 + x(r.t0)) + 'px"></div>'
      + '<div class="marklbl" style="left:' + (140 + x(r.t0)) + 'px">▸ #'
      + (i + 1) + " " + esc(r.prompt.slice(0, 34)) + "</div>";
    if (r.t1){
      marks += '<div class="mark end" style="left:' + (140 + x(r.t1)) + 'px"></div>';
    }
  });

  var body = '<div style="position:relative">' + lanesHtml
    + '<div style="position:absolute;inset:0;pointer-events:none">' + marks + "</div></div>";

  var scroll = $("tlscroll");
  var wasPinned = S.pin;
  inner.innerHTML = ruler + body;
  inner.style.width = (w + 180) + "px";
  if (wasPinned) scroll.scrollLeft = scroll.scrollWidth;

  $("zoomTxt").textContent = pps + " px/s";
  $("legend").innerHTML = Object.keys(TOOL_COLORS).slice(0, 8).map(function(k){
    return '<span><span class="sw" style="background:' + TOOL_COLORS[k]
      + '"></span>' + k + "</span>";
  }).join("");
}
function pickStep(pps){
  var targets = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (var i = 0; i < targets.length; i++){ if (targets[i] * pps >= 70) return targets[i]; }
  return 900;
}

window._pop = function(runId, idx){
  var r = S.byRun[runId]; if (!r) return;
  var it = r.items[+idx]; if (!it) return;
  var h = "";
  if (it.kind === "tool"){
    var dur = it.tEnd ? it.tEnd - it.t : Date.now() - it.t;
    $("mTitle").innerHTML = '<span class="sw" style="display:inline-block;background:'
      + colorFor(it.name) + '"></span> ' + esc(it.name);
    h += '<div class="meta">'
      + '<span class="chip">started ' + clockTime(it.t) + "</span>"
      + '<span class="chip">' + fmtDur(dur) + "</span>"
      + '<span class="chip">' + esc(it.status) + "</span>"
      + (it.parent ? '<span class="chip resume">subagent</span>' : '<span class="chip">main agent</span>')
      + (it.input && it.input.model ? '<span class="chip model">' + esc(it.input.model) + "</span>" : "")
      + "</div>";
    h += '<div class="lbl">input</div><pre class="out">'
      + esc(JSON.stringify(it.input, null, 2)) + "</pre>";
    h += '<div class="lbl">result</div><pre class="out'
      + (it.status === "error" ? " err" : "") + '">'
      + esc(it.result != null ? it.result : (it.status === "pending" ? "still running…" : "(none)"))
      + "</pre>";
    h += '<div style="margin-top:12px"><span class="more" onclick="_jump(\'it-'
      + r.id + "-" + idx + '\')">→ show in the conversation</span></div>';
  } else {
    $("mTitle").textContent = it.kind === "thinking" ? "thinking" : "assistant";
    h += '<div class="meta"><span class="chip">' + clockTime(it.t) + "</span>"
      + (it.parent ? '<span class="chip resume">subagent</span>' : "") + "</div>";
    h += '<div class="evtext">' + md(it.text) + "</div>";
  }
  $("mBody").innerHTML = h;
  $("modal").classList.add("on");
};

/* ============================================================ shell ======= */
function showView(v){
  S.view = v;
  $("chat").classList.toggle("on", v === "chat");
  $("timeline").classList.toggle("on", v === "timeline");
  $("tabChat").classList.toggle("on", v === "chat");
  $("tabTl").classList.toggle("on", v === "timeline");
  render();
}
var _pending = false;
function render(){
  if (_pending) return;
  _pending = true;
  requestAnimationFrame(function(){
    _pending = false;
    if (S.view === "chat"){ renderChat(); renderOutline(); }
    else { renderTimeline(); }
    renderStatus();
  });
}
function renderStatus(){
  var running = S.runs.filter(function(r){ return r.status === "running"; });
  var pill = $("statusPill"), txt = $("statusTxt");
  pill.className = "pill";
  if (running.length){
    pill.classList.add("running");
    var pend = 0;
    running.forEach(function(r){
      r.items.forEach(function(i){ if (i.kind === "tool" && i.status === "pending") pend++; });
    });
    txt.textContent = "running" + (pend ? " · " + pend + " pending" : "");
    $("stopBtn").style.display = "";
    $("goBtn").disabled = true;
  } else {
    var last = S.runs[S.runs.length - 1];
    if (last){
      pill.classList.add(last.status);
      txt.textContent = last.status;
    } else { txt.textContent = "idle"; }
    $("stopBtn").style.display = "none";
    $("goBtn").disabled = false;
  }
  var sid = null;
  for (var i = S.runs.length - 1; i >= 0; i--){ if (S.runs[i].sessionId){ sid = S.runs[i].sessionId; break; } }
  var sp = $("sessPill");
  if (sid && !S._resetSession){
    sp.style.display = "";
    sp.textContent = "session " + sid.slice(0, 8) + "… (follow-ups resume it)";
  } else { sp.style.display = "none"; }
}

/* live tick so pending durations and pending-block widths keep moving */
setInterval(function(){
  var anyPending = S.runs.some(function(r){
    return r.status === "running" ||
      r.items.some(function(i){ return i.kind === "tool" && i.status === "pending"; });
  });
  if (anyPending) render();
}, 400);

/* ---- transport ---- */
function connect(){
  var es = new EventSource("/api/stream?from=" + S.seq);
  es.onmessage = function(m){
    try { ingest(JSON.parse(m.data)); } catch (e) { console.error(e); }
    render();
  };
  es.onerror = function(){
    es.close();
    setTimeout(connect, 1200);
  };
}

function post(path, body){
  return fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); });
}

function submit(extra){
  var body = {
    prompt: $("prompt").value,
    cwd: $("cwd").value,
    model: $("model").value,
    subagents: $("subagents").value
  };
  if (extra) for (var k in extra) body[k] = extra[k];
  if (S._resetSession){ body.fresh = true; }
  post("/api/run", body).then(function(res){
    if (!res.ok){ toast(res.j.error || "could not start"); return; }
    S._resetSession = false;
    $("prompt").value = "";
    $("prompt").style.height = "auto";
  });
}

/* ---- wiring ---- */
$("tabChat").onclick = function(){ showView("chat"); };
$("tabTl").onclick = function(){ showView("timeline"); };
$("goBtn").onclick = function(){ submit(); };
$("stopBtn").onclick = function(){ post("/api/stop", {}); };
$("newSess").onclick = function(){
  post("/api/new_session", {}).then(function(){
    S._resetSession = true;
    toast("next prompt starts a fresh session");
    renderStatus();
  });
};
$("replayBtn").onclick = function(){
  var p = window.prompt("Path to a saved stream-json recording (.jsonl) to replay:",
                        "recordings/demo-2-subagents.jsonl");
  if (p) submit({ replay: p, prompt: "" });
};
$("prompt").addEventListener("keydown", function(e){
  if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); submit(); }
});
$("prompt").addEventListener("input", function(){
  this.style.height = "auto";
  this.style.height = Math.min(170, this.scrollHeight) + "px";
});
$("zoom").addEventListener("input", function(){
  S.pps = +this.value; renderTimeline();
});
$("pin").addEventListener("change", function(){ S.pin = this.checked; });
$("tlscroll").addEventListener("scroll", function(){
  var el = this;
  var atEnd = el.scrollWidth - el.scrollLeft - el.clientWidth < 40;
  if (!atEnd && S.pin){ S.pin = false; $("pin").checked = false; }
});
$("modal").addEventListener("click", function(e){
  if (e.target === this) this.classList.remove("on");
});
$("mClose").onclick = function(){ $("modal").classList.remove("on"); };
document.addEventListener("keydown", function(e){
  if (e.key === "Escape") $("modal").classList.remove("on");
});
$("themeBtn").onclick = function(){
  var cur = document.documentElement.getAttribute("data-theme");
  var next = cur === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("cc-theme", next); } catch (e) {}
};
try {
  var th = localStorage.getItem("cc-theme");
  if (th) document.documentElement.setAttribute("data-theme", th);
} catch (e) {}

fetch("/api/config").then(function(r){ return r.json(); }).then(function(c){
  $("cwd").value = c.cwd;
  var sel = $("model");
  sel.innerHTML = '<option value="">default</option>'
    + c.models.map(function(m){ return '<option value="' + m + '">' + m + "</option>"; }).join("");
  sel.value = c.model || "";
  $("subagents").value = c.subagents || "auto";
  $("hint").innerHTML = "<kbd>Enter</kbd> run · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline"
    + " · the model box sets the main agent; subagents follow the policy box"
    + " unless your prompt names a model for them.";
  connect();
  render();
});
</script>
</body>
</html>
"""


# --------------------------------------------------------------------- main --

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int,
                    default=int(os.environ.get("PORT") or 8000),
                    help="port to listen on (env PORT, default 8000)")
    ap.add_argument("--host", default=os.environ.get("HOST") or "0.0.0.0",
                    help="interface to bind (env HOST, default 0.0.0.0)")
    ap.add_argument("--dir", default=None,
                    help="default working directory the agent runs in "
                         "(default: the bundled claude_scratchpad/)")
    ap.add_argument("--model", default="sonnet", help="default main-agent model")
    args = ap.parse_args()

    if args.dir:
        STATE["cwd"] = os.path.abspath(os.path.expanduser(args.dir))
    elif os.path.isdir(DEFAULT_DIR):
        STATE["cwd"] = DEFAULT_DIR
    STATE["model"] = args.model

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print("Claude Code trajectory viewer")
    shown = "localhost" if args.host in ("0.0.0.0", "::", "") else args.host
    print("  http://%s:%d  (listening on %s:%d)" % (shown, args.port,
                                                   args.host, args.port))
    print("  working dir : %s" % STATE["cwd"])
    print("  claude bin  : %s" % (CLAUDE_BIN))
    print("  runs use --dangerously-skip-permissions: point it at a scratch dir.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
