import asyncio
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

from . import db, summarize
from .config import CLAUDE_BIN, FIXTURES, INLINE_RESULT_CHARS

EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit", "Update"}
SNAPSHOT_CHARS = 400_000
RUNS: dict[str, "Run"] = {}


def build_argv(prompt: str, opts: dict) -> list[str]:
    a = [CLAUDE_BIN, "-p", prompt, "--output-format", "stream-json", "--verbose",
         "--forward-subagent-text"]
    if opts.get("resume"):
        a += ["--resume", opts["resume"]]
    if opts.get("model"):
        a += ["--model", opts["model"]]
    if opts.get("effort"):
        a += ["--effort", opts["effort"]]
    if opts.get("skip_permissions", True):
        a += ["--dangerously-skip-permissions"]
    elif opts.get("permission_mode"):
        a += ["--permission-mode", opts["permission_mode"]]
    if opts.get("tools"):
        a += ["--tools", ",".join(opts["tools"])]
    if opts.get("allowed_tools"):
        a += ["--allowedTools", *opts["allowed_tools"]]
    if opts.get("disallowed_tools"):
        a += ["--disallowedTools", *opts["disallowed_tools"]]
    if opts.get("mcp_config"):
        a += ["--mcp-config", *opts["mcp_config"]]
    if opts.get("strict_mcp"):
        a += ["--strict-mcp-config"]
    if opts.get("disable_skills"):
        a += ["--disable-slash-commands"]
    if opts.get("append_system_prompt"):
        a += ["--append-system-prompt", opts["append_system_prompt"]]
    if opts.get("add_dirs"):
        a += ["--add-dir", *opts["add_dirs"]]
    if opts.get("max_turns"):
        a += ["--max-turns", str(opts["max_turns"])]
    if opts.get("agent"):
        a += ["--agent", opts["agent"]]
    return a


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in content)
    return "" if content is None else str(content)


def _clip(s: str) -> tuple[str, int, int]:
    """Returns (inline text, total chars, total lines)."""
    lines = s.count("\n") + 1 if s else 0
    if len(s) <= INLINE_RESULT_CHARS:
        return s, len(s), lines
    return s[:INLINE_RESULT_CHARS], len(s), lines


class Run:
    """One headless Claude Code invocation, normalised into UI frames."""

    def __init__(self, run_id: str, cwd: str, prompt: str, opts: dict, replay: str | None = None):
        self.id, self.cwd, self.prompt, self.opts, self.replay = run_id, cwd, prompt, opts, replay
        self.frames: list[dict] = []
        self.subs: set[asyncio.Queue] = set()
        self.done = asyncio.Event()
        self.proc: asyncio.subprocess.Process | None = None
        self.seq = 0
        self.session_id: str | None = None
        self.status = "starting"
        self.t0 = time.time()
        self.pending: dict[str, float] = {}   # tool_use_id -> start
        self.tool_meta: dict[str, dict] = {}
        self.sums: set[asyncio.Task] = set()  # in-flight one-line summaries of tool calls
        self.phases: dict[str, float] = {}    # wall clock, one bucket per thing we waited on
        self.tool_ms: dict[str, float] = {}   # per tool name
        self.tool_n: dict[str, int] = {}
        self.legs: list[dict] = []            # every phase leg, in order
        self.emit_ms = 0.0                    # server-side frame serialise + fan-out
        self.ttft_ms: float | None = None
        self.wait = "queue"
        self.mark = self.t0
        self.group = 0        # one per assistant message: the unit the graph shows as a node

    # ---------- frame plumbing ----------

    def emit(self, kind: str, **body) -> dict:
        t = time.perf_counter()
        self.seq += 1
        f = {"seq": self.seq, "ts": time.time(), "kind": kind, **body}
        self.frames.append(f)
        db.run("INSERT OR REPLACE INTO frames(run_id,seq,ts,body) VALUES(?,?,?,?)",
               (self.id, f["seq"], f["ts"], db.js(f)))
        for qq in list(self.subs):
            qq.put_nowait(f)
        self.emit_ms += (time.perf_counter() - t) * 1000
        return f

    def subscribe(self, after: int = 0) -> asyncio.Queue:
        qq: asyncio.Queue = asyncio.Queue()
        for f in self.frames:
            if f["seq"] > after:
                qq.put_nowait(f)
        self.subs.add(qq)
        return qq

    # ---------- latency accounting ----------

    def tick(self, phase: str | None = None, label: str | None = None) -> None:
        """Close the leg that just ended and attribute its wall clock to one bucket."""
        now = time.time()
        p = phase or ("tools" if self.pending else self.wait)
        dt = (now - self.mark) * 1000
        self.phases[p] = self.phases.get(p, 0.0) + dt
        self.legs.append({"phase": p, "ms": round(dt, 1), "at": round(now - self.t0, 3),
                          **({"label": label} if label else {})})
        self.mark = now

    def timing(self) -> dict:
        return {
            "emit_ms": round(self.emit_ms, 2),
            "ttft_ms": round(self.ttft_ms) if self.ttft_ms is not None else None,
            "by_tool": {k: {"ms": round(v), "n": self.tool_n.get(k, 0)} for k, v in self.tool_ms.items()},
            "legs": self.legs[-400:],
        }

    def snapshot(self, tid: str, path: str, tool: str, kind: str) -> None:
        """Store the file's content on either side of an edit, so versions can be diffed later."""
        try:
            text = Path(path).read_text(errors="replace")[:SNAPSHOT_CHARS]
        except OSError:
            text = ""
        db.run("INSERT INTO versions(run_id,tool_use_id,cwd,path,kind,tool,ts,chars,text) "
               "VALUES(?,?,?,?,?,?,?,?,?)",
               (self.id, tid, self.cwd, path, kind, tool, time.time(), len(text), text))

    # ---------- event handling ----------

    def handle(self, ev: dict) -> None:
        t = ev.get("type")
        parent = ev.get("parent_tool_use_id")
        if t == "system" and ev.get("subtype") == "init":
            self.tick("boot")
            self.wait = "think"
            self.session_id = ev.get("session_id")
            self.status = "running"
            db.run("UPDATE runs SET session_id=?, model=?, status='running' WHERE id=?",
                   (self.session_id, ev.get("model"), self.id))
            self.emit("init", session_id=self.session_id, model=ev.get("model"),
                      cwd=ev.get("cwd"), tools=ev.get("tools") or [],
                      mcp=ev.get("mcp_servers") or [], commands=ev.get("slash_commands") or [],
                      agents=ev.get("agents") or [], permission_mode=ev.get("permissionMode"))
        elif t == "assistant":
            self.group += 1
            if self.ttft_ms is None:
                self.ttft_ms = (time.time() - self.t0) * 1000
            self.tick()
            msg = ev.get("message") or {}
            for b in msg.get("content") or []:
                if b.get("type") == "text" and b.get("text", "").strip():
                    self.emit("text", parent=parent, group=self.group, text=b["text"])
                elif b.get("type") == "thinking" and b.get("thinking", "").strip():
                    self.emit("thinking", parent=parent, group=self.group, text=b["thinking"])
                elif b.get("type") == "tool_use":
                    self.on_tool_use(b, parent)
            if msg.get("usage"):
                self.emit("usage", parent=parent, usage=msg["usage"], model=msg.get("model"))
        elif t == "user":
            msg = ev.get("message") or {}
            content = msg.get("content")
            if isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        self.on_tool_result(b, parent)
        elif t == "result":
            self.tick()
            self.wait = "exit"
            self.finish(ev)

    def summarise(self, tid: str, name: str, inp: dict, key: str) -> None:
        """Ask the small model what this call is for, and emit the line whenever it lands."""
        async def go() -> None:
            try:
                text = await summarize.tool_summary(name, inp, key)
            except Exception:
                text = None
            self.emit("tool.summary", id=tid, text=text or summarize.heuristic(name, inp))

        t = asyncio.create_task(go())
        self.sums.add(t)
        t.add_done_callback(self.sums.discard)

    def on_tool_use(self, b: dict, parent: str | None) -> None:
        tid = b.get("id") or str(uuid.uuid4())
        name, inp = b.get("name", "?"), b.get("input") or {}
        self.pending[tid] = time.time()
        self.tool_meta[tid] = {"name": name, "input": inp, "parent": parent}
        key = summarize.sig(name, inp)
        db.run("INSERT OR REPLACE INTO tool_calls"
               "(run_id,tool_use_id,name,input,parent,started_at,sig) VALUES(?,?,?,?,?,?,?)",
               (self.id, tid, name, db.js(inp), parent, time.time(), key))
        if name in EDIT_TOOLS and not self.replay:  # a replay never touched these files
            p = inp.get("file_path") or inp.get("notebook_path") or inp.get("path")
            if p:
                body = inp.get("content") or inp.get("new_string") or ""
                db.run("INSERT INTO edits(run_id,cwd,path,tool,ts,bytes) VALUES(?,?,?,?,?,?)",
                       (self.id, self.cwd, str(p), name, time.time(), len(str(body))))
                self.snapshot(tid, str(p), name, "before")
        # a line we already have rides along with the call; only a fresh generation defers
        line = summarize.cached(key) or (None if summarize.enabled() else summarize.heuristic(name, inp))
        self.emit("tool.call", id=tid, parent=parent, group=self.group, name=name, input=inp,
                  summary=line, eta_ms=summarize.eta_ms(name, key))
        if line is None:
            self.summarise(tid, name, inp, key)

    def on_tool_result(self, b: dict, parent: str | None) -> None:
        tid = b.get("tool_use_id")
        started = self.pending.pop(tid, None)
        meta = self.tool_meta.get(tid) or {}
        name = meta.get("name") or "?"
        if started:
            d = (time.time() - started) * 1000
            self.tool_ms[name] = self.tool_ms.get(name, 0.0) + d
            self.tool_n[name] = self.tool_n.get(name, 0) + 1
        if not self.pending:
            self.tick("tools" if started else None, label=name)
        if name in EDIT_TOOLS and not b.get("is_error") and not self.replay:
            p = (meta.get("input") or {}).get("file_path") or (meta.get("input") or {}).get("notebook_path")
            if p:
                self.snapshot(tid, str(p), name, "after")
        raw = _text(b.get("content"))
        inline, chars, lines = _clip(raw)
        dur = int((time.time() - started) * 1000) if started else None
        db.run("UPDATE tool_calls SET ended_at=?, is_error=?, result=?, result_chars=? "
               "WHERE run_id=? AND tool_use_id=?",
               (time.time(), 1 if b.get("is_error") else 0, raw, chars, self.id, tid))
        self.emit("tool.result", id=tid, parent=parent, is_error=bool(b.get("is_error")),
                  text=inline, chars=chars, lines=lines, truncated=chars > len(inline),
                  duration_ms=dur, name=name)

    def finish(self, ev: dict) -> None:
        ok = ev.get("subtype") == "success" and not ev.get("is_error")
        self.status = "finished" if ok else "failed"
        usage = ev.get("usage") or {}
        summary = {
            "status": self.status,
            "cost_usd": ev.get("total_cost_usd"),
            "duration_ms": ev.get("duration_ms"),
            "api_duration_ms": ev.get("duration_api_ms"),
            "num_turns": ev.get("num_turns"),
            "session_id": ev.get("session_id") or self.session_id,
            "usage": usage,
            "result": ev.get("result") if isinstance(ev.get("result"), str) else None,
            "subtype": ev.get("subtype"),
            "phases": {k: round(v) for k, v in self.phases.items()},
            "timing": self.timing(),
        }
        db.run(
            "UPDATE runs SET status=?,ended_at=?,cost_usd=?,duration_ms=?,api_duration_ms=?,"
            "num_turns=?,usage=?,phases=?,timing=?,result=?,session_id=? WHERE id=?",
            (self.status, time.time(), summary["cost_usd"], summary["duration_ms"],
             summary["api_duration_ms"], summary["num_turns"], db.js(usage),
             db.js(summary["phases"]), db.js(summary["timing"]), summary["result"],
             summary["session_id"], self.id))
        self.emit("run.finished", **summary)

    def persist_timing(self) -> None:
        phases = {k: round(v) for k, v in self.phases.items()}
        db.run("UPDATE runs SET phases=?, timing=? WHERE id=?",
               (db.js(phases), db.js(self.timing()), self.id))
        self.emit("run.timing", phases=phases, timing=self.timing())

    def fail(self, message: str) -> None:
        self.status = "failed"
        db.run("UPDATE runs SET status='failed', ended_at=?, error=?, phases=?, timing=? WHERE id=?",
               (time.time(), message, db.js({k: round(v) for k, v in self.phases.items()}),
                db.js(self.timing()), self.id))
        self.emit("run.failed", error=message, timing=self.timing(),
                  phases={k: round(v) for k, v in self.phases.items()})

    # ---------- drivers ----------

    async def start(self) -> None:
        asyncio.create_task(self._drive())

    async def _drive(self) -> None:
        try:
            await (self._replay() if self.replay else self._spawn())
        except Exception as e:  # surfaced in the UI rather than hanging the page
            self.fail(f"{type(e).__name__}: {e}")
        finally:
            if self.sums:  # let late summaries reach live subscribers; they are stored either way
                await asyncio.wait(self.sums, timeout=5)
            for tid in list(self.pending):
                self.emit("tool.result", id=tid, parent=None, is_error=True, text="(no result — run ended)",
                          chars=0, lines=0, truncated=False, duration_ms=None,
                          name=(self.tool_meta.get(tid) or {}).get("name"))
                self.pending.pop(tid, None)
            if self.status in ("starting", "running"):
                self.fail("run ended without a result event")
            else:
                self.persist_timing()  # the exit leg only closes after the process is gone
            self.done.set()
            for qq in list(self.subs):
                qq.put_nowait(None)

    async def _spawn(self) -> None:
        if not Path(self.cwd).is_dir():
            return self.fail(f"{self.cwd} is not a directory")
        argv = build_argv(self.prompt, self.opts)
        self.emit("spawn", argv=argv, cwd=self.cwd)
        self.tick("queue")
        self.wait = "boot"
        env = {**os.environ}
        env.pop("ANTHROPIC_API_KEY", None)  # keep headless runs on the interactive login
        self.proc = await asyncio.create_subprocess_exec(
            *argv, cwd=self.cwd, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, env=env)
        err: list[str] = []

        async def drain():
            assert self.proc and self.proc.stderr
            async for line in self.proc.stderr:
                err.append(line.decode(errors="replace"))

        stderr_task = asyncio.create_task(drain())
        rec = None
        if self.opts.get("record"):  # tee the raw stream so this run becomes a replayable fixture
            name = re.sub(r"[^a-z0-9._-]+", "-", str(self.opts["record"]).lower()).strip("-")[:60]
            FIXTURES.mkdir(parents=True, exist_ok=True)
            rec = (FIXTURES / f"{name or 'run'}.jsonl").open("w")
        assert self.proc.stdout
        try:
            async for line in self.proc.stdout:
                s = line.decode(errors="replace").strip()
                if not s:
                    continue
                if rec:
                    rec.write(s + "\n")
                    rec.flush()
                try:
                    self.handle(json.loads(s))
                except json.JSONDecodeError:
                    self.emit("stderr", text=s)
        finally:
            if rec:
                rec.close()
        code = await self.proc.wait()
        await stderr_task
        self.tick("exit")
        if code != 0 and self.status in ("starting", "running"):
            self.fail((("".join(err)).strip() or f"claude exited {code}")[:2000])

    async def _replay(self) -> None:
        path = FIXTURES / self.replay
        if not path.exists():
            return self.fail(f"fixture {self.replay} not found")
        self.emit("spawn", argv=["replay", str(path.name)], cwd=self.cwd)
        speed = float(self.opts.get("replay_speed", 1.0))
        prev = None
        for line in path.read_text().splitlines():
            if not line.strip():
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if prev is not None and speed > 0:
                await asyncio.sleep(min(0.35, 0.08) / speed)
            prev = ev
            self.handle(ev)

    def cancel(self) -> None:
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()


def create(cwd: str, prompt: str, opts: dict, replay: str | None = None) -> Run:
    rid = uuid.uuid4().hex[:12]
    r = Run(rid, cwd, prompt, opts, replay)
    db.run("INSERT INTO runs(id,cwd,prompt,started_at,status,options,prev_session_id,replay) "
           "VALUES(?,?,?,?,?,?,?,?)",
           (rid, cwd, prompt, r.t0, "starting", db.js(opts), opts.get("resume"), 1 if replay else 0))
    db.touch_project(cwd, Path(cwd).name or cwd)
    db.run("UPDATE projects SET runs=runs+1 WHERE path=?", (cwd,))
    RUNS[rid] = r
    return r
