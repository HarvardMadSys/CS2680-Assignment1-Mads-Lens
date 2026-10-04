import subprocess
import time

from . import db

# Everything the agent starts is a descendant of the `claude` process we spawned. Subagents are
# not separate processes — they run inside it — so what shows up here are background shells,
# servers and test runners the agent left running.
PS = ["ps", "-Ao", "pid=,ppid=,pcpu=,rss=,etime=,args="]
SELF_NOISE = ("ps -Ao",)

# pid -> what we know about it, so a server outlives the run that started it — and the app restart
TRACKED: dict[int, dict] = {
    r["pid"]: {"run_id": r["run_id"], "cmd": r["cmd"], "first_seen": r["first_seen"]}
    for r in db.q("SELECT * FROM bg_procs")
}


def _etime(s: str) -> float:
    """ps elapsed time: [[dd-]hh:]mm:ss"""
    days = 0
    if "-" in s:
        d, s = s.split("-", 1)
        days = int(d)
    parts = [int(p) for p in s.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]


def short(cmd: str) -> str:
    """A readable label: Claude Code wraps every Bash call in a shell-snapshot preamble."""
    if "shell-snapshot" in cmd and " eval '" in cmd:
        cmd = cmd.rsplit(" eval '", 1)[1].rstrip("'")
    head, _, rest = cmd.partition(" ")
    return (head.rsplit("/", 1)[-1] + (" " + rest if rest else "")).strip()


def snapshot() -> dict[int, dict]:
    try:
        out = subprocess.run(PS, capture_output=True, text=True, timeout=4).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    procs: dict[int, dict] = {}
    now = time.time()
    for line in out.splitlines():
        parts = line.split(None, 5)
        if len(parts) < 6:
            continue
        pid, ppid, cpu, rss, etime, args = parts
        try:
            elapsed = _etime(etime)
            procs[int(pid)] = {
                "pid": int(pid), "ppid": int(ppid), "cpu": float(cpu),
                "rss_kb": int(rss), "elapsed_s": elapsed, "started_at": now - elapsed,
                "cmd": short(args), "cmd_full": args,
            }
        except ValueError:
            continue
    return procs


def descendants(procs: dict[int, dict], root: int) -> list[dict]:
    kids: dict[int, list[int]] = {}
    for p in procs.values():
        kids.setdefault(p["ppid"], []).append(p["pid"])
    out, stack = [], list(kids.get(root, []))
    while stack:
        pid = stack.pop()
        p = procs.get(pid)
        if not p or any(n in p["cmd"] for n in SELF_NOISE):
            continue
        out.append(p)
        stack.extend(kids.get(pid, []))
    return sorted(out, key=lambda p: p["started_at"])


def sweep(roots: dict[int, str]) -> None:
    """Record the descendants of every live run so they can be followed after it ends."""
    procs = snapshot()
    for pid, run_id in roots.items():
        if pid not in procs:
            continue
        for p in descendants(procs, pid):
            if p["pid"] in TRACKED:
                continue
            TRACKED[p["pid"]] = {"run_id": run_id, "cmd": p["cmd"], "first_seen": p["started_at"]}
            db.run("INSERT OR REPLACE INTO bg_procs(pid,run_id,cmd,first_seen) VALUES(?,?,?,?)",
                   (p["pid"], run_id, p["cmd"], p["started_at"]))


def report(roots: dict[int, str]) -> dict:
    procs = snapshot()
    sweep(roots)
    agents = []
    for pid, run_id in roots.items():
        p = procs.get(pid)
        agents.append({
            "run_id": run_id, "pid": pid, "alive": p is not None,
            **({k: p[k] for k in ("cpu", "rss_kb", "elapsed_s", "started_at", "cmd")} if p else {}),
            "children": [dict(c, run_id=run_id) for c in descendants(procs, pid)] if p else [],
        })

    # anything we saw earlier that is still alive, including processes whose parent run has gone
    orphans = []
    for pid, meta in list(TRACKED.items()):
        p = procs.get(pid)
        if not p or abs(p["started_at"] - meta["first_seen"]) > 5:  # gone, or the pid was reused
            TRACKED.pop(pid, None)
            db.run("DELETE FROM bg_procs WHERE pid=?", (pid,))
            continue
        if any(pid == c["pid"] for a in agents for c in a["children"]):
            continue
        orphans.append(dict(p, run_id=meta["run_id"], orphaned=True))

    live = sum(1 for a in agents if a["alive"]) + sum(len(a["children"]) for a in agents) + len(orphans)
    return {"agents": agents, "orphans": sorted(orphans, key=lambda p: p["started_at"]), "count": live}
