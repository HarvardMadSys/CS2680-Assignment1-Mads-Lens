import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS module, no types
import { createReplayRotation, parseReplayFlag } from "../../server/replay.mjs";

/**
 * The flag is how the fast loop is entered, so its shapes matter: a written
 * list, a shell-expanded glob and a single path all have to land the same way.
 */
describe("parseReplayFlag", () => {
  it("finds nothing when the flag is absent", () => {
    expect(parseReplayFlag(["--port", "8000"])).toEqual([]);
  });

  it("reads a single file either way it is written", () => {
    expect(parseReplayFlag(["--replay=a.jsonl"])).toEqual(["a.jsonl"]);
    expect(parseReplayFlag(["--replay", "a.jsonl"])).toEqual(["a.jsonl"]);
  });

  it("reads a bracketed list", () => {
    expect(parseReplayFlag(["--replay=[a.jsonl, b.jsonl]"])).toEqual([
      "a.jsonl",
      "b.jsonl",
    ]);
  });

  it("reads a list of separate arguments, as a glob expands to", () => {
    expect(parseReplayFlag(["--replay", "a.jsonl", "b.jsonl"])).toEqual([
      "a.jsonl",
      "b.jsonl",
    ]);
  });

  // A following flag ends the list; it is not a filename.
  it("stops at the next flag", () => {
    expect(parseReplayFlag(["--replay", "a.jsonl", "--port", "80"])).toEqual([
      "a.jsonl",
    ]);
  });

  it("survives quotes and stray whitespace", () => {
    expect(parseReplayFlag([`--replay=[ "a.jsonl" , 'b.jsonl' ]`])).toEqual([
      "a.jsonl",
      "b.jsonl",
    ]);
  });
});

describe("createReplayRotation", () => {
  it("is inactive with no files, which is the live case", () => {
    const rotation = createReplayRotation([]);
    expect(rotation.active).toBe(false);
    expect(rotation.take()).toBeNull();
  });

  it("cycles, so a long session keeps getting recordings", () => {
    const rotation = createReplayRotation(["a", "b"]);
    expect([rotation.take(), rotation.take(), rotation.take()]).toEqual([
      "a",
      "b",
      "a",
    ]);
  });

  it("repeats a single file rather than running out", () => {
    const rotation = createReplayRotation(["only"]);
    expect([rotation.take(), rotation.take()]).toEqual(["only", "only"]);
  });
});
