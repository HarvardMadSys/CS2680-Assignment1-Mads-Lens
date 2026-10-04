"use client";
import { useCallback, useRef, useState } from "react";
import { API, api } from "./api";
import { toTurn } from "./turn";
import type { Frame, Options, Turn } from "./types";

export function useConsole() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [session, setSession] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const es = useRef<EventSource | null>(null);

  const patch = (runId: string, fn: (t: Turn) => Turn) =>
    setTurns((ts) => ts.map((t) => (t.runId === runId ? fn(t) : t)));

  const attach = useCallback((runId: string) => {
    es.current?.close();
    const src = new EventSource(`${API}/api/runs/${runId}/stream`);
    es.current = src;
    src.onmessage = (e) => {
      const f: Frame = JSON.parse(e.data);
      patch(runId, (t) => {
        const next: Turn = { ...t, frames: [...t.frames, f] };
        if (f.kind === "init") { next.init = f; next.status = "running"; setSession(f.session_id); }
        if (f.kind === "run.finished") { next.status = f.status === "finished" ? "finished" : "failed"; next.summary = f as any; if (f.session_id) setSession(f.session_id); }
        if (f.kind === "run.failed") { next.status = "failed"; next.summary = f as any; }
        if (f.kind === "run.timing") next.summary = { ...(t.summary ?? { status: t.status }), phases: f.phases, timing: f.timing };
        return next;
      });
      if (f.kind === "run.finished" || f.kind === "run.failed") setBusy(false);
    };
    src.addEventListener("end", () => { src.close(); setBusy(false); });
    src.onerror = () => { src.close(); setBusy(false); };
  }, []);

  const start = useCallback(
    async (prompt: string, cwd: string, options: Options, replay?: string) => {
      setBusy(true);
      const resume = session ?? undefined;
      try {
        const { run_id } = await api.startRun({ prompt, cwd, replay, options: { ...options, resume } });
        setTurns((ts) => [...ts, { runId: run_id, prompt, cwd, resumed: resume ?? null, replay: replay ?? null, frames: [], status: "starting", startedAt: Date.now() / 1000 }]);
        attach(run_id);
      } catch (e: any) {
        setTurns((ts) => [...ts, { runId: `local-${Date.now()}`, prompt, cwd, frames: [], status: "failed", startedAt: Date.now() / 1000, summary: { status: "failed", error: String(e.message ?? e) } }]);
        setBusy(false);
      }
    },
    [attach, session]
  );

  const cancel = useCallback(() => {
    const live = turns.find((t) => t.status === "running" || t.status === "starting");
    if (live) api.cancel(live.runId).catch(() => {});
  }, [turns]);

  const reset = useCallback(() => { es.current?.close(); setTurns([]); setSession(null); setBusy(false); }, []);

  /** Rehydrate a past conversation and arm the composer to resume it. */
  const openSession = useCallback(async (sessionId: string) => {
    es.current?.close();
    const { runs } = await api.session(sessionId);
    setTurns(runs.map(toTurn));
    setSession(sessionId);
    const live = runs.find((r: any) => r.live);
    if (live) { setBusy(true); attach(live.id); } else setBusy(false);
    return runs[runs.length - 1]?.cwd as string | undefined;
  }, [attach]);

  return { turns, session, busy, start, cancel, reset, setSession, openSession };
}
