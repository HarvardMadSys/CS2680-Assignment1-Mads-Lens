/** ------------------------------------------------------------------
 *  Trajectory events — what the agent did, in the order it did it.
 *  These mirror the blocks that arrive on the stream-json output.
 *  ------------------------------------------------------------------ */

export type ToolStatus = "pending" | "ok" | "error";

/** Shared by runs, rounds and tasks — the same three words everywhere. */
export type RunStatus = "running" | "done" | "error";

/**
 * Every event names the tool call that produced it. `null` means the main
 * agent; anything else is a subagent, and the id is the call that spawned it.
 */
export interface EventOrigin {
  parentToolUseId: string | null;
  /**
   * The innermost task open when this event happened, or null if the agent
   * was not inside one. Tasks are announced by the agent itself (see
   * `server/agent-prompt.md`), so this is null throughout a run that ignored
   * the instruction — which renders exactly as it did before tasks existed.
   */
  taskId: string | null;
}

/** An assistant text block. Usually markdown. */
export interface TextEvent extends EventOrigin {
  kind: "text";
  id: string;
  text: string;
  at: number;
}

/**
 * A tool_use block. Starts "pending" and is completed in place when its
 * tool_result arrives, so a call is visible while it is still running.
 */
export interface ToolEvent extends EventOrigin {
  kind: "tool";
  /** The tool_use_id — this is what the later tool_result matches on. */
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: ToolStatus;
  result?: string;
  at: number;
  endedAt?: number;
  /**
   * Shared by calls the agent issued in one message — that is, ones it ran in
   * parallel because they did not depend on each other. Null for a call that
   * went out on its own.
   */
  batchId: string | null;
}

/**
 * A logical unit of work the agent announced. Not part of the stream-json
 * protocol — it is reconstructed from markers in the assistant's own text,
 * and nests by start/end order like brackets.
 */
export interface TaskEvent extends EventOrigin {
  kind: "task";
  id: string;
  title: string;
  status: RunStatus;
  at: number;
  endedAt?: number;
}

export type TrajectoryEvent = TextEvent | ToolEvent | TaskEvent;

/** ------------------------------------------------------------------
 *  Rounds and runs
 *
 *  A *round* is one prompt and everything the agent did about it, ending
 *  with the final result event. A *run* is a conversation: the first round
 *  starts a session, and each follow-up resumes it, so the agent keeps its
 *  context from the previous turn.
 *  ------------------------------------------------------------------ */

export interface Round {
  id: string;
  /** What you asked for this round. */
  prompt: string;
  events: TrajectoryEvent[];
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  /** The session this round ran in, from the init event. */
  sessionId: string | null;
  /** Set when this round resumed an existing session rather than starting one. */
  resumedFrom: string | null;
  /** From this round's final result event. */
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  error?: string;
}

/**
 * Where a run's events came from. A recording replays a captured stream and
 * has no live session behind it, so it cannot be continued.
 */
export type RunSource =
  | { kind: "agent" }
  | { kind: "recording"; name: string };

export interface Run {
  id: string;
  source: RunSource;
  /** Derived from the opening prompt; shown in the history list. */
  title: string;
  /** The directory this run was launched against. Fixed for the run's life. */
  cwd: string;
  /** Latest known session id — what the next follow-up resumes. */
  sessionId: string | null;
  rounds: Round[];
  startedAt: number;
}

export type Theme = "light" | "dark";

/** Colour palette, independent of light/dark. */
export type Scheme = "slate" | "ember" | "forest" | "plum" | "mono";
export type ThemePreference = Theme | "system";
