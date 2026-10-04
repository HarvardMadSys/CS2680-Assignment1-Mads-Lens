import asyncio
import json
import time
from collections import Counter
from pathlib import Path

import difflib
import os
import signal

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse

from . import capabilities, db, export, fsops, procs, runner, summarize as summ, transcripts
from .config import FIXTURES, SUMMARIZER_MODEL, SUMMARIZER_URL
from .summarize import summarize

app = FastAPI(title="trajectory")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/health")
def health():
    return {"ok": True, "fixtures": [p.name for p in sorted(FIXTURES.glob("*.jsonl"))],
            "summarizer": {"url": SUMMARIZER_URL, "model": SUMMARIZER_MODEL,
                           "reachable": summ.reachable(),
                           "cached": len(db.q("SELECT key FROM summaries"))}}


# ---------------------------------------------------------------- filesystem

@app.get("/api/fs/list")
def fs_list(path: str = "~"):
    try:
        return fsops.listing(path)
    except (NotADirectoryError, OSError) as e:
        raise HTTPException(400, str(e))


@app.get("/api/fs/tree")
def fs_tree(path: str, depth: int = 3):
    return fsops.tree(path, depth)


@app.get("/api/fs/file")
def fs_file(path: str):
    try:
        return fsops.read_file(path)
    except OSError as e:
        raise HTTPException(400, str(e))


@app.put("/api/fs/file")
async def fs_write(req: Request):
    b = await req.json()
    fsops.write_file(b["path"], b.get("text", ""))
    return {"ok": True}


@app.get("/api/projects")
def projects():
    rows = db.q("SELECT * FROM projects ORDER BY last_opened DESC LIMIT 40")
    for r in rows:
        r["exists"] = Path(r["path"]).is_dir()
    return rows


@app.post("/api/projects")
async def add_project(req: Request):
    b = await req.json()
    p = fsops.expand(b["path"])
    if not p.is_dir():
        raise HTTPException(400, f"{p} is not a directory")
    db.touch_project(str(p), p.name)
    return {"path": str(p)}


@app.delete("/api/projects")
def drop_project(path: str):
    db.run("DELETE FROM projects WHERE path=?", (path,))
    return {"ok": True}


# ---------------------------------------------------------------- capabilities

@app.get("/api/capabilities")
def caps(cwd: str):
    return capabilities.capabilities(str(fsops.expand(cwd)))


# ---------------------------------------------------------------- runs

@app.post("/api/runs")
async def start_run(req: Request):
    b = await req.json()
    cwd = str(fsops.expand(b.get("cwd") or "~"))
    prompt = (b.get("prompt") or "").strip()
    replay = b.get("replay")
    if not prompt and not replay:
        raise HTTPException(400, "prompt required")
    r = runner.create(cwd, prompt or f"(replay {replay})", b.get("options") or {}, replay)
    await r.start()
    return {"run_id": r.id}


@app.post("/api/runs/{run_id}/cancel")
def cancel(run_id: str):
    r = runner.RUNS.get(run_id)
    if r:
        r.cancel()
    return {"ok": bool(r)}


@app.get("/api/runs/{run_id}/stream")
async def stream(run_id: str, after: int = 0):
    r = runner.RUNS.get(run_id)
    if not r:
        rows = db.q("SELECT body FROM frames WHERE run_id=? AND seq>? ORDER BY seq", (run_id, after))
        if not rows:
            raise HTTPException(404, "unknown run")

        async def replay_db():
            for row in rows:
                yield f"data: {row['body']}\n\n"
            yield "event: end\ndata: {}\n\n"
        return StreamingResponse(replay_db(), media_type="text/event-stream")

    q = r.subscribe(after)

    async def gen():
        while True:
            try:
                f = await asyncio.wait_for(q.get(), timeout=15)
            except asyncio.TimeoutError:
                yield ": ping\n\n"
                continue
            if f is None:
                yield "event: end\ndata: {}\n\n"
                break
            yield f"data: {json.dumps(f, default=str)}\n\n"
        r.subs.discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    r = db.one("SELECT * FROM runs WHERE id=?", (run_id,))
    if not r:
        raise HTTPException(404, "unknown run")
    r["usage"] = db.unjs(r["usage"], {})
    r["phases"] = db.unjs(r["phases"], {})
    r["timing"] = db.unjs(r["timing"], {})
    r["options"] = db.unjs(r["options"], {})
    r["frames"] = [db.unjs(f["body"], {}) for f in
                   db.q("SELECT body FROM frames WHERE run_id=? ORDER BY seq", (run_id,))]
    r["live"] = run_id in runner.RUNS and not runner.RUNS[run_id].done.is_set()
    return r


@app.get("/api/runs")
def list_runs(session_id: str | None = None, cwd: str | None = None, limit: int = 50):
    if session_id:
        rows = db.q("SELECT * FROM runs WHERE session_id=? OR prev_session_id=? ORDER BY started_at",
                    (session_id, session_id))
    elif cwd:
        rows = db.q("SELECT * FROM runs WHERE cwd=? ORDER BY started_at DESC LIMIT ?",
                    (str(fsops.expand(cwd)), limit))
    else:
        rows = db.q("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?", (limit,))
    for r in rows:
        r["usage"] = db.unjs(r["usage"], {})
        r["phases"] = db.unjs(r["phases"], {})
        r["timing"] = db.unjs(r["timing"], {})
    return rows


@app.get("/api/runs/{run_id}/tool/{tool_use_id}")
def tool_full(run_id: str, tool_use_id: str):
    c = db.one("SELECT * FROM tool_calls WHERE run_id=? AND tool_use_id=?", (run_id, tool_use_id))
    if not c:
        raise HTTPException(404, "unknown tool call")
    c["input"] = db.unjs(c["input"], {})
    return c


@app.get("/api/runs/{run_id}/export")
def export_run(run_id: str, format: str = "md"):
    if format == "md":
        return PlainTextResponse(export.markdown(run_id), media_type="text/markdown")
    if format == "jsonl":
        return PlainTextResponse(export.jsonl(run_id), media_type="application/x-ndjson")
    return get_run(run_id)


# ---------------------------------------------------------------- metrics

@app.get("/api/metrics")
def metrics(cwd: str | None = None, session_id: str | None = None):
    where, args = "1=1", []
    if cwd:
        where, args = "cwd=?", [str(fsops.expand(cwd))]
    if session_id:
        where, args = "session_id=?", [session_id]
    runs = db.q(f"SELECT * FROM runs WHERE {where} ORDER BY started_at DESC LIMIT 200", tuple(args))
    ids = [r["id"] for r in runs] or ["-"]
    marks = ",".join("?" * len(ids))
    calls = db.q(f"SELECT name, parent, is_error, started_at, ended_at FROM tool_calls WHERE run_id IN ({marks})", tuple(ids))
    tokens = Counter()
    for r in runs:
        for k, v in (db.unjs(r["usage"], {}) or {}).items():
            if isinstance(v, int):
                tokens[k] += v
    hist = Counter(c["name"] for c in calls)
    phases = Counter()
    for r in runs:
        for k, v in (db.unjs(r["phases"], {}) or {}).items():
            phases[k] += v
    durs = [((c["ended_at"] or 0) - (c["started_at"] or 0)) * 1000 for c in calls if c["ended_at"]]
    by_tool: dict[str, dict] = {}
    for c in calls:
        d = by_tool.setdefault(c["name"], {"name": c["name"], "n": 0, "ms": 0.0, "errors": 0})
        d["n"] += 1
        d["errors"] += 1 if c["is_error"] else 0
        if c["ended_at"]:
            d["ms"] += ((c["ended_at"] or 0) - (c["started_at"] or 0)) * 1000
    for d in by_tool.values():
        d["ms"] = round(d["ms"])
        d["avg_ms"] = round(d["ms"] / d["n"]) if d["n"] else 0
    emit = sum((db.unjs(r["timing"], {}) or {}).get("emit_ms") or 0 for r in runs)
    ttft = [t for t in ((db.unjs(r["timing"], {}) or {}).get("ttft_ms") for r in runs) if t]
    return {
        "runs": len(runs),
        "cost_usd": sum(r["cost_usd"] or 0 for r in runs),
        "duration_ms": sum(r["duration_ms"] or 0 for r in runs),
        "turns": sum(r["num_turns"] or 0 for r in runs),
        "tokens": dict(tokens),
        "tool_histogram": [{"name": n, "count": c} for n, c in hist.most_common()],
        "tool_errors": sum(1 for c in calls if c["is_error"]),
        "tool_calls": len(calls),
        "subagent_calls": sum(1 for c in calls if c["name"] in ("Task", "Agent")),
        "subagent_events": sum(1 for c in calls if c["parent"]),
        "tool_ms_avg": round(sum(durs) / len(durs)) if durs else 0,
        "tool_ms_p90": round(sorted(durs)[int(len(durs) * 0.9)]) if durs else 0,
        "by_tool": sorted(by_tool.values(), key=lambda d: -d["n"]),
        "emit_ms": round(emit, 2),
        "ttft_ms": round(sum(ttft) / len(ttft)) if ttft else 0,
        "api_ms": sum(r["api_duration_ms"] or 0 for r in runs),
        "phases": {k: round(v) for k, v in phases.items()},
    }


@app.get("/api/edits")
def edits(cwd: str, limit: int = 25, summarise: bool = True):
    c = str(fsops.expand(cwd))
    rows = db.q("SELECT * FROM edits WHERE cwd=? ORDER BY ts DESC LIMIT ?", (c, limit))
    for e in rows:
        if summarise and not e["summary"]:
            try:
                snippet = Path(e["path"]).read_text(errors="replace")[:1500]
            except OSError:
                snippet = ""
            e["summary"] = summarize(e, snippet)
            db.run("UPDATE edits SET summary=? WHERE id=?", (e["summary"], e["id"]))
    heat = db.q("SELECT path, COUNT(*) n, SUM(bytes) b, MAX(ts) last FROM edits WHERE cwd=? "
                "GROUP BY path ORDER BY n DESC", (c,))
    return {"recent": rows, "heatmap": heat}


# ---------------------------------------------------------------- authoring

@app.get("/api/doc")
def get_doc(path: str):
    p = fsops.expand(path)
    return {"path": str(p), "text": p.read_text(errors="replace") if p.exists() else "", "exists": p.exists()}


@app.put("/api/doc")
async def put_doc(req: Request):
    b = await req.json()
    fsops.write_file(b["path"], b.get("text", ""))
    return {"ok": True}


@app.get("/api/specs")
def specs(cwd: str):
    d = fsops.expand(cwd) / ".claude" / "specs"
    return [{"name": p.stem, "path": str(p), "mtime": p.stat().st_mtime}
            for p in sorted(d.glob("*.md"))] if d.is_dir() else []


# ---------------------------------------------------------------- files & versions

@app.get("/api/files")
def files(cwd: str, depth: int = 4):
    c = str(fsops.expand(cwd))
    stats = {r["path"]: r for r in db.q(
        "SELECT path, COUNT(*) n, SUM(bytes) b, MAX(ts) last FROM edits WHERE cwd=? GROUP BY path", (c,))}
    vers = {r["path"]: r["n"] for r in db.q(
        "SELECT path, COUNT(*) n FROM versions WHERE cwd=? GROUP BY path", (c,))}

    def decorate(node: dict) -> int:
        """Attach edit counts, and roll them up so a folded directory still shows heat."""
        if node.get("dir"):
            total = sum(decorate(k) for k in node.get("children") or [])
            node["edits"] = total
            return total
        st = stats.get(node["path"])
        node["edits"] = st["n"] if st else 0
        node["last"] = st["last"] if st else None
        node["versions"] = vers.get(node["path"], 0)
        return node["edits"]

    tree = fsops.tree(c, depth)
    decorate(tree)
    return {"tree": tree, "max_edits": max([s["n"] for s in stats.values()] or [0]),
            "touched": sorted(stats.values(), key=lambda r: -r["n"])}


@app.get("/api/versions")
def versions(path: str):
    p = str(fsops.expand(path))
    rows = db.q("SELECT id, run_id, tool_use_id, kind, tool, ts, chars FROM versions "
                "WHERE path=? ORDER BY ts DESC, id DESC", (p,))
    for r in rows:
        run = db.one("SELECT prompt FROM runs WHERE id=?", (r["run_id"],))
        r["prompt"] = (run or {}).get("prompt", "")
    return {"path": p, "versions": rows}


@app.get("/api/versions/{vid}")
def version(vid: int):
    v = db.one("SELECT * FROM versions WHERE id=?", (vid,))
    if not v:
        raise HTTPException(404, "unknown version")
    return v


@app.get("/api/versions/{vid}/diff")
def version_diff(vid: int, against: int | None = None):
    """Diff a snapshot against another, or against the file as it stands now."""
    v = db.one("SELECT * FROM versions WHERE id=?", (vid,))
    if not v:
        raise HTTPException(404, "unknown version")
    if against:
        other = db.one("SELECT * FROM versions WHERE id=?", (against,))
        b_text, b_name = (other or {}).get("text", ""), f"v{against}"
    else:
        prev = db.one("SELECT * FROM versions WHERE path=? AND id<? ORDER BY id DESC LIMIT 1",
                      (v["path"], vid))
        b_text, b_name = (prev or {}).get("text", ""), f"v{(prev or {}).get('id', 'empty')}"
    a_lines, b_lines = b_text.splitlines(), (v["text"] or "").splitlines()
    diff = list(difflib.unified_diff(a_lines, b_lines, b_name, f"v{vid}", lineterm="", n=3))
    changed, ln = [], 0
    for line in diff:  # track line numbers on the new side so the viewer can mark them
        if line.startswith("@@"):
            try:
                ln = int(line.split("+")[1].split(",")[0].split(" ")[0]) - 1
            except (IndexError, ValueError):
                ln = 0
        elif line.startswith("+") and not line.startswith("+++"):
            ln += 1
            changed.append(ln)
        elif not line.startswith("-") and not line.startswith("---"):
            ln += 1
    return {"diff": "\n".join(diff), "changed": changed, "lines": len(b_lines),
            "added": len(changed),
            "removed": sum(1 for l in diff if l.startswith("-") and not l.startswith("---"))}


# ---------------------------------------------------------------- sessions

@app.get("/api/sessions")
def sessions(cwd: str | None = None, limit: int = 200, imported: bool = True):
    """Runs chained by `--resume` are one conversation; the gallery browses those, not runs."""
    where, args = "1=1", []
    if cwd:
        where, args = "cwd=?", [str(fsops.expand(cwd))]
    rows = db.q(f"SELECT * FROM runs WHERE {where} AND session_id IS NOT NULL "
                f"ORDER BY started_at", tuple(args))
    ids = [r["id"] for r in rows] or ["-"]
    marks = ",".join("?" * len(ids))
    calls = db.q(f"SELECT run_id, name, is_error, parent FROM tool_calls WHERE run_id IN ({marks}) "
                 f"ORDER BY started_at", tuple(ids))
    by_run: dict[str, list[dict]] = {}
    for c in calls:
        by_run.setdefault(c["run_id"], []).append(c)

    out: dict[str, dict] = {}
    for r in rows:
        s = out.setdefault(r["session_id"], {
            "session_id": r["session_id"], "cwd": r["cwd"], "title": r["prompt"],
            "started_at": r["started_at"], "last_at": r["started_at"], "runs": 0,
            "cost_usd": 0.0, "duration_ms": 0, "turns": 0, "status": r["status"],
            "replay": bool(r["replay"]), "errors": 0, "steps": [], "prompts": [],
        })
        s["runs"] += 1
        s["cost_usd"] += r["cost_usd"] or 0
        s["duration_ms"] += r["duration_ms"] or 0
        s["turns"] += r["num_turns"] or 0
        s["last_at"] = max(s["last_at"], r["started_at"])
        s["status"] = r["status"]           # the latest run decides how the session reads
        s["replay"] = s["replay"] or bool(r["replay"])
        s["prompts"].append(r["prompt"])
        for c in by_run.get(r["id"], []):
            s["errors"] += 1 if c["is_error"] else 0
            if len(s["steps"]) < 60:
                s["steps"].append({"name": c["name"], "err": bool(c["is_error"]),
                                   "sub": bool(c["parent"])})
    if imported:  # Claude Code's own store: sessions this app never ran, still resumable
        for t in transcripts.index():
            if t["session_id"] not in out and (not cwd or t["cwd"] == str(fsops.expand(cwd))):
                out[t["session_id"]] = t
    return sorted(out.values(), key=lambda s: -s["last_at"])[:limit]


@app.get("/api/sessions/{session_id}")
def session(session_id: str):
    """Every run of one conversation, with frames, ready to rehydrate the console."""
    rows = db.q("SELECT * FROM runs WHERE session_id=? OR prev_session_id=? ORDER BY started_at",
                (session_id, session_id))
    if not rows:
        imported = transcripts.load(session_id)
        if imported:
            return imported
        raise HTTPException(404, "unknown session")
    for r in rows:
        r["usage"] = db.unjs(r["usage"], {})
        r["phases"] = db.unjs(r["phases"], {})
        r["timing"] = db.unjs(r["timing"], {})
        r["options"] = db.unjs(r["options"], {})
        r["frames"] = [db.unjs(f["body"], {}) for f in
                       db.q("SELECT body FROM frames WHERE run_id=? ORDER BY seq", (r["id"],))]
        r["live"] = r["id"] in runner.RUNS and not runner.RUNS[r["id"]].done.is_set()
    return {"session_id": session_id, "cwd": rows[-1]["cwd"], "runs": rows}


# ---------------------------------------------------------------- processes

@app.get("/api/processes")
def processes():
    """Background work the agent left running: its own process, and everything under it."""
    roots = {r.proc.pid: rid for rid, r in runner.RUNS.items()
             if r.proc and r.proc.returncode is None}
    return procs.report(roots)


@app.post("/api/processes/{pid}/kill")
def kill(pid: int):
    """Only processes we know we started — never an arbitrary pid."""
    if pid not in procs.TRACKED and pid not in {r.proc.pid for r in runner.RUNS.values() if r.proc}:
        raise HTTPException(400, "not a process this app started")
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError as e:
        raise HTTPException(400, str(e))
    procs.TRACKED.pop(pid, None)
    db.run("DELETE FROM bg_procs WHERE pid=?", (pid,))
    return {"ok": True}


@app.post("/api/transcripts/reindex")
def reindex():
    ix = transcripts.index(force=True)
    return {"count": len(ix), "store": str(transcripts.STORE)}
