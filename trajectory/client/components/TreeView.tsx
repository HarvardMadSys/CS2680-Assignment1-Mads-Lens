"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { ms, num, short, usd } from "@/lib/format";
import { flatten, tree, type TNode } from "@/lib/layout";
import type { ToolNode, Turn } from "@/lib/types";
import { LatencyBar, LatencyDetail, slices } from "./Latency";
import Markdown from "./Markdown";
import Progress from "./Progress";
import { ResultBody, ToolInput } from "./Value";

const MIN_COL = 340;  // narrow enough that several branches still fit before scrolling
const MAX_COL = 900;  // wide enough to fill a normal window, short of an unreadable line
const ROW = 28;    // a row's minimum height — a row holding prose is as tall as the prose
const IND = 22;    // how far a tool row sits off the trunk it hangs from
const PAD = 26;
const DOT = 12;    // the dot's centre, from the top of a node — where its edges meet it
const HEAD_LINES = 14;
const gap = (n: TNode) => (n.kind === "tool" ? 6 : 18);   // prose needs air below it, a call does not

export default function TreeView({ turns }: { turns: Turn[] }) {
  const [sel, setSel] = useState<string | null>(null);
  const { roots } = useMemo(() => tree(turns), [turns]);
  // switching to another trace must not leave the previous one's card open
  const key = turns.map((t) => t.runId).join(",");
  useEffect(() => setSel(null), [key]);
  const nodes = useMemo(() => flatten(roots), [roots]);
  const picked = nodes.find((n) => n.id === sel) ?? null;

  // Columns share whatever the pane gives us, so a run with no branches reads full width instead
  // of hugging the left edge. Past MAX_COL the line is too long to read, so it stops growing.
  const box = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  useLayoutEffect(() => {
    const el = box.current?.parentElement;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      setAvail(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Turns are stacked, never side by side, so each divides the pane by its own column count:
  // a turn that never delegated reads full width even when a later one fans out.
  // Floored, or a fractional width jitters the layout as scrollbars come and go.
  const colw = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of roots) {
      const n = (r.cols ?? 0) + 1;
      m.set(r.turn.runId, Math.floor(Math.min(MAX_COL, Math.max(MIN_COL, (avail - PAD * 2) / n))));
    }
    return m;
  }, [roots, avail]);
  const cw = (n: TNode) => colw.get(n.turn.runId) ?? MIN_COL;

  // A node showing the model's own words is as tall as those words, so heights come from the DOM.
  const els = useRef(new Map<string, HTMLElement>());
  const [hs, setHs] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const m: Record<string, number> = {};
    let same = Object.keys(hs).length === nodes.length;
    for (const n of nodes) {
      m[n.id] = els.current.get(n.id)?.offsetHeight ?? ROW - gap(n);
      same = same && hs[n.id] === m[n.id];
    }
    if (!same) setHs(m);
  });

  /**
   * Every column descends on its own clock: a branch starts just below the call that spawned it,
   * and a long report inside it pushes nothing but itself. Only a turn waits for the one before.
   */
  const { tops, bottom } = useMemo(() => {
    const tops: Record<string, number> = {};
    const cur: number[] = [];
    let floor = PAD;
    const walk = (n: TNode, from: number) => {
      const y = Math.max(cur[n.x] ?? 0, from);
      tops[n.id] = y;
      const next = y + Math.max(ROW, (hs[n.id] ?? ROW - gap(n)) + gap(n));
      cur[n.x] = next;
      n.children.forEach((c) => walk(c, next));
    };
    for (const r of roots) {
      walk(r, floor);
      floor = Math.max(...cur, floor) + ROW;   // a turn clears everything the last one drew
    }
    return { tops, bottom: Math.max(...cur, PAD) };
  }, [roots, hs]);

  const w = Math.max(...roots.map((r) => ((r.cols ?? 0) + 1) * cw(r)), 0) + PAD * 2;
  const h = bottom + PAD;
  const tx = (n: TNode) => PAD + n.x * cw(n);                       // the trunk line of n's column
  const px = (n: TNode) => tx(n) + (n.kind === "tool" ? IND : 0);
  const py = (n: TNode) => tops[n.id] ?? PAD;
  // --col is per node, not per canvas: it is the width of the column this node's turn uses
  const at = (n: TNode) => ({
    left: px(n), top: py(n), transform: `translate(-7px, -${DOT}px)`,
    ["--col" as any]: `${cw(n)}px`,
  });
  const hold = (n: TNode) => (el: HTMLElement | null) => {
    el ? els.current.set(n.id, el) : els.current.delete(n.id);
  };

  return (
    <div className="tv" ref={box} style={{ minWidth: w, height: h }}>
      <svg className="tv-e" width={w} height={h}>
        {nodes.flatMap((n) => [
          ...n.children.map((c) => {
            // a branch leaves the trunk at the call that spawned it and sweeps into its column;
            // it has to leave from the trunk line, not the call's dot, or it crosses the call's text
            const [x1, y1, x2, y2] = [tx(n), py(n), tx(c), py(c)];
            const d = c.sub
              ? `M ${x1} ${y1} C ${x1} ${y1 + 22} ${x2} ${y2 - 22} ${x2} ${y2}`
              : `M ${x1} ${y1} L ${x2} ${y2}`;
            return <path key={`${n.id}-${c.id}`} d={d} className="tv-l" data-b={c.sub ? "1" : "0"} />;
          }),
          // a call is indented off the trunk; the tick back to it is what reads as belonging
          ...(n.kind === "tool"
            ? [<path key={`${n.id}~`} className="tv-l" d={`M ${tx(n)} ${py(n)} H ${px(n)}`} />]
            : []),
        ])}
      </svg>

      {nodes.map((n) =>
        n.kind === "text" ? (
          <div key={n.id} className="tv-say" data-think={n.think ? "1" : "0"} ref={hold(n)} style={at(n)}>
            <span className="tv-d" />
            {n.think ? <div className="think">{n.label}</div> : <Markdown text={n.label} />}
          </div>
        ) : (
          <button key={n.id} className="tv-n" data-kind={n.kind} data-status={n.status}
            ref={hold(n)} style={at(n)} data-on={sel === n.id ? "1" : "0"}
            onClick={() => setSel(sel === n.id ? null : n.id)} title={n.label}>
            {/* an anchor so the outline can jump to this call */}
            {n.tool && <span id={`t-${n.tool.id}`} className="tv-a" />}
            <span className="tv-d" />
            {n.tool && <span className="tv-k">{n.tool.name}</span>}
            <span className="tv-t">{n.kind === "summary" ? summaryLine(n.turn) : n.label}</span>
            {/* the same slot counts up while the call is out and settles into its duration */}
            {n.tool && (n.tool.result
              ? n.tool.result.duration_ms != null && <span className="tv-m">{ms(n.tool.result.duration_ms)}</span>
              : <Progress since={n.tool.call.ts} eta={n.tool.eta} />)}
            {n.subs > 0 && <span className="tv-s">{n.subs}</span>}
          </button>
        )
      )}

      {picked && (
        <div className="tv-card" style={{ left: px(picked) + 18, top: py(picked) + 20 }}
          onClick={(e) => e.stopPropagation()}>
          <div className="tv-card-h">
            <span className="grow ell">{picked.tool?.name ?? (picked.kind === "prompt" ? "prompt" : picked.label)}</span>
            <button className="link" onClick={() => setSel(null)}>close</button>
          </div>
          {picked.kind === "prompt" ? <div className="tv-prompt">{picked.turn.prompt}</div>
            : picked.kind === "summary" ? <RunDetail turn={picked.turn} />
            : <ToolDetail tool={picked.tool!} runId={picked.turn.runId} />}
        </div>
      )}
    </div>
  );
}

const summaryLine = (t: Turn) => {
  const s = t.summary;
  if (!s || t.status === "running" || t.status === "starting") return t.status;
  // a run that failed owes you the reason on the node, not one click away
  if (t.status === "failed") return `failed · ${s.error ?? s.subtype ?? "no result event"}`;
  return `${t.status} · ${usd(s.cost_usd)} · ${ms(s.duration_ms)} · ${s.num_turns ?? "—"} turns`;
};

function ToolDetail({ tool, runId }: { tool: ToolNode; runId: string }) {
  return (
    <div className="tn-card">
      <ToolInput name={tool.name} input={tool.input} />
      {tool.result && <Result frame={tool.result} runId={runId} toolId={tool.id} />}
    </div>
  );
}

function Result({ frame, runId, toolId }: { frame: any; runId: string; toolId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const text: string = full ?? frame.text ?? "";
  if (!text.trim()) return <div className="tl-h">result · empty</div>;
  const lines = text.split("\n");
  const clipped = !expanded && lines.length > HEAD_LINES;
  const hidden = (frame.truncated && !full ? frame.lines : lines.length) - HEAD_LINES;
  const toggle = async () => {
    if (!expanded && frame.truncated && full === null) {
      try { setFull((await api.tool(runId, toolId)).result ?? text); } catch {}
    }
    setExpanded((v) => !v);
  };
  return (
    <>
      <div className="tl-h">{frame.is_error ? "error" : "result"} · {frame.chars} chars</div>
      <div className="v-res" data-err={frame.is_error ? "1" : "0"}>
        <ResultBody text={clipped ? lines.slice(0, HEAD_LINES).join("\n") : text} />
      </div>
      {(clipped || expanded) && (
        <button className="tl-more" onClick={toggle}>{expanded ? "fold" : `${hidden} more lines`}</button>
      )}
    </>
  );
}

function RunDetail({ turn }: { turn: Turn }) {
  const s = turn.summary;
  const u = s?.usage ?? {};
  const tin = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return (
    <>
      {turn.status === "failed" && (s?.error || s?.subtype) && (
        <div className="errbox">{s?.error ?? `run ended: ${s?.subtype}`}</div>
      )}
      <div className="foot">
        <span>{usd(s?.cost_usd)}</span><span className="sep">·</span>
        <span>{ms(s?.duration_ms)}</span><span className="sep">·</span>
        <span>{s?.num_turns ?? "—"} turns</span><span className="sep">·</span>
        <span>{num(tin)} in / {num(u.output_tokens)} out</span><span className="sep">·</span>
        <span className="mono">{short(s?.session_id, 8)}…</span>
        <a className="link" href={api.exportUrl(turn.runId, "md")} target="_blank" rel="noreferrer">md</a>
        <a className="link" href={api.exportUrl(turn.runId, "jsonl")} target="_blank" rel="noreferrer">jsonl</a>
      </div>
      <LatencyBar data={slices(s)} />
      <LatencyDetail summary={s} replay={!!turn.replay} />
    </>
  );
}
