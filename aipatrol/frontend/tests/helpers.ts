import { vi } from "vitest";
import type { Mock } from "vitest";
import type { RunHandlers } from "../src/agent/driver";
import type { Round, Run, TaskEvent, TextEvent, ToolEvent } from "../src/types";

/**
 * Builders for the shapes the app passes around. Every field has a default,
 * so a test only states what it is actually about.
 */

let n = 0;
const id = (p: string) => `${p}${++n}`;

export function text(over: Partial<TextEvent> = {}): TextEvent {
  return {
    kind: "text",
    id: id("t"),
    text: "hello",
    at: 1_000,
    parentToolUseId: null,
    taskId: null,
    ...over,
  };
}

export function tool(over: Partial<ToolEvent> = {}): ToolEvent {
  return {
    kind: "tool",
    id: id("call_"),
    name: "Read",
    input: { file_path: "/tmp/a.txt" },
    status: "ok",
    at: 1_000,
    parentToolUseId: null,
    taskId: null,
    batchId: null,
    ...over,
  };
}

export function task(over: Partial<TaskEvent> = {}): TaskEvent {
  return {
    kind: "task",
    id: id("task_"),
    title: "Do a unit of work",
    status: "done",
    at: 1_000,
    parentToolUseId: null,
    taskId: null,
    ...over,
  };
}

export function round(over: Partial<Round> = {}): Round {
  return {
    id: id("d"),
    prompt: "do the thing",
    events: [],
    status: "done",
    startedAt: 1_000,
    sessionId: "sess-1",
    resumedFrom: null,
    ...over,
  };
}

export function run(over: Partial<Run> = {}): Run {
  return {
    id: id("r"),
    source: { kind: "agent" },
    title: "do the thing",
    cwd: "/tmp/scratch",
    sessionId: "sess-1",
    rounds: [],
    startedAt: 1_000,
    ...over,
  };
}

/**
 * The driver's callbacks, as spies — a test plays the agent by calling them
 * and then reads back what the code under test did with them.
 */
export type MockHandlers = { [K in keyof RunHandlers]: Mock<RunHandlers[K]> };

export function handlers(): MockHandlers {
  return {
    onSession: vi.fn(),
    onText: vi.fn(),
    onToolUse: vi.fn(),
    onToolResult: vi.fn(),
    onTaskStart: vi.fn(),
    onTaskEnd: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  };
}

/** Nothing at all reached the handlers. */
export function sawNothing(h: MockHandlers): boolean {
  return Object.values(h).every((fn) => fn.mock.calls.length === 0);
}
