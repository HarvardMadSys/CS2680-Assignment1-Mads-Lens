"use client";
import { use, useEffect, useMemo, useState } from "react";
import Outline from "@/components/Outline";
import TopBar from "@/components/TopBar";
import TreeView from "@/components/TreeView";
import { api } from "@/lib/api";
import { build, outline } from "@/lib/tree";
import { toTurn } from "@/lib/turn";
import type { Turn } from "@/lib/types";

export default function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const [run, setRun] = useState<any>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.run(runId).then(setRun).catch((e) => setErr(String(e.message ?? e))); }, [runId]);

  const nodes = useMemo(() => (run ? build(run.frames) : []), [run]);
  const inputs = useMemo(() => {
    const m: Record<string, any> = {};
    for (const f of run?.frames ?? []) if (f.kind === "tool.call") m[f.id] = f.input;
    return m;
  }, [run]);

  const turn: Turn | null = run ? toTurn(run) : null;

  return (
    <div className="shell">
      <TopBar right={<><span className="muted mono ell">{run?.cwd}</span><a className="ghost" href="/">console</a></>} />
      <div className="cols">
        <div className="rail">
          <div className="sect"><div className="sect-h">outline</div></div>
          <Outline groups={[{ label: run?.prompt ?? "", items: outline(nodes) }]} inputs={inputs} />
        </div>
        <div className="center">
          <div className="turns">
            {err && <div className="errbox">{err}</div>}
            {turn && <TreeView turns={[turn]} />}
          </div>
        </div>
      </div>
    </div>
  );
}
