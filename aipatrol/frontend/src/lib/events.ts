import type { TrajectoryEvent } from "../types";

/**
 * A round is over when the result event lands, so nothing more is coming for
 * a call still waiting on its tool_result. Without this a finished run can sit
 * there with a spinner that never resolves.
 */
export function sweepPending(
  events: TrajectoryEvent[],
  note: string,
): TrajectoryEvent[] {
  return events.map((e) =>
    e.kind === "tool" && e.status === "pending"
      ? {
          ...e,
          status: "error" as const,
          result: e.result ?? note,
          endedAt: Date.now(),
        }
      : e,
  );
}


/**
 * A round cannot end with work still open. The agent is asked to close every
 * task it opens, and mostly does — but forgetting the last `[[task-end]]` is
 * the single most likely way for it to slip, so nothing may depend on it.
 */
export function sweepOpenTasks(
  events: TrajectoryEvent[],
  status: "done" | "error",
): TrajectoryEvent[] {
  return events.map((e) =>
    e.kind === "task" && e.status === "running"
      ? { ...e, status, endedAt: Date.now() }
      : e,
  );
}
