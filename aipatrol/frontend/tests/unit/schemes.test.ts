import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEME, SCHEMES, isScheme } from "../../src/lib/schemes";
import { TEST_PROMPT } from "../../src/lib/testPrompt";

const css = readFileSync(new URL("../../src/index.css", import.meta.url), "utf8");

describe("colour schemes", () => {
  it("offers five, with the default among them", () => {
    expect(SCHEMES).toHaveLength(5);
    expect(SCHEMES.map((s) => s.id)).toContain(DEFAULT_SCHEME);
  });

  it("has a stylesheet block for every scheme but the default", () => {
    for (const { id } of SCHEMES) {
      if (id === DEFAULT_SCHEME) continue;
      expect(css).toContain(`[data-scheme="${id}"]`);
    }
    // The default lives on bare :root, so an unset preference needs no
    // attribute and cannot flash the wrong palette.
    expect(css).toContain(`:root[data-scheme="${DEFAULT_SCHEME}"]`);
  });

  /**
   * Every scheme declares both palettes in one place. A missing token would
   * fall through to another scheme's value and only show up as one wrong
   * colour in one mode, which is exactly the bug nobody notices.
   */
  it("declares the same tokens, light and dark, in every scheme", () => {
    const blocks = [...css.matchAll(/:root(?:\[data-scheme="[a-z]+"\])?\s*\{([^}]*)\}/g)]
      .map((m) => m[1])
      .filter((body) => body.includes("--l-bg:"));

    expect(blocks).toHaveLength(SCHEMES.length);

    const names = (body: string, prefix: string) =>
      [...body.matchAll(new RegExp(`--${prefix}-([a-z-]+):`, "g"))]
        .map((m) => m[1])
        .sort();

    const [first] = blocks;
    const expected = names(first, "l");
    expect(expected.length).toBeGreaterThan(10);

    for (const body of blocks) {
      expect(names(body, "l")).toEqual(expected);
      expect(names(body, "d")).toEqual(expected);
    }
  });

  it("recognises its own ids and nothing else", () => {
    expect(isScheme("ember")).toBe(true);
    expect(isScheme("chartreuse")).toBe(false);
    expect(isScheme(null)).toBe(false);
  });

  it("gives each scheme a distinct accent in both modes", () => {
    const light = SCHEMES.map((s) => s.swatch[0]);
    const dark = SCHEMES.map((s) => s.swatch[1]);
    expect(new Set(light).size).toBe(SCHEMES.length);
    expect(new Set(dark).size).toBe(SCHEMES.length);
  });
});

describe("the Ctrl+B test prompt", () => {
  // It exists to exercise the renderer, so it has to ask for every shape the
  // renderer draws.
  it("asks for every feature the page renders", () => {
    const asks = {
      "nested tasks": /nested task/i,
      "parallel subagents": /two subagents at\s+the same time/i,
      "a subagent inside a subagent": /subagent nested inside a subagent/i,
      "a tool failure": /definitely-not-here/,
      "several tools": /Bash/,
    };

    for (const [what, pattern] of Object.entries(asks)) {
      expect(TEST_PROMPT, `should ask for ${what}`).toMatch(pattern);
    }
  });

  it("closes its own brackets, since the run depends on it", () => {
    expect(TEST_PROMPT).toMatch(/\[\[task-end\]\].*including the last/s);
  });

  it("keeps the agent out of trouble", () => {
    expect(TEST_PROMPT).toMatch(/Do not modify or delete any file/i);
  });
});
