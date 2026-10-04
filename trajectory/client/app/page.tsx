"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Composer from "@/components/Composer";
import Gallery from "@/components/Gallery";
import Outline, { OutlineStrip } from "@/components/Outline";
import Panel from "@/components/Panel";
import TreeView from "@/components/TreeView";
import TopBar from "@/components/TopBar";
import { build, outline } from "@/lib/tree";
import type { Options } from "@/lib/types";
import { useConsole } from "@/lib/useConsole";
import { useCwd } from "@/lib/useCwd";
import { useProcesses } from "@/lib/useProcesses";

export default function Console() {
  const [cwd, setCwd] = useCwd();
  const [options, setOptions] = useState<Options>({ skip_permissions: true });
  const [panel, setPanel] = useState(false);
  const [gallery, setGallery] = useState(false);
  const [panelSeg, setPanelSeg] = useState<"files" | "runs" | "procs" | "config" | undefined>();
  const { turns, session, busy, start, cancel, reset, openSession } = useConsole();
  const [procs, refreshProcs] = useProcesses(busy);
  const end = useRef<HTMLDivElement>(null);
  const turns_ = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const follow = () => { if (stick.current) end.current?.scrollIntoView({ block: "end" }); };

  useEffect(() => {
    try { setOptions(JSON.parse(localStorage.getItem("opts") || "") || { skip_permissions: true }); } catch {}
  }, []);
  useEffect(() => { localStorage.setItem("opts", JSON.stringify(options)); }, [options]);
  useEffect(follow, [turns]);
  // a node is only as tall as its text once measured — a render later than the text itself
  useEffect(() => {
    const el = turns_.current;
    if (!el) return;
    const ro = new ResizeObserver(follow);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); setPanel((v) => !v); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") { e.preventDefault(); setGallery((v) => !v); }
      if (e.key === "Escape") { setPanel(false); setGallery(false); }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);

  const trees = useMemo(() => turns.map((t) => build(t.frames)), [turns]);
  const groups = useMemo(() => turns.map((t, i) => ({ label: t.prompt, items: outline(trees[i] ?? []) })), [turns, trees]);
  const inputs = useMemo(() => {
    const m: Record<string, any> = {};
    for (const t of turns) for (const f of t.frames) if (f.kind === "tool.call") m[f.id] = f.input;
    return m;
  }, [turns]);
  const settled = turns.filter((t) => t.status !== "running" && t.status !== "starting").length;

  return (
    <div className="shell">
      <TopBar right={
        <>
          {session && <span className="muted mono">{session.slice(0, 8)}…</span>}
          {(procs?.count ?? 0) > 0 && (
            <button className="ghost proc-live" onClick={() => { setPanelSeg("procs"); setPanel(true); }}
              title="background processes the agent started">{procs!.count} running</button>
          )}
          <button className="ghost" data-on={gallery ? "1" : "0"} onClick={() => setGallery((v) => !v)}>sessions ⌘O</button>
          <button className="ghost" data-on={panel ? "1" : "0"} onClick={() => { setPanelSeg(undefined); setPanel((v) => !v); }}>project ⌘\</button>
        </>
      } />
      <div className="cols" data-panel={panel ? "1" : "0"}>
        <div className="rail">
          <div className="sect"><div className="sect-h">Outline</div></div>
          <Outline groups={groups} inputs={inputs} />
        </div>

        <div className="center" onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
        }}>
          <OutlineStrip groups={groups} />
          <div className="turns" ref={turns_}>
            {turns.length === 0 ? <Empty cwd={cwd} /> : <TreeView turns={turns} />}
            <div ref={end} />
          </div>
          <Composer cwd={cwd} onCwd={setCwd} options={options} onOptions={setOptions} busy={busy}
            resumed={session} onRun={(p, replay) => cwd && start(p, cwd, options, replay)}
            onCancel={cancel} onReset={reset} />
        </div>

        {panel && <Panel cwd={cwd ?? ""} tick={settled} onCwd={setCwd} onClose={() => setPanel(false)}
          onOpenSession={async (id) => { setPanel(false); const d = await openSession(id); if (d && d !== cwd) setCwd(d); }}
          procs={procs} onProcChange={refreshProcs} seg={panelSeg} />}
      </div>

      {gallery && (
        <Gallery cwd={cwd} onClose={() => setGallery(false)}
          onOpen={async (s) => {
            setGallery(false);
            const dir = await openSession(s.session_id);
            if (dir && dir !== cwd) setCwd(dir);   // follow the session to where it ran
          }} />
      )}
    </div>
  );
}

function Empty({ cwd }: { cwd: string | null }) {
  return (
    <div style={{ padding: "48px 0", display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="empty-h">{cwd || "choose a working directory to begin"}</div>
      <div className="muted">⌘↵ to run · ⌘\ for the project · or replay a recorded stream for free</div>
    </div>
  );
}
