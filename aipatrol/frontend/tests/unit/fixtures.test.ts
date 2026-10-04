import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dispatchEvent } from "../../src/agent/parseEvent";
import { sweepOpenTasks, sweepPending } from "../../src/lib/events";
import { toolTarget } from "../../src/lib/tools";
import { TaskStacks } from "../../src/lib/tasks";
import type { FlowItem, TreeNode } from "../../src/lib/tree";
import { buildTree, flowFor, groupSiblings, toolOnly } from "../../src/lib/tree";
import type { Round, RunStatus, TrajectoryEvent } from "../../src/types";

/**
 * The two captured runs, replayed through the real parser.
 *
 * The unit tests elsewhere build their trees from hand-written events, which
 * proves the logic but not the assumption underneath it: that a `--verbose`
 * stream really carries `parent_tool_use_id` where we expect it, and that a
 * fork's lanes really close before the main agent resumes. Only a capture can
 * say that, so these replay one and assert the shape that comes out.
 */

/** Stand in for useRuns: append events, complete calls in place, sweep. */
function replay(fixture: string): Round {
  const path = new URL(`../../fixtures/${fixture}`, import.meta.url);
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());

  let events: TrajectoryEvent[] = [];
  let sessionId: string | null = null;
  let status: RunStatus = "running";
  let costUsd: number | undefined;
  let n = 0;
  const tasks = new TaskStacks();

  for (const line of lines) {
    dispatchEvent(JSON.parse(line), {
      onSession: (id) => (sessionId = id),
      onText: (text, parentToolUseId) =>
        events.push({
          kind: "text",
          id: `e${++n}`,
          text,
          at: 0,
          parentToolUseId,
          taskId: tasks.current(parentToolUseId),
        }),
      onToolUse: ({ id, name, input, parentToolUseId, batchId }) =>
        events.push({
          kind: "tool",
          id,
          name,
          input,
          status: "pending",
          at: 0,
          parentToolUseId,
          taskId: tasks.current(parentToolUseId),
          batchId: batchId ?? null,
        }),
      onTaskStart: (title, parentToolUseId) => {
        const id = `task${++n}`;
        events.push({
          kind: "task",
          id,
          title,
          status: "running",
          at: 0,
          parentToolUseId,
          taskId: tasks.current(parentToolUseId),
        });
        tasks.push(parentToolUseId, id);
      },
      onTaskEnd: (parentToolUseId) => {
        const id = tasks.pop(parentToolUseId);
        if (!id) return;
        events = events.map((e) =>
          e.kind === "task" && e.id === id
            ? { ...e, status: "done" as const, endedAt: 0 }
            : e,
        );
      },
      onToolResult: ({ id, ok, content }) => {
        events = events.map((e) =>
          e.kind === "tool" && e.id === id
            ? { ...e, status: ok ? "ok" : "error", result: content, endedAt: 0 }
            : e,
        );
      },
      onDone: (done) => {
        status = "done";
        costUsd = done.costUsd;
        if (done.sessionId) sessionId = done.sessionId;
        events = sweepOpenTasks(sweepPending(events, "no result"), "done");
      },
      onError: () => {
        status = "error";
        events = sweepOpenTasks(sweepPending(events, "failed"), "error");
      },
    });
  }

  return {
    id: "d1",
    prompt: "captured",
    events,
    status,
    startedAt: 0,
    sessionId,
    resumedFrom: null,
    costUsd,
  };
}

const names = (nodes: TreeNode[]) =>
  nodes.map((node) =>
    node.event.kind === "tool"
      ? node.event.name
      : node.event.kind === "task"
        ? `task:${node.event.title}`
        : "text",
  );

const kinds = (items: FlowItem[]) => items.map((item) => item.kind);

describe("subagents-recombine.jsonl — lanes merge back into the spine", () => {
  const round = replay("subagents-recombine.jsonl");
  const roots = toolOnly(buildTree(round.events));

  it("replays to a finished round with a session id", () => {
    expect(round.status).toBe("done");
    expect(round.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(round.costUsd).toBeGreaterThan(0);
  });

  it("leaves no call pending and no event orphaned", () => {
    const pending = round.events.filter(
      (e) => e.kind === "tool" && e.status === "pending",
    );
    expect(pending).toEqual([]);

    // An orphan would surface as a root, so every non-null parent must name a
    // call we actually saw.
    const ids = new Set(round.events.map((e) => e.id));
    const orphans = round.events.filter(
      (e) => e.parentToolUseId && !ids.has(e.parentToolUseId),
    );
    expect(orphans).toEqual([]);
  });

  it("nests each subagent's work under the call that spawned it", () => {
    expect(names(roots)).toEqual(["Agent", "Agent", "Bash", "Bash", "Bash"]);
    expect(roots.slice(0, 2).map((n) => n.children.length)).toEqual([5, 3]);
    // The delegating call is the parent, and nothing nests under the rest.
    expect(roots.slice(2).every((n) => n.children.length === 0)).toBe(true);
  });

  it("groups the two delegations as one Tasks group", () => {
    const groups = groupSiblings(roots);
    expect(groups.map((g) => g.kind)).toEqual([
      "tasks",
      "single",
      "single",
      "single",
    ]);
  });

  it("forks two lanes and merges back — calls follow the fork", () => {
    const flow = flowFor([round]);
    expect(kinds(flow)).toEqual(["round", "fork", "call", "call", "call"]);

    const fork = flow[1];
    if (fork.kind !== "fork") throw new Error("expected a fork");

    // Each lane opens with its own Agent call, then that subagent's work.
    expect(fork.branches).toHaveLength(2);
    expect(fork.branches.map((b) => b.length)).toEqual([6, 4]);
    expect(
      fork.branches.every((b) => b[0].kind === "call" && b[0].call.name === "Agent"),
    ).toBe(true);

    // The merge: the main agent has work after the fork, which is what the
    // outline draws the lanes rejoining into.
    expect(flow.slice(2).every((i) => i.kind === "call")).toBe(true);
  });
});

describe("two-subagents.jsonl — the fork ends the run", () => {
  const round = replay("two-subagents.jsonl");
  const flow = flowFor([round]);

  it("forks two lanes with nothing after them to merge into", () => {
    expect(kinds(flow)).toEqual(["round", "fork"]);

    const fork = flow[1];
    if (fork.kind !== "fork") throw new Error("expected a fork");
    expect(fork.branches).toHaveLength(2);
  });

  it("still closes every call it opened", () => {
    expect(
      round.events.filter((e) => e.kind === "tool" && e.status === "pending"),
    ).toEqual([]);
  });
});

describe("tasks.jsonl — a real run that announced its tasks", () => {
  const round = replay("tasks.jsonl");
  const roots = toolOnly(buildTree(round.events));

  it("finishes, with the markers stripped from the prose", () => {
    expect(round.status).toBe("done");

    const prose = round.events
      .filter((e) => e.kind === "text")
      .map((e) => (e as { text: string }).text)
      .join("\n");
    expect(prose).not.toContain("[[task-start");
    expect(prose).not.toContain("[[task-end");
    expect(prose.length).toBeGreaterThan(0);
  });

  it("puts the run's work inside the task the agent announced", () => {
    expect(names(roots)).toEqual(["task:Map the repo layout"]);

    // Two calls of its own, then a delegation holding the subagent's work.
    const inside = roots[0].children;
    expect(names(inside)).toEqual(["Bash", "Bash", "Agent"]);
    expect(names(inside[2].children)).toEqual(["Bash", "Bash", "Bash"]);
  });

  // A task is only structure if it actually contains things.
  it("leaves nothing stranded outside the task", () => {
    const stranded = round.events.filter(
      (e) => e.kind === "tool" && e.taskId === null && e.parentToolUseId === null,
    );
    expect(stranded).toEqual([]);
  });

  it("closes every task it opened", () => {
    const open = round.events.filter(
      (e) => e.kind === "task" && e.status === "running",
    );
    expect(open).toEqual([]);
  });

  it("gives the task a lane of its own in the outline", () => {
    const [item] = flowFor([round]).filter((i) => i.kind !== "round");
    expect(item.kind).toBe("fork");
    const [lane] = (item as { branches: FlowItem[][] }).branches;
    expect(lane[0].kind).toBe("task");
  });
});

/**
 * The Ctrl+B prompt's own output. It is the one capture that contains every
 * shape at once, so it guards the whole renderer in a single fixture.
 */
describe("everything.jsonl — the test prompt's run", () => {
  const round = replay("everything.jsonl");
  const roots = toolOnly(buildTree(round.events));

  const walk = (nodes: TreeNode[]): TreeNode[] =>
    nodes.flatMap((n) => [n, ...walk(n.children)]);
  const all = () => walk(roots);

  it("finishes, with every task closed", () => {
    expect(round.status).toBe("done");
    const open = round.events.filter(
      (e) => e.kind === "task" && e.status === "running",
    );
    expect(open).toEqual([]);
  });

  it("nests a task inside a task", () => {
    const outer = all().find(
      (n) => n.event.kind === "task" && n.event.title.includes("Survey"),
    );
    expect(outer).toBeDefined();

    const innerTask = walk(outer!.children).find((n) => n.event.kind === "task");
    expect(innerTask?.event).toMatchObject({ kind: "task" });
    expect(innerTask!.children.length).toBeGreaterThan(0);
  });

  it("nests a subagent inside a subagent", () => {
    const agents = all().filter(
      (n) => n.event.kind === "tool" && n.event.name === "Agent",
    );
    expect(agents.length).toBeGreaterThanOrEqual(2);

    const nested = agents.filter((a) =>
      walk(a.children).some(
        (c) => c.event.kind === "tool" && c.event.name === "Agent",
      ),
    );
    expect(nested.length).toBeGreaterThan(0);
  });

  it("carries a real tool failure", () => {
    const failed = all().filter(
      (n) => n.event.kind === "tool" && n.event.status === "error",
    );
    expect(failed.length).toBe(1);
  });

  /**
   * Two lanes both labelled "Agent" say nothing about which is which — the
   * description is the only thing that tells them apart.
   */
  it("carries what each delegation was asked to do", () => {
    const agents = all().filter(
      (n) => n.event.kind === "tool" && n.event.name === "Agent",
    );

    const described = agents.map((a) =>
      toolTarget((a.event as { name: string }).name, (a.event as { input: Record<string, unknown> }).input),
    );

    expect(described).toContain("Summarise the docs");
    expect(described.every((d) => d.length > 0)).toBe(true);
  });

  it("puts two delegations on parallel lanes", () => {
    // The parallel pair sits inside the "Delegate" task, so the search has to
    // descend into lanes rather than reading only the top of the flow.
    const forks = (items: FlowItem[]): FlowItem[] =>
      items.flatMap((item) =>
        item.kind === "fork"
          ? [item, ...item.branches.flatMap(forks)]
          : [],
      );

    const parallel = forks(flowFor([round])).filter(
      (f) => (f as { branches: unknown[] }).branches.length > 1,
    );
    expect(parallel).toHaveLength(1);
    expect((parallel[0] as { branches: FlowItem[][] }).branches).toHaveLength(2);
  });
});
