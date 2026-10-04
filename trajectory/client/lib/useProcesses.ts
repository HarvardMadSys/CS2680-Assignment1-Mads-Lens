"use client";
import { useEffect, useState } from "react";
import { API } from "./api";

export type Proc = {
  pid: number; ppid?: number; cpu?: number; rss_kb?: number; elapsed_s?: number;
  started_at?: number; cmd?: string; run_id?: string; orphaned?: boolean;
};
export type Agent = Proc & { run_id: string; alive: boolean; children: Proc[] };
export type Procs = { agents: Agent[]; orphans: Proc[]; count: number };

/** One poller for the whole page: fast while something is running, slow when nothing is. */
export function useProcesses(active: boolean): [Procs | null, () => void] {
  const [data, setData] = useState<Procs | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`${API}/api/processes`, { cache: "no-store" });
        if (!stop) setData(await r.json());
      } catch { if (!stop) setData(null); }
    };
    tick();
    const every = active || (data?.count ?? 0) > 0 ? 3000 : 15000;
    const id = setInterval(tick, every);
    return () => { stop = true; clearInterval(id); };
  }, [active, data?.count, nonce]);

  return [data, () => setNonce((n) => n + 1)];
}
