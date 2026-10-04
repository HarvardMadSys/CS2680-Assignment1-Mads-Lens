import { describe, expect, it } from "vitest";
import { isRunning, runError, runStatus, runTotals } from "../../src/lib/runs";
import { round, run } from "../helpers";

describe("runStatus", () => {
  // The run header reports the conversation's current state, which is the
  // newest round's — an earlier failure does not end the conversation.
  it("is the newest round's status", () => {
    const r = run({
      rounds: [round({ status: "error" }), round({ status: "running" })],
    });
    expect(runStatus(r)).toBe("running");
    expect(isRunning(r)).toBe(true);
  });

  it("treats a run with no rounds as done", () => {
    expect(runStatus(run({ rounds: [] }))).toBe("done");
    expect(isRunning(run({ rounds: [] }))).toBe(false);
  });
});

describe("runTotals", () => {
  it("sums what each round reported", () => {
    const r = run({
      rounds: [
        round({ costUsd: 0.06, durationMs: 2_800, numTurns: 2 }),
        round({ costUsd: 0.04, durationMs: 1_200, numTurns: 3 }),
      ],
    });
    expect(runTotals(r)).toEqual({
      costUsd: 0.1,
      durationMs: 4_000,
      numTurns: 5,
    });
  });

  // A round still running, or one that died before its result event, has no
  // numbers to contribute — it must not poison the total with NaN.
  it("skips rounds that never reported", () => {
    const r = run({
      rounds: [round({ status: "running" }), round({ costUsd: 0.06, numTurns: 2 })],
    });
    expect(runTotals(r)).toEqual({
      costUsd: 0.06,
      durationMs: 0,
      numTurns: 2,
    });
  });

  it("is all zeroes for a run with no rounds", () => {
    expect(runTotals(run({ rounds: [] }))).toEqual({
      costUsd: 0,
      durationMs: 0,
      numTurns: 0,
    });
  });
});

describe("runError", () => {
  it("surfaces whatever ended the newest round", () => {
    expect(
      runError(run({ rounds: [round({ error: "old" }), round({ error: "new" })] })),
    ).toBe("new");
  });

  it("is undefined once a later round succeeds", () => {
    expect(
      runError(run({ rounds: [round({ error: "old" }), round({ status: "done" })] })),
    ).toBeUndefined();
  });
});
