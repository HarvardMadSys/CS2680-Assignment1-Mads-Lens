#!/usr/bin/env python3
"""Explain a stream-json recording line by line, the way the frontend has to read it.

    python3 fixtures/inspect.py fixtures/03-subagents-parallel.jsonl

Beyond a plain type-per-line listing this also prints: the message.id group of every assistant
event (one API message is split into several events, one content block each), the
parent_tool_use_id bucket (None = main agent), tool_use -> tool_result pairing by id,
what the tool_result.content looks like (str vs list of blocks), and the run's numbers.
"""
import json, sys
from collections import defaultdict, OrderedDict


def short(x, n=70):
    s = x if isinstance(x, str) else json.dumps(x, ensure_ascii=False)
    s = s.replace("\n", "\\n")
    return s if len(s) <= n else s[: n - 1] + "…"


def tool_summary(name, inp):
    """One line per tool call. Each tool's input has a different shape."""
    if not isinstance(inp, dict):
        return short(inp)
    if name in ("Read", "Edit", "Write", "MultiEdit", "NotebookEdit"):
        return inp.get("file_path", "?")
    if name == "Bash":
        return short(inp.get("command", ""), 60)
    if name in ("Task", "Agent"):
        return f"[{inp.get('subagent_type', '?')}] {inp.get('description', '')}"
    if name in ("Grep", "Glob"):
        return f"{inp.get('pattern', '')}  in {inp.get('path', '.')}"
    if name in ("WebFetch", "WebSearch"):
        return inp.get("url") or inp.get("query", "")
    return short(inp, 60)


def main(path):
    events = [json.loads(l) for l in open(path) if l.strip()]
    pending = OrderedDict()          # tool_use id -> (name, line no)
    msg_ids = {}                     # message.id -> label like M1, M2 …
    by_parent = defaultdict(list)    # parent_tool_use_id -> line numbers
    types = defaultdict(int)

    print(f"{len(events)} events in {path}\n")
    for n, e in enumerate(events, 1):
        t, st = e.get("type"), e.get("subtype")
        types[f"{t}/{st}" if st else t] += 1
        parent = e.get("parent_tool_use_id")
        by_parent[parent].append(n)
        ptag = f"parent={parent[-6:]}" if parent else "main  "

        if t == "assistant":
            mid = e["message"]["id"]
            label = msg_ids.setdefault(mid, f"M{len(msg_ids)+1}")
            for b in e["message"]["content"]:
                if b["type"] == "tool_use":
                    pending[b["id"]] = (b["name"], n)
                    print(f"{n:3} {ptag} assistant {label:<4} tool_use  {b['name']:<8} {tool_summary(b['name'], b['input'])}   id={b['id'][-6:]}")
                elif b["type"] == "text":
                    print(f"{n:3} {ptag} assistant {label:<4} text      {short(b['text'])}")
                elif b["type"] == "thinking":
                    print(f"{n:3} {ptag} assistant {label:<4} thinking  ({len(b.get('thinking',''))} chars)")
                else:
                    print(f"{n:3} {ptag} assistant {label:<4} {b['type']}")
        elif t == "user":
            content = e["message"]["content"]
            if isinstance(content, str):
                print(f"{n:3} {ptag} user           text(str) {short(content)}")
                continue
            for b in content:
                if b.get("type") == "tool_result":
                    name, at = pending.pop(b["tool_use_id"], ("?", "?"))
                    c = b.get("content")
                    if isinstance(c, list):
                        shape = "list[" + ",".join(x.get("type", "?") for x in c) + "]"
                        preview = short(next((x.get("text") for x in c if x.get("type") == "text"), ""), 50)
                    else:
                        shape = "str"
                        preview = short(c or "", 50)
                    err = " IS_ERROR" if b.get("is_error") else ""
                    print(f"{n:3} {ptag} user           tool_result -> {name} (line {at}){err}  content={shape} {preview}")
                else:
                    print(f"{n:3} {ptag} user           {b.get('type')} {short(b.get('text',''))}")
        elif t == "stream_event":
            ev = e.get("event", {})
            d = ev.get("delta", {})
            extra = d.get("type", "") + (" " + short(d.get("partial_json", d.get("text", "")), 40) if d else "")
            print(f"{n:3} {ptag} stream_event   {ev.get('type'):<20} {extra}")
        elif t == "result":
            print(f"{n:3} {ptag} RESULT {st}  ${e.get('total_cost_usd', 0):.4f}  {e.get('duration_ms')} ms  {e.get('num_turns')} turns  is_error={e.get('is_error')}")
            if e.get("subagent_stats"):
                s = e["subagent_stats"]
                print(f"    subagent_stats: spawned={s.get('spawned')} completed={s.get('completed')} failed={s.get('failed')}")
            if e.get("permission_denials"):
                print(f"    permission_denials: {[d['tool_name'] for d in e['permission_denials']]}")
            print(f"    result text: {short(e.get('result') or '', 100)}")
        else:
            keys = [k for k in e if k not in ("type", "subtype", "uuid", "session_id")]
            print(f"{n:3} {ptag} {t}/{st}  keys={keys}")

    print("\n-- event type counts --")
    for k, v in sorted(types.items()):
        print(f"  {v:3}  {k}")
    print("\n-- parent_tool_use_id buckets (None = main agent) --")
    for p, lines in by_parent.items():
        print(f"  {p or 'None':<32} {len(lines):3} events  lines {lines[0]}..{lines[-1]}")
    if pending:
        print("\n-- tool_use without a tool_result --")
        for tid, (name, at) in pending.items():
            print(f"  {name} at line {at} id={tid}")
    print("\n-- assistant events per message.id (split content blocks) --")
    counts = defaultdict(int)
    for e in events:
        if e.get("type") == "assistant":
            counts[e["message"]["id"]] += 1
    multi = {m: c for m, c in counts.items() if c > 1}
    print(f"  {len(counts)} messages, {len(multi)} of them split across several events: {sorted(multi.values(), reverse=True)}")


if __name__ == "__main__":
    for p in sys.argv[1:] or ["fixtures/01-fix-test.jsonl"]:
        main(p)
        print("\n" + "=" * 100 + "\n")
