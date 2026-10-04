import { describe, expect, it } from "vitest";
import { sweepPending } from "../../src/lib/events";
import { text, tool } from "../helpers";

describe("sweepPending", () => {
  // Nothing is coming for a call still open when the round ends, so leaving
  // it pending means a spinner that never resolves.
  it("fails every pending call and says why", () => {
    const swept = sweepPending(
      [tool({ id: "a", status: "pending" }), tool({ id: "b", status: "pending" })],
      "Stopped.",
    );
    expect(swept.map((e) => e.kind === "tool" && e.status)).toEqual([
      "error",
      "error",
    ]);
    expect(swept.map((e) => e.kind === "tool" && e.result)).toEqual([
      "Stopped.",
      "Stopped.",
    ]);
  });

  it("stamps an end time on what it closes", () => {
    const [swept] = sweepPending([tool({ status: "pending" })], "Stopped.");
    expect(swept.kind === "tool" && swept.endedAt).toBeGreaterThan(0);
  });

  it("leaves settled calls and text alone", () => {
    const events = [
      tool({ id: "ok", status: "ok", result: "done" }),
      tool({ id: "bad", status: "error", result: "boom" }),
      text({ id: "t" }),
    ];
    expect(sweepPending(events, "Stopped.")).toEqual(events);
  });

  // A call may already carry partial output; the note explains, it does not
  // replace what the run managed to report.
  it("keeps output the call already had", () => {
    const [swept] = sweepPending(
      [tool({ status: "pending", result: "partial output" })],
      "Stopped.",
    );
    expect(swept.kind === "tool" && swept.result).toBe("partial output");
  });

  it("does not mutate the array it was given", () => {
    const events = [tool({ status: "pending" })];
    const swept = sweepPending(events, "Stopped.");
    expect(events[0].status).toBe("pending");
    expect(swept).not.toBe(events);
  });
});
