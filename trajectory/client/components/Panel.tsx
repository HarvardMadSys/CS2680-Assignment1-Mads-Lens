"use client";
import { useState } from "react";
import type { Procs } from "@/lib/useProcesses";
import Config from "./Config";
import FileBrowser from "./FileBrowser";
import Processes from "./Processes";
import RunList from "./RunList";

const SEGS = ["files", "runs", "procs", "config"] as const;
type Seg = (typeof SEGS)[number];

/** The one on-demand surface: everything about the project that isn't the run in front of you. */
export default function Panel({ cwd, tick, onCwd, onClose, onOpenSession, procs, onProcChange, seg: initSeg }: {
  cwd: string; tick: number; onCwd: (p: string) => void; onClose: () => void;
  onOpenSession?: (id: string) => void; procs: Procs | null; onProcChange: () => void; seg?: Seg;
}) {
  const [seg, setSeg] = useState<Seg>(initSeg ?? "files");
  return (
    <aside className="panel">
      <div className="panel-h">
        <div className="seg">
          {SEGS.map((s) => (
            <button key={s} className="segb" data-on={seg === s ? "1" : "0"} onClick={() => setSeg(s)}>
              {s}{s === "procs" && (procs?.count ?? 0) > 0 ? <span className="segn">{procs!.count}</span> : null}
            </button>
          ))}
        </div>
        <button className="link" onClick={onClose}>close</button>
      </div>
      <div className="panel-b">
        {!cwd ? <div className="sect muted">no directory</div>
          : seg === "files" ? <FileBrowser cwd={cwd} tick={tick} />
          : seg === "runs" ? <RunList cwd={cwd} tick={tick} onCwd={onCwd} onOpenSession={onOpenSession} />
          : seg === "procs" ? <Processes data={procs} onChange={onProcChange} />
          : <Config cwd={cwd} />}
      </div>
    </aside>
  );
}
