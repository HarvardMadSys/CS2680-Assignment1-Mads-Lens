import type { Turn } from "./types";

/** One stored run record → the shape the console renders. */
export function toTurn(r: any): Turn {
  return {
    runId: r.id, prompt: r.prompt, cwd: r.cwd, resumed: r.prev_session_id ?? null,
    replay: r.replay ? "1" : null, frames: r.frames ?? [], status: r.status,
    startedAt: r.started_at,
    summary: {
      status: r.status, cost_usd: r.cost_usd, duration_ms: r.duration_ms,
      api_duration_ms: r.api_duration_ms, num_turns: r.num_turns, session_id: r.session_id,
      usage: r.usage, phases: r.phases, timing: r.timing, error: r.error, result: r.result,
    },
  };
}
