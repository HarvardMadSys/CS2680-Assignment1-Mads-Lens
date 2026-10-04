"use client";
import { API } from "@/lib/api";
import { ms } from "@/lib/format";
import type { Agent, Proc, Procs } from "@/lib/useProcesses";

const mb = (kb?: number) => (kb == null ? "—" : kb > 1024 ? `${(kb / 1024).toFixed(0)}MB` : `${kb}KB`);
const clock = (ts?: number) =>
  ts == null ? "—" : new Date(ts * 1000).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

export default function Processes({ data, onChange }: { data: Procs | null; onChange: () => void }) {
  const kill = async (pid: number) => {
    await fetch(`${API}/api/processes/${pid}/kill`, { method: "POST" }).catch(() => {});
    onChange();
  };
  if (!data) return <div className="sect muted">unavailable</div>;
  if (data.count === 0) return <div className="sect muted">nothing running</div>;

  return (
    <>
      {data.agents.filter((a) => a.alive).map((a) => (
        <div key={a.pid}>
          <Row p={a} label="claude" root onKill={kill} />
          {a.children.map((c) => <Row key={c.pid} p={c} onKill={kill} />)}
          {a.children.length === 0 && <div className="proc-none">no background commands</div>}
        </div>
      ))}
      {data.orphans.length > 0 && (
        <>
          <div className="sect"><div className="sect-h">Outlived their run</div></div>
          {data.orphans.map((p) => <Row key={p.pid} p={p} onKill={kill} />)}
        </>
      )}
      <div className="proc-note">
        Subagents share the agent&apos;s process — what is listed here are the shells, servers and
        test runners it started.
      </div>
    </>
  );
}

function Row({ p, label, root, onKill }: { p: Proc | Agent; label?: string; root?: boolean; onKill: (pid: number) => void }) {
  return (
    <div className="proc" data-root={root ? "1" : "0"} title={(p as any).cmd_full ?? p.cmd}>
      <div className="row">
        <span className="mono proc-pid">{p.pid}</span>
        <span className="grow ell">{label ?? p.cmd}</span>
        <button className="sel" onClick={() => onKill(p.pid)}>kill</button>
      </div>
      <div className="row muted proc-m">
        <span>{ms((p.elapsed_s ?? 0) * 1000)}</span><span className="sep">·</span>
        <span>since {clock(p.started_at)}</span><span className="sep">·</span>
        <span>{(p.cpu ?? 0).toFixed(1)}% cpu</span><span className="sep">·</span>
        <span>{mb(p.rss_kb)}</span>
        {p.orphaned && <><span className="grow" /><span className="chip">orphaned</span></>}
      </div>
    </div>
  );
}
