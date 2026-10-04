import { describe, expect, it } from "vitest";
import {
  foldResult,
  formatInput,
  isDelegating,
  targetIsPath,
  toolTarget,
  toolVerb,
} from "../../src/lib/tools";

describe("toolTarget", () => {
  it("shows the one field that says what the call acted on", () => {
    expect(toolTarget("Read", { file_path: "/tmp/a.txt", offset: 3 })).toBe(
      "/tmp/a.txt",
    );
    expect(toolTarget("Bash", { command: "pytest -q", timeout: 5 })).toBe(
      "pytest -q",
    );
    expect(toolTarget("Grep", { pattern: "TODO", path: "src" })).toBe("TODO");
  });

  it("squashes a multi-line command onto one row", () => {
    expect(toolTarget("Bash", { command: "cd src\n  && ls" })).toBe(
      "cd src ⏎ && ls",
    );
  });

  it("clips a long target, ellipsis included", () => {
    const target = toolTarget("Bash", { command: "x".repeat(200) });
    expect(target).toHaveLength(140);
    expect(target.endsWith("…")).toBe(true);
  });

  it("gives TodoWrite no target at all", () => {
    expect(toolTarget("TodoWrite", { todos: [{ content: "a" }] })).toBe("");
  });

  it("falls back to the first string field for an unknown tool", () => {
    expect(toolTarget("Mystery", { count: 3, subject: "the thing" })).toBe(
      "the thing",
    );
  });

  it("is empty when the primary field is missing or not a string", () => {
    expect(toolTarget("Read", {})).toBe("");
    expect(toolTarget("Read", { file_path: 42 })).toBe("");
    expect(toolTarget("Mystery", { count: 3 })).toBe("");
  });
});

describe("tool identity", () => {
  it("names the verb for known tools only", () => {
    expect(toolVerb("Read")).toBe("read");
    expect(toolVerb("Agent")).toBe("delegated");
    expect(toolVerb("Mystery")).toBeUndefined();
  });

  it("knows which targets are paths", () => {
    expect(targetIsPath("Edit")).toBe(true);
    expect(targetIsPath("Bash")).toBe(false);
  });

  // The CLI names it Agent; older streams say Task. Both delegate.
  it("recognises both names for delegation", () => {
    expect(isDelegating("Agent")).toBe(true);
    expect(isDelegating("Task")).toBe(true);
    expect(isDelegating("Bash")).toBe(false);
  });
});

describe("formatInput", () => {
  it("puts a multi-line value on its own lines and keeps scalars inline", () => {
    expect(formatInput({ file_path: "/tmp/a", old: "one\ntwo" })).toBe(
      "file_path: /tmp/a\n\nold:\none\ntwo",
    );
  });

  it("json-encodes non-string values", () => {
    expect(formatInput({ limit: 5, flags: ["-q"] })).toBe(
      'limit: 5\n\nflags:\n[\n  "-q"\n]',
    );
  });

  it("is empty for an empty input", () => {
    expect(formatInput({})).toBe("");
  });
});

describe("foldResult", () => {
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

  it("leaves a short result whole", () => {
    const folded = foldResult("Bash", false, lines(5));
    expect(folded.head).toHaveLength(5);
    expect(folded.tail).toEqual([]);
    expect(folded.hiddenLines).toBe(0);
    expect(folded.totalLines).toBe(5);
  });

  // Head-only truncation throws away the one line that matters most:
  // "1 failed, 311 passed". The fold keeps both ends.
  it("keeps the tail of a long Bash result", () => {
    const folded = foldResult("Bash", false, lines(100));
    expect(folded.head).toHaveLength(8);
    expect(folded.tail).toHaveLength(8);
    expect(folded.tail.at(-1)).toBe("line 100");
    expect(folded.hiddenLines).toBe(84);
    expect(folded.head.length + folded.tail.length + folded.hiddenLines).toBe(
      folded.totalLines,
    );
  });

  it("gives a Read no tail — the file was the point, not its end", () => {
    const folded = foldResult("Read", false, lines(100));
    expect(folded.head).toHaveLength(4);
    expect(folded.tail).toEqual([]);
    expect(folded.hiddenLines).toBe(96);
  });

  it("gives a failure more room than a success", () => {
    const ok = foldResult("Bash", false, lines(100));
    const failed = foldResult("Bash", true, lines(100));
    expect(failed.head.length).toBeGreaterThan(ok.head.length);
    expect(failed.tail.length).toBeGreaterThan(ok.tail.length);
    expect(failed.hiddenLines).toBeLessThan(ok.hiddenLines);
  });

  it("falls back to a default budget for an unknown tool", () => {
    const folded = foldResult("Mystery", false, lines(100));
    expect(folded.head).toHaveLength(6);
    expect(folded.tail).toHaveLength(4);
  });

  // Folding two lines to save one is not worth a band that costs a line.
  it("does not fold when the fold would hide almost nothing", () => {
    const folded = foldResult("Bash", false, lines(18));
    expect(folded.hiddenLines).toBe(0);
    expect(folded.head).toHaveLength(18);
  });

  it("clips a pathological line so it cannot stretch the column", () => {
    const folded = foldResult("Bash", false, "x".repeat(1000));
    expect(folded.head[0]).toHaveLength(301);
    expect(folded.head[0].endsWith("…")).toBe(true);
  });

  it("ignores trailing whitespace when counting lines", () => {
    expect(foldResult("Bash", false, "one\ntwo\n\n  \n").totalLines).toBe(2);
  });

  it("reports one line for an empty result", () => {
    expect(foldResult("Bash", false, "")).toEqual({
      head: [""],
      tail: [],
      hiddenLines: 0,
      totalLines: 1,
    });
  });
});
