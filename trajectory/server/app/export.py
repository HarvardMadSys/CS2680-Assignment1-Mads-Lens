import json

from . import db


def _tree(frames: list[dict]) -> tuple[dict, dict]:
    by_parent: dict[str, list[dict]] = {}
    results: dict[str, dict] = {}
    for f in frames:
        by_parent.setdefault(f.get("parent") or "", []).append(f)
        if f.get("kind") == "tool.result":
            results[f["id"]] = f
    return by_parent, results


def markdown(run_id: str) -> str:
    r = db.one("SELECT * FROM runs WHERE id=?", (run_id,))
    if not r:
        return f"# run {run_id} not found\n"
    frames = [db.unjs(f["body"], {}) for f in
              db.q("SELECT body FROM frames WHERE run_id=? ORDER BY seq", (run_id,))]
    calls = {c["tool_use_id"]: c for c in db.q("SELECT * FROM tool_calls WHERE run_id=?", (run_id,))}
    by_parent, results = _tree(frames)
    L: list[str] = []

    def walk(key: str, depth: int) -> None:
        nonlocal L
        pad = "  " * depth
        for f in by_parent.get(key, []):
            k = f.get("kind")
            if k == "text":
                L += [pad + ln for ln in f["text"].splitlines()] + [""]
            elif k == "thinking":
                L += [f"{pad}> _thinking_ · {f['text'][:400].strip()}", ""]
            elif k == "tool.call":
                arg = json.dumps(f.get("input", {}), indent=1)
                res = results.get(f["id"])
                mark = "…" if not res else "✕" if res.get("is_error") else "✓"
                L += [f"{pad}- **{f['name']}** {mark}", "",
                      f"{pad}  ```json", *[pad + "  " + ln for ln in arg.splitlines()], f"{pad}  ```", ""]
                if res:
                    body = (calls.get(f["id"], {}).get("result") or res.get("text") or "").rstrip()
                    if body:
                        L += [f"{pad}  <details><summary>result · {res.get('chars', 0)} chars</summary>", "",
                              f"{pad}  ```", *[pad + "  " + ln for ln in body.splitlines()[:400]],
                              f"{pad}  ```", "", f"{pad}  </details>", ""]
                if by_parent.get(f["id"]):
                    L += [f"{pad}  <!-- subagent -->", ""]
                    walk(f["id"], depth + 1)

    usage = db.unjs(r["usage"], {}) or {}
    L += [f"# {r['prompt'].splitlines()[0][:100]}", "",
          f"`{r['cwd']}` · session `{r['session_id']}` · **{r['status']}**", "",
          f"${r['cost_usd'] or 0:.4f} · {(r['duration_ms'] or 0) / 1000:.1f}s · {r['num_turns'] or 0} turns · "
          f"{usage.get('output_tokens', 0)} output tokens", "",
          "## Prompt", "", "```", r["prompt"], "```", "", "## Trajectory", ""]
    walk("", 0)
    if r["result"]:
        L += ["## Result", "", r["result"], ""]
    if r["error"]:
        L += ["## Error", "", "```", r["error"], "```", ""]
    return "\n".join(L)


def jsonl(run_id: str) -> str:
    return "\n".join(f["body"] for f in
                     db.q("SELECT body FROM frames WHERE run_id=? ORDER BY seq", (run_id,)))
