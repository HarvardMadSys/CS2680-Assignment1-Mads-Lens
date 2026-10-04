"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Caps, Options } from "@/lib/types";

type P = {
  cwd: string | null; onCwd: (p: string) => void;
  options: Options; onOptions: (o: Options) => void;
  busy: boolean; resumed: string | null;
  onRun: (prompt: string, replay?: string) => void;
  onCancel: () => void; onReset: () => void;
};

export default function Composer({ cwd, onCwd, options, onOptions, busy, resumed, onRun, onCancel, onReset }: P) {
  const [text, setText] = useState("");
  const [caps, setCaps] = useState<Caps | null>(null);
  const [fixtures, setFixtures] = useState<string[]>([]);
  const [panel, setPanel] = useState<"" | "opts" | "cwd">("");
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (cwd) api.caps(cwd).then(setCaps).catch(() => setCaps(null)); }, [cwd]);
  useEffect(() => { api.health().then((h) => setFixtures(h.fixtures)).catch(() => {}); }, []);
  useEffect(() => {
    const el = ta.current;
    if (el) { el.style.height = "0px"; el.style.height = Math.min(220, el.scrollHeight) + "px"; }
  }, [text]);

  const send = () => {
    if (!text.trim() || busy || !cwd) return;
    if (options.record != null) onOptions({ ...options, record: `${slug(text)}-${Date.now().toString().slice(-6)}` });
    onRun(text.trim());
    setText("");
  };
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32).replace(/-$/, "");
  const set = (k: keyof Options, v: any) => onOptions({ ...options, [k]: v });
  const toggleTool = (t: string) => {
    const cur = options.tools ?? caps?.tools ?? [];
    set("tools", cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
  };

  return (
    <div className="composer">
      <div className="cbox rel">
        <div className="crow">
          <button className="ghost" data-on={panel === "cwd" ? "1" : "0"} onClick={() => setPanel(panel === "cwd" ? "" : "cwd")}>directory</button>
          <span className="cwd grow" title={cwd ?? ""} data-unset={cwd ? "0" : "1"}>{cwd || "no directory selected"}</span>
          {resumed && <span className="chip" title={resumed}>resumed {resumed.slice(0, 8)}…</span>}
          {resumed && <button className="ghost" onClick={onReset}>new session</button>}
        </div>

        <textarea ref={ta} className="prompt" placeholder={resumed ? "follow-up…" : "what should the agent do?"}
          value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />

        <div className="crow2">
          <button className="ghost" data-on={panel === "opts" ? "1" : "0"} onClick={() => setPanel(panel === "opts" ? "" : "opts")}>
            {options.model ?? "default"} · {(options.tools ?? caps?.tools ?? []).length} tools
          </button>
          <button className="ghost" data-on={options.record != null ? "1" : "0"}
            title="save this run's raw event stream to server/fixtures so it can be replayed"
            onClick={() => set("record", options.record != null ? undefined : "")}>rec</button>
          {fixtures.length > 0 && (
            <select className="mini" value="" disabled={!cwd} onChange={(e) => e.target.value && onRun(`replay ${e.target.value}`, e.target.value)}>
              <option value="">replay…</option>
              {fixtures.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          )}
          <span className="grow" />
          {busy ? <button className="ghost" onClick={onCancel}>stop</button> : null}
          <button className="go" disabled={busy || !text.trim() || !cwd} onClick={send}>run</button>
        </div>

        {panel === "cwd" && <div className="pop"><DirPick cwd={cwd || "~"} onPick={(p) => { onCwd(p); setPanel(""); }} /></div>}
        {panel === "opts" && caps && (
          <div className="pop">
            <div className="row" style={{ gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
              <label className="muted">model <select className="mini" value={options.model ?? ""} onChange={(e) => set("model", e.target.value || undefined)}>
                <option value="">default</option>{caps.models.filter((m) => m !== "default").map((m) => <option key={m}>{m}</option>)}
              </select></label>
              <label className="muted">effort <select className="mini" value={options.effort ?? ""} onChange={(e) => set("effort", e.target.value || undefined)}>
                <option value="">default</option>{caps.efforts.map((m) => <option key={m}>{m}</option>)}
              </select></label>
              <label className="muted">mode <select className="mini" value={options.skip_permissions === false ? (options.permission_mode ?? "") : "bypass"}
                onChange={(e) => e.target.value === "bypass" ? onOptions({ ...options, skip_permissions: true, permission_mode: undefined }) : onOptions({ ...options, skip_permissions: false, permission_mode: e.target.value })}>
                <option value="bypass">skip permissions</option>
                {caps.permission_modes.map((m) => <option key={m}>{m}</option>)}
              </select></label>
              <label className="muted">agent <select className="mini" value={options.agent ?? ""} onChange={(e) => set("agent", e.target.value || undefined)}>
                <option value="">—</option>{caps.agents.map((a) => <option key={a.name}>{a.name}</option>)}
              </select></label>
              <label className="muted">max turns <input className="mini" style={{ width: 52 }} type="number" min={1}
                value={options.max_turns ?? ""} onChange={(e) => set("max_turns", e.target.value ? +e.target.value : undefined)} /></label>
            </div>

            <div className="sect-h">tools</div>
            <div className="grid2" style={{ marginBottom: 10 }}>
              {caps.tools.map((t) => {
                const on = (options.tools ?? caps.tools).includes(t);
                return <label key={t} className="muted" style={{ color: on ? "var(--fg)" : undefined }}>
                  <input type="checkbox" checked={on} onChange={() => toggleTool(t)} /> {t}
                </label>;
              })}
            </div>

            <div className="sect-h">mcp · {caps.mcp.length}</div>
            <div style={{ marginBottom: 10 }}>
              {caps.mcp.length === 0 ? <span className="muted">none configured</span> :
                caps.mcp.map((m) => <div className="kv" key={m.name}><span>{m.name}</span><span className="muted">{m.transport}</span></div>)}
            </div>

            <div className="sect-h">skills · {caps.skills.length} · agents · {caps.agents.length}</div>
            <div className="grid2" style={{ marginBottom: 10 }}>
              {caps.skills.slice(0, 24).map((s) => <span className="muted" key={s.path} title={s.description}>/{s.name}</span>)}
            </div>
            <label className="muted" style={{ display: "block" }}>append system prompt
              <textarea className="doc" style={{ minHeight: 60, marginTop: 4 }} value={options.append_system_prompt ?? ""}
                onChange={(e) => set("append_system_prompt", e.target.value || undefined)} />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

export function DirPick({ cwd, onPick }: { cwd: string; onPick: (p: string) => void }) {
  const [at, setAt] = useState(cwd);       // directory being browsed
  const [typed, setTyped] = useState(cwd); // contents of the path box
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const [recent, setRecent] = useState<any[]>([]);

  useEffect(() => {
    setTyped(at);
    api.list(at)
      .then((d) => { setData(d); setErr(""); })
      .catch((e) => { setData(null); setErr(String(e.message ?? e)); });  // never keep a stale listing
  }, [at]);
  useEffect(() => { api.projects().then(setRecent).catch(() => {}); }, []);

  /** Resolve through the server so `~` and relative paths work and a bad path fails loudly. */
  const choose = async (path: string) => {
    try {
      const { path: resolved } = await api.addProject(path);
      onPick(resolved);
    } catch (e: any) {
      setErr(String(e.message ?? e));
    }
  };

  const crumbs = (data?.path ?? at).split("/").filter(Boolean);

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <input className="mini grow" value={typed} spellCheck={false}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setAt(typed.trim()); } }} />
        <button className="ghost" onClick={() => setAt(typed.trim())}>open</button>
      </div>

      {err && <div className="errbox">{err}</div>}

      {data && (
        <button className="pick" onClick={() => choose(data.path)}>
          use <span className="mono">{data.path}</span>
        </button>
      )}

      {/* The guard is against picking the wrong directory by accident, not against meaning it:
          a path that will not resolve can still be chosen, and the run then fails visibly. */}
      {!data && typed.trim() && (
        <button className="pick" data-warn="1" onClick={() => onPick(typed.trim())}>
          use anyway <span className="mono">{typed.trim()}</span>
        </button>
      )}

      <div className="crumbs">
        <button className="crumb" onClick={() => setAt("/")}>/</button>
        {crumbs.map((c: string, i: number) => (
          <button className="crumb" key={i} onClick={() => setAt("/" + crumbs.slice(0, i + 1).join("/"))}>{c}</button>
        ))}
      </div>

      {recent.length > 0 && (
        <>
          <div className="sect-h">recent</div>
          {recent.slice(0, 5).map((p) => (
            <div className="entry" key={p.path}>
              <button className="grow ell" style={{ textAlign: "left" }} onClick={() => choose(p.path)}>
                {p.name} <span className="muted mono">{p.path}</span>
              </button>
              <span className="muted">{p.runs}</span>
            </div>
          ))}
        </>
      )}

      <div className="sect-h" style={{ marginTop: 10 }}>browse</div>
      {data?.parent && (
        <div className="entry">
          <button className="grow" style={{ textAlign: "left" }} onClick={() => setAt(data.parent)}>..</button>
        </div>
      )}
      {(data?.entries ?? []).filter((e: any) => e.dir).map((e: any) => (
        <div className="entry" key={e.path}>
          <span className="ic">{e.repo ? "◈" : "›"}</span>
          <button className="grow ell" style={{ textAlign: "left" }} onClick={() => setAt(e.path)}>{e.name}</button>
          <button className="sel" onClick={() => choose(e.path)}>select</button>
        </div>
      ))}
      {data && !data.entries.some((e: any) => e.dir) && <div className="muted">no subdirectories</div>}
    </div>
  );
}
