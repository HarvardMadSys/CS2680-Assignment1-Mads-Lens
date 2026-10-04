/**
 * Task markers.
 *
 * Subagents are part of the stream-json protocol; tasks are not. The agent is
 * asked (see `server/agent-prompt.md`) to bracket each logical unit of work
 * with markers in its own text, and this module turns those back into
 * structure.
 *
 * Nesting comes from order, not from ids: a start pushes, an end pops. That
 * keeps the model's job to two literal lines with nothing to get wrong, which
 * matters because every one of these is a thing the model might forget.
 */

const START = /^\[\[task-start\s+(.+?)\]\]$/;
const END = /^\[\[task-end\]\]$/;

export type TaskSegment =
  | { kind: "text"; text: string }
  | { kind: "start"; title: string }
  | { kind: "end" };

const MAX_TITLE = 80;

/**
 * Split one assistant text block into prose and markers, in order.
 *
 * Markers must sit alone on a line. Prose either side of them is preserved
 * and returned as its own segment, so a block that mixes them still reads
 * correctly and the markers never reach the page as literal text.
 */
export function splitTaskMarkers(block: string): TaskSegment[] {
  const segments: TaskSegment[] = [];
  let prose: string[] = [];

  const flush = () => {
    const joined = prose.join("\n").trim();
    if (joined) segments.push({ kind: "text", text: joined });
    prose = [];
  };

  for (const line of block.split("\n")) {
    const trimmed = line.trim();

    const start = START.exec(trimmed);
    if (start) {
      flush();
      segments.push({ kind: "start", title: clipTitle(start[1]) });
      continue;
    }

    if (END.test(trimmed)) {
      flush();
      segments.push({ kind: "end" });
      continue;
    }

    prose.push(line);
  }

  flush();
  return segments;
}

/** True if the block carries no markers — the common case, worth a fast path. */
export function hasTaskMarkers(block: string): boolean {
  return block.includes("[[task-start") || block.includes("[[task-end]]");
}

function clipTitle(raw: string): string {
  const title = raw.trim();
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title;
}

/**
 * The open-task stack, kept per agent context: the main agent and each
 * subagent announce tasks independently, so their brackets must not interfere.
 */
export class TaskStacks {
  private stacks = new Map<string, string[]>();

  private key(parentToolUseId: string | null) {
    return `ctx:${parentToolUseId ?? ""}`;
  }

  /** The task an event belongs to: the innermost one still open. */
  current(parentToolUseId: string | null): string | null {
    const stack = this.stacks.get(this.key(parentToolUseId));
    return stack?.at(-1) ?? null;
  }

  push(parentToolUseId: string | null, taskId: string): void {
    const key = this.key(parentToolUseId);
    const stack = this.stacks.get(key) ?? [];
    stack.push(taskId);
    this.stacks.set(key, stack);
  }

  /** Pops and returns the closed task, or null if the agent over-closed. */
  pop(parentToolUseId: string | null): string | null {
    const stack = this.stacks.get(this.key(parentToolUseId));
    return stack?.pop() ?? null;
  }

}
