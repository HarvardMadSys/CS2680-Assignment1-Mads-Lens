import type { Run, RunStatus } from "../types";

/** A run's status is its newest round's status. */
export function runStatus(run: Run): RunStatus {
  return run.rounds.at(-1)?.status ?? "done";
}

export function isRunning(run: Run): boolean {
  return runStatus(run) === "running";
}

/** Totals across every round, for the run header. */
export function runTotals(run: Run) {
  return run.rounds.reduce(
    (acc, r) => ({
      costUsd: acc.costUsd + (r.costUsd ?? 0),
      durationMs: acc.durationMs + (r.durationMs ?? 0),
      numTurns: acc.numTurns + (r.numTurns ?? 0),
    }),
    { costUsd: 0, durationMs: 0, numTurns: 0 },
  );
}

/** The error to surface at run level: whatever ended the newest round. */
export function runError(run: Run): string | undefined {
  return run.rounds.at(-1)?.error;
}
