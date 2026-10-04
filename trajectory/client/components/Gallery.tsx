"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { ago, ms, usd } from "@/lib/format";

type S = {
  session_id: string; cwd: string; title: string; last_at: number; runs: number;
  cost_usd: number; duration_ms: number; turns: number; status: string; replay: boolean;
  errors: number; steps: { name: string; err: boolean; sub: boolean }[]; prompts: string[];
  imported?: boolean; model?: string; branch?: string;
};

export default function Gallery({ cwd, onOpen, onClose }: {
  cwd: string | null; onOpen: (s: S) => void; onClose: () => void;
}) {
  const [all, setAll] = useState<S[] | null>(null);
  const [here, setHere] = useState(true);
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState("");
  const [more, setMore] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => { api.sessions().then(setAll).catch(() => setAll([])); }, []);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (all ?? [])
      .filter((s) => (!here || !cwd || s.cwd === cwd))
      .filter((s) => (!mine || !s.imported))
      .filter((s) => !needle || s.prompts.join(" ").toLowerCase().includes(needle) || s.session_id.includes(needle));
  }, [all, here, mine, cwd, q]);

  // the fade only makes a promise the list can keep when there is actually more below
  const gauge = () => {
    const el = body.current;
    setMore(!!el && el.scrollHeight - el.scrollTop - el.clientHeight > 8);
  };
  useEffect(gauge, [rows]);
  useEffect(() => {
    addEventListener("resize", gauge);
    return () => removeEventListener("resize", gauge);
  }, []);

  return (
    <div className="scrim" onClick={onClose}>
      <div className="gal" data-more={more ? "1" : "0"} onClick={(e) => e.stopPropagation()}>
        <div className="gal-h">
          <span className="sect-h" style={{ margin: 0 }}>Sessions</span>
          <input className="mini grow" autoFocus placeholder="search prompts…" value={q}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onClose()} />
          <button className="ghost" data-on={here ? "1" : "0"} onClick={() => setHere((v) => !v)}>
            {here ? "this directory" : "everywhere"}
          </button>
          <button className="ghost" data-on={mine ? "1" : "0"} onClick={() => setMine((v) => !v)}
            title="also show sessions from Claude Code's own store that this app never ran">
            {mine ? "ran here" : "all sources"}
          </button>
          <span className="gal-n">{rows.length}</span>
          <button className="link" onClick={onClose}>close</button>
        </div>

        <div className="gal-b" ref={body} onScroll={gauge}>
          {all === null && <div className="sect muted">loading…</div>}
          {all !== null && rows.length === 0 && <div className="sect muted">no sessions yet</div>}
          <div className="cards">
            {rows.map((s) => (
              <button className="card2" key={s.session_id} onClick={() => onOpen(s)}>
                <div className="row">
                  <span className={`badge ${s.status === "finished" ? "fin" : s.status === "failed" ? "fail" : "run"}`} />
                  <span className="muted">{ago(s.last_at)}</span>
                  <span className="grow" />
                  {s.replay && <span className="chip">replay</span>}
                  {s.imported && <span className="chip imp">imported</span>}
                  <span className="muted">{s.cost_usd == null ? "" : usd(s.cost_usd)}</span>
                </div>
                <div className="card2-t">{s.title}</div>
                <Strip steps={s.steps} />
                <div className="row muted card2-f">
                  <span className="ell">{s.cwd.split("/").slice(-1)[0]}</span>
                  {s.branch ? <><span className="sep">·</span><span>{s.branch}</span></> : null}
                  <span className="sep">·</span><span>{s.runs} turn{s.runs > 1 ? "s" : ""}</span>
                  <span className="sep">·</span><span>{ms(s.duration_ms)}</span>
                  {s.errors > 0 && <><span className="sep">·</span><span style={{ color: "var(--err)" }}>{s.errors} err</span></>}
                  <span className="grow" />
                  <span className="mono">{s.session_id.slice(0, 6)}…</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A run's shape at a glance: one tick per tool call, in order. */
function Strip({ steps }: { steps: S["steps"] }) {
  if (!steps.length) return <div className="strip" />;
  return (
    <div className="strip" title={steps.map((s) => s.name).join(" → ")}>
      {steps.map((s, i) => (
        <i key={i} data-k={s.err ? "err" : s.sub ? "sub" : "ok"} />
      ))}
    </div>
  );
}
