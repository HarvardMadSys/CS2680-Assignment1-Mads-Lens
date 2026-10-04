"use client";
import { ms } from "@/lib/format";
import type { RunSummary } from "@/lib/types";

export type Slice = { key: string; label: string; ms: number; color: string; note: string };

const C = {
  queue: "#26262b", boot: "#3a3a42", api: "#a78bfa", agent: "#6b55b0",
  tools: "#55555e", stream: "#83838d", exit: "#2f2f36",
};

/**
 * Split a run's wall clock into the stages it passed through. `phases` are measured here (gaps
 * between events, bucketed by what the run was waiting on); `api_duration_ms` is Claude Code's own
 * number and carves model time out of the think phase.
 */
export function slices(s?: RunSummary): Slice[] {
  const p = s?.phases ?? {};
  const t = s?.timing ?? {};
  const think = p.think ?? p.model ?? 0;
  const stream = Math.min(t.emit_ms ?? 0, think);
  const api = Math.min(s?.api_duration_ms ?? think, think - stream);
  return [
    { key: "queue", label: "queue", ms: p.queue ?? 0, color: C.queue, note: "request accepted → process spawned" },
    { key: "boot", label: "boot", ms: p.boot ?? p.startup ?? 0, color: C.boot, note: "CLI startup → first event" },
    { key: "api", label: "api", ms: Math.max(0, api), color: C.api, note: "model inference, as reported by Claude Code" },
    { key: "agent", label: "agent", ms: Math.max(0, think - api - stream), color: C.agent, note: "prompt assembly, parsing, orchestration" },
    { key: "tools", label: "tools", ms: p.tools ?? p.tool ?? 0, color: C.tools, note: "local tool execution" },
    { key: "stream", label: "stream", ms: stream, color: C.stream, note: "frame serialise + fan-out to this page" },
    { key: "exit", label: "exit", ms: p.exit ?? 0, color: C.exit, note: "final event → process exit" },
  ].filter((x) => x.ms > 0.05);
}

export function LatencyBar({ data, height = 5 }: { data: Slice[]; height?: number }) {
  const total = data.reduce((s, d) => s + d.ms, 0) || 1;
  return (
    <div className="bar" style={{ height }}>
      {data.map((d) => (
        <i key={d.key} style={{ width: `${(d.ms / total) * 100}%`, background: d.color }} title={`${d.label} · ${ms(d.ms)}`} />
      ))}
    </div>
  );
}

export function LatencyLegend({ data }: { data: Slice[] }) {
  const total = data.reduce((s, d) => s + d.ms, 0) || 1;
  return (
    <div className="legend">
      {data.map((d) => (
        <span key={d.key} title={d.note}><i style={{ background: d.color }} />{d.label} {Math.round((d.ms / total) * 100)}%</span>
      ))}
    </div>
  );
}

export function LatencyPie({ data, size = 128 }: { data: Slice[]; size?: number }) {
  const total = data.reduce((s, d) => s + d.ms, 0) || 1;
  const r = size / 2 - 10, c = 2 * Math.PI * r;
  let off = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flex: "none" }}>
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        {data.map((d) => {
          const len = (d.ms / total) * c;
          const el = (
            <circle key={d.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={d.color}
              strokeWidth={12} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-off}>
              <title>{`${d.label} · ${ms(d.ms)} · ${d.note}`}</title>
            </circle>
          );
          off += len;
          return el;
        })}
      </g>
      <text x="50%" y="50%" textAnchor="middle" dy="5" fill="var(--fg)" fontSize="13" fontFamily="var(--serif), Georgia, serif">
        {ms(total)}
      </text>
    </svg>
  );
}

/** Every number the run gives us about where its time went. */
export function LatencyDetail({ summary, replay }: { summary?: RunSummary; replay?: boolean }) {
  const data = slices(summary);
  const total = data.reduce((s, d) => s + d.ms, 0) || 1;
  const t = summary?.timing ?? {};
  const byTool = Object.entries(t.by_tool ?? {}) as [string, { ms: number; n: number }][];
  const toolMax = Math.max(1, ...byTool.map(([, v]) => v.ms));

  return (
    <div className="lat">
      <div className="row" style={{ gap: 20, alignItems: "flex-start" }}>
        <LatencyPie data={data} />
        <div className="grow">
          {data.map((d) => (
            <div className="kv" key={d.key} title={d.note}>
              <span><i className="swatch" style={{ background: d.color }} />{d.label}</span>
              <span>{ms(d.ms)} <span className="sep">{Math.round((d.ms / total) * 100)}%</span></span>
            </div>
          ))}
        </div>
      </div>

      <div className="kv" style={{ marginTop: 10 }}><span>time to first token</span><span>{ms(t.ttft_ms)}</span></div>
      <div className="kv" title="Claude Code's own API total; parallel subagents can make it exceed the wall clock">
        <span>api reported</span><span>{ms(summary?.api_duration_ms)} of {ms(summary?.duration_ms)}</span>
      </div>
      <div className="kv"><span>turns</span><span>{summary?.num_turns ?? "—"}</span></div>
      {replay && <div className="muted" style={{ marginTop: 8 }}>replayed stream — wall-clock phases are synthetic; reported api, cost and turns are from the recording</div>}

      {byTool.length > 0 && (
        <>
          <div className="sect-h" style={{ marginTop: 12 }}>tool time</div>
          {byTool.sort((a, b) => b[1].ms - a[1].ms).map(([name, v]) => (
            <div className="hbar" key={name}>
              <span>{name}</span>
              <span className="track"><i style={{ width: `${(v.ms / toolMax) * 100}%` }} /></span>
              <b>{ms(v.ms)}</b>
            </div>
          ))}
        </>
      )}

      {(t.legs ?? []).length > 0 && (
        <>
          <div className="sect-h" style={{ marginTop: 12 }}>legs</div>
          <div className="legs">
            {t.legs!.map((l, i) => (
              <i key={i} style={{ width: `${Math.max(0.4, (l.ms / total) * 100)}%`, background: C[l.phase as keyof typeof C] ?? "#333" }}
                title={`${l.phase}${l.label ? ` · ${l.label}` : ""} · ${ms(l.ms)} @ +${l.at}s`} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
