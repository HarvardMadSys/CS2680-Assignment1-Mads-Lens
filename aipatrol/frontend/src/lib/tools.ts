/**
 * A tool call's one-line identity: the thing it acted on. `Read` is only
 * interesting because of its file, `Bash` because of its command. Everything
 * else in the input goes in the expanded view.
 */
const PRIMARY_FIELD: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  NotebookEdit: "notebook_path",
  Bash: "command",
  Glob: "pattern",
  Grep: "pattern",
  WebFetch: "url",
  WebSearch: "query",
  Task: "description",
  Agent: "description",
  TodoWrite: "",
};

/** The verb shown next to the tool name, e.g. Read → "reading". */
/** The tools that delegate to a subagent. */
export function isDelegating(name: string): boolean {
  return name === "Agent" || name === "Task";
}

const VERB: Record<string, string> = {
  Agent: "delegated",
  Task: "delegated",
  Read: "read",
  Write: "wrote",
  Edit: "edited",
  Bash: "ran",
  Glob: "matched",
  Grep: "searched",
  WebFetch: "fetched",
  WebSearch: "searched",
};

export function toolTarget(name: string, input: Record<string, unknown>): string {
  const field = PRIMARY_FIELD[name];

  if (field) {
    const value = input[field];
    if (typeof value === "string") return collapse(value);
  }

  if (field === "") return "";

  // Unknown tool: show whichever string field looks most like a subject.
  const firstString = Object.values(input).find(
    (v): v is string => typeof v === "string",
  );
  return firstString ? collapse(firstString) : "";
}

export function toolVerb(name: string): string | undefined {
  return VERB[name];
}

/** Tools whose target is a path get a monospace treatment and a basename. */
export function targetIsPath(name: string): boolean {
  return ["Read", "Write", "Edit", "NotebookEdit"].includes(name);
}

/** Squash newlines so a multi-line command still fits one row. */
function collapse(value: string): string {
  const oneLine = value.replace(/\s*\n\s*/g, " ⏎ ").trim();
  return oneLine.length > 140 ? `${oneLine.slice(0, 139)}…` : oneLine;
}

/** Pretty-print the full input for the expanded view. */
export function formatInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => {
      const value = typeof v === "string" ? v : JSON.stringify(v, null, 2);
      return value.includes("\n") ? `${k}:\n${value}` : `${k}: ${value}`;
    })
    .join("\n\n");
}

/** ------------------------------------------------------------------
 *  Folding tool results
 *
 *  A result is shown with its call, not hidden behind a click — but a
 *  pytest log can run thousands of lines, and a page that buries the
 *  trajectory is a page nobody reads.
 *
 *  The fold keeps a head *and* a tail. Head-only truncation is the obvious
 *  choice and the wrong one: the single most useful line of a test run is
 *  the last one ("1 failed, 11 passed"), and head-only throws it away.
 *  ------------------------------------------------------------------ */

interface Budget {
  head: number;
  tail: number;
}

/**
 * Per-tool line budgets. A `Read` result is the file you just asked for, so
 * echoing it back earns little; a `Bash` result is the reason you ran the
 * command, so it earns more.
 */
const RESULT_BUDGET: Record<string, Budget> = {
  Read: { head: 4, tail: 0 },
  Write: { head: 3, tail: 0 },
  Edit: { head: 14, tail: 0 }, // a diff is short and all of it matters
  Glob: { head: 6, tail: 0 },
  Grep: { head: 8, tail: 2 },
  Bash: { head: 8, tail: 8 },
};

const DEFAULT_BUDGET: Budget = { head: 6, tail: 4 };

/** A failure earns more room than a success — it is why you are looking. */
const FAILURE_BONUS = 6;

/** One pathological line must not stretch the column. */
const MAX_LINE_CHARS = 300;

export interface FoldedResult {
  head: string[];
  tail: string[];
  hiddenLines: number;
  totalLines: number;
}

export function foldResult(
  name: string,
  failed: boolean,
  result: string,
): FoldedResult {
  const lines = result.replace(/\s+$/, "").split("\n").map(clip);
  const base = RESULT_BUDGET[name] ?? DEFAULT_BUDGET;
  const head = base.head + (failed ? FAILURE_BONUS : 0);
  const tail = base.tail + (failed ? Math.ceil(FAILURE_BONUS / 2) : 0);

  // Folding is only worth it if it actually hides more than the band costs.
  if (lines.length <= head + tail + 2) {
    return {
      head: lines,
      tail: [],
      hiddenLines: 0,
      totalLines: lines.length,
    };
  }

  return {
    head: lines.slice(0, head),
    tail: tail > 0 ? lines.slice(-tail) : [],
    hiddenLines: lines.length - head - tail,
    totalLines: lines.length,
  };
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS
    ? `${line.slice(0, MAX_LINE_CHARS)}…`
    : line;
}
