"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { clock, ms, num, short, usd } from "@/lib/format";
import { LatencyBar, LatencyLegend, slices } from "./Latency";

export default function RunList({ cwd, tick, onCwd, onOpenSession }: { cwd: string; tick?: number; onCwd: (p: string) => void; onOpenSession?: (id: string) => void }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [m, setM] = useState<any>(null);
  const [projects, setProjects] = useState<any[]>([]);

  useEffect(() => {
    if (!cwd) return;
    api.runs(`cwd=${encodeURIComponent(cwd)}&limit=40`).then(setRuns).catch(() => setRuns([]));
    api.metrics(`cwd=${encodeURIComponent(cwd)}`).then(setM).catch(() => setM(null));
    api.projects().then(setProjects).catch(() => {});
  }, [cwd, tick]);

  const sl = m ? slices({ status: "", phases: m.phases, api_duration_ms: m.api_ms, timing: { emit_ms: m.emit_ms } } as any) : [];
  const maxTool = Math.max(1, ...(m?.by_tool ?? []).map((t: any) => t.n));

  return (
    <>
      {m && (
        <div className="sect">
          <div className="kv"><span>runs</span><span>{m.runs}</span></div>
          <div className="kv"><span>cost</span><span>{usd(m.cost_usd)}</span></div>
          <div className="kv"><span>wall</span><span>{ms(m.duration_ms)}</span></div>
          <div className="kv"><span>tool calls</span><span>{m.tool_calls}{m.tool_errors ? <span style={{ color: "var(--err)" }}> · {m.tool_errors} err</span> : null}</span></div>
          <div className="kv"><span>subagents</span><span>{m.subagent_calls} · {m.subagent_events} nested</span></div>
          <div className="kv"><span>tokens out</span><span>{num(m.tokens?.output_tokens)}</span></div>
          <div className="kv"><span>first token</span><span>{ms(m.ttft_ms)}</span></div>
          <LatencyBar data={sl} height={6} />
          <LatencyLegend data={sl} />
          <div style={{ marginTop: 10 }}>
            {(m.by_tool ?? []).slice(0, 8).map((t: any) => (
              <div className="hbar" key={t.name} title={`${t.n} calls · ${ms(t.ms)} total · ${ms(t.avg_ms)} avg`}>
                <span style={{ color: t.errors ? "var(--err)" : undefined }}>{t.name}</span>
                <span className="track"><i style={{ width: `${(t.n / maxTool) * 100}%` }} /></span>
                <b>{t.n}</b>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="sect"><div className="sect-h">Runs here</div></div>
      {runs.length === 0 && <div className="sect muted">none yet</div>}
      {runs.map((r) => (
        <button className="runrow" key={r.id} onClick={() => r.session_id && onOpenSession?.(r.session_id)}>
          <div className="row">
            <span className={`badge ${r.status === "finished" ? "fin" : r.status === "failed" ? "fail" : "run"}`} />
            <span className="grow ell">{r.prompt}</span>
          </div>
          <div className="row muted" style={{ fontSize: 11.5, marginTop: 2 }}>
            <span>{usd(r.cost_usd)}</span><span className="sep">·</span>
            <span>{ms(r.duration_ms)}</span><span className="sep">·</span>
            <span>{r.num_turns ?? "—"}t</span><span className="sep">·</span>
            <span>{clock(r.started_at)}</span>
            {r.replay ? <span className="chip">replay</span> : null}
            <span className="grow" />
            <span className="mono">{short(r.session_id, 6)}…</span>
          </div>
          <LatencyBar data={slices(r as any)} height={3} />
        </button>
      ))}

      <div className="sect"><div className="sect-h">Other directories</div></div>
      {projects.filter((p) => p.path !== cwd).slice(0, 8).map((p) => (
        <div className="entry" key={p.path}>
          <button className="grow ell" style={{ textAlign: "left" }} onClick={() => onCwd(p.path)}>
            {p.name} <span className="muted mono">{p.path}</span>
          </button>
          {!p.exists && <span className="chip" style={{ color: "var(--err)" }}>gone</span>}
          <button className="sel" onClick={() => api.dropProject(p.path).then(() => api.projects().then(setProjects))}>forget</button>
        </div>
      ))}
    </>
  );
}
