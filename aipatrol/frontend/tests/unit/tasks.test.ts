import { describe, expect, it } from "vitest";
import { dispatchEvent } from "../../src/agent/parseEvent";
import { sweepOpenTasks } from "../../src/lib/events";
import { TaskStacks, hasTaskMarkers, splitTaskMarkers } from "../../src/lib/tasks";
import {
  ancestorsOf,
  buildTree,
  containerOf,
  flowNodes,
  groupSiblings,
  toolOnly,
} from "../../src/lib/tree";
import type { TreeNode } from "../../src/lib/tree";
import { handlers, task, text, tool } from "../helpers";

/**
 * Tasks are not part of the stream-json protocol. They exist only because the
 * agent is asked to bracket its work with markers in its own prose — so every
 * one of these tests is really about what happens when the agent gets that
 * slightly wrong, which a captured probe showed it does.
 */

describe("splitTaskMarkers", () => {
  it("leaves ordinary prose alone", () => {
    expect(splitTaskMarkers("Just some text.")).toEqual([
      { kind: "text", text: "Just some text." },
    ]);
    expect(hasTaskMarkers("Just some text.")).toBe(false);
  });

  it("pulls markers out and keeps the prose either side, in order", () => {
    const segments = splitTaskMarkers(
      ["Before.", "[[task-start Read the parser]]", "Inside.", "[[task-end]]", "After."].join("\n"),
    );

    expect(segments).toEqual([
      { kind: "text", text: "Before." },
      { kind: "start", title: "Read the parser" },
      { kind: "text", text: "Inside." },
      { kind: "end" },
      { kind: "text", text: "After." },
    ]);
  });

  // A marker reaching the page as literal text would be the visible failure.
  it("emits no prose for a block that is only a marker", () => {
    expect(splitTaskMarkers("[[task-start Only this]]")).toEqual([
      { kind: "start", title: "Only this" },
    ]);
  });

  it("tolerates surrounding whitespace on the marker line", () => {
    expect(splitTaskMarkers("   [[task-end]]   ")).toEqual([{ kind: "end" }]);
  });

  // Only a line that is *nothing but* a marker counts, so prose that happens
  // to mention one is still prose.
  it("ignores a marker that shares its line with other text", () => {
    const block = "I will emit [[task-start Something]] shortly.";
    expect(splitTaskMarkers(block)).toEqual([{ kind: "text", text: block }]);
  });

  it("clips a title that runs away", () => {
    const long = "x".repeat(200);
    const [segment] = splitTaskMarkers(`[[task-start ${long}]]`);
    expect(segment).toMatchObject({ kind: "start" });
    expect((segment as { title: string }).title.length).toBeLessThanOrEqual(80);
  });
});

describe("TaskStacks", () => {
  it("nests by order, innermost first", () => {
    const stacks = new TaskStacks();
    expect(stacks.current(null)).toBeNull();

    stacks.push(null, "outer");
    expect(stacks.current(null)).toBe("outer");

    stacks.push(null, "inner");
    expect(stacks.current(null)).toBe("inner");

    expect(stacks.pop(null)).toBe("inner");
    expect(stacks.current(null)).toBe("outer");
  });

  // A subagent brackets its own work; its markers must not close the main
  // agent's task, and vice versa.
  it("keeps each agent context's brackets to itself", () => {
    const stacks = new TaskStacks();
    stacks.push(null, "main-task");
    stacks.push("call_agent", "sub-task");

    expect(stacks.current(null)).toBe("main-task");
    expect(stacks.current("call_agent")).toBe("sub-task");

    expect(stacks.pop("call_agent")).toBe("sub-task");
    expect(stacks.current("call_agent")).toBeNull();
    expect(stacks.current(null)).toBe("main-task");
  });

  it("refuses to pop what it does not have", () => {
    expect(new TaskStacks().pop(null)).toBeNull();
  });
});

describe("dispatchEvent — markers become task handlers", () => {
  const assistant = (text: string, parent: string | null = null) => ({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "text", text }] },
  });

  it("turns markers into starts and ends, and keeps the prose", () => {
    const h = handlers();
    dispatchEvent(
      assistant(["[[task-start Survey]]", "Looking now.", "[[task-end]]"].join("\n")),
      h,
    );

    expect(h.onTaskStart.mock.calls).toEqual([["Survey", null]]);
    expect(h.onText.mock.calls).toEqual([["Looking now.", null]]);
    expect(h.onTaskEnd.mock.calls).toEqual([[null]]);
  });

  it("carries the subagent that announced the task", () => {
    const h = handlers();
    dispatchEvent(assistant("[[task-start Inner work]]", "call_agent"), h);
    expect(h.onTaskStart.mock.calls).toEqual([["Inner work", "call_agent"]]);
  });

  it("never lets a marker through as displayable text", () => {
    const h = handlers();
    dispatchEvent(assistant("[[task-start A]]\n[[task-end]]"), h);
    expect(h.onText).not.toHaveBeenCalled();
  });
});

describe("containment", () => {
  it("puts an event in its task before its subagent", () => {
    const inTask = tool({ parentToolUseId: "call_agent", taskId: "task_1" });
    expect(containerOf(inTask)).toBe("task_1");

    const inAgentOnly = tool({ parentToolUseId: "call_agent", taskId: null });
    expect(containerOf(inAgentOnly)).toBe("call_agent");

    expect(containerOf(tool())).toBeNull();
  });

  it("nests calls under the task that was open", () => {
    const t = task({ id: "task_1" });
    const inside = tool({ id: "call_a", taskId: "task_1" });
    const after = tool({ id: "call_b" });

    const tree = buildTree([t, inside, after]);
    expect(tree.map((n) => n.event.id)).toEqual(["task_1", "call_b"]);
    expect(tree[0].children.map((n) => n.event.id)).toEqual(["call_a"]);
  });

  // Tasks within tasks, and tasks within a subagent's tasks.
  it("nests to any depth, across agent contexts", () => {
    const events = [
      task({ id: "t_outer" }),
      task({ id: "t_inner", taskId: "t_outer" }),
      tool({ id: "call_agent", name: "Agent", taskId: "t_inner" }),
      task({ id: "t_sub", parentToolUseId: "call_agent" }),
      tool({ id: "call_deep", parentToolUseId: "call_agent", taskId: "t_sub" }),
    ];

    const tree = buildTree(events);
    const outer = tree[0];
    expect(outer.event.id).toBe("t_outer");

    const inner = outer.children[0];
    expect(inner.event.id).toBe("t_inner");

    const agent = inner.children[0];
    expect(agent.event.id).toBe("call_agent");

    const sub = agent.children[0];
    expect(sub.event.id).toBe("t_sub");
    expect(sub.children.map((n) => n.event.id)).toEqual(["call_deep"]);
  });

  // The whole point of the design: a run whose agent ignored the instruction
  // renders exactly as it did before tasks existed.
  it("is flat when nothing announced a task", () => {
    const events = [text(), tool(), text()];
    expect(buildTree(events).map((n) => n.event.id)).toEqual(
      events.map((e) => e.id),
    );
  });
});

describe("the outline", () => {
  const lane = (nodes: TreeNode[]) => flowNodes(toolOnly(nodes));

  it("keeps tasks as structure beside calls", () => {
    const tree = buildTree([
      task({ id: "task_1" }),
      text({ id: "prose", taskId: "task_1" }),
      tool({ id: "call_a", taskId: "task_1" }),
    ]);

    // Prose is dialogue, not structure — it does not reach the outline.
    const [item] = lane(tree);
    expect(item.kind).toBe("fork");
    const branch = (item as { branches: { kind: string }[][] }).branches[0];
    expect(branch.map((b) => b.kind)).toEqual(["task", "call"]);
  });

  it("gives a task its own lane, one branch — tasks are sequential", () => {
    const tree = buildTree([task({ id: "a" }), task({ id: "b" })]);
    const items = lane(tree);

    expect(items.map((i) => i.kind)).toEqual(["fork", "fork"]);
    for (const item of items) {
      expect((item as { branches: unknown[] }).branches).toHaveLength(1);
    }
  });
});

describe("sweepOpenTasks", () => {
  // The probe run left its last task unclosed, so this is not hypothetical.
  it("closes a task the agent forgot to end", () => {
    const events = [
      task({ id: "a", status: "running" }),
      task({ id: "b", status: "done" }),
    ];
    const swept = sweepOpenTasks(events, "done");

    expect(swept.map((e) => e.kind === "task" && e.status)).toEqual([
      "done",
      "done",
    ]);
    expect((swept[0] as { endedAt?: number }).endedAt).toBeGreaterThan(0);
  });

  it("marks open work failed when the round failed", () => {
    const swept = sweepOpenTasks([task({ id: "a", status: "running" })], "error");
    expect(swept[0]).toMatchObject({ status: "error" });
  });

  it("leaves finished tasks and non-tasks alone", () => {
    const done = task({ id: "a", status: "done", endedAt: 5 });
    const call = tool({ id: "c" });
    expect(sweepOpenTasks([done, call], "error")).toEqual([done, call]);
  });
});

describe("ancestorsOf", () => {
  /**
   * A collapsed section is not rendered at all, so jumping to something
   * inside one must open every container above it. Miss a link in the chain
   * and the click silently does nothing.
   */
  it("walks the whole chain, innermost first", () => {
    const events = [
      task({ id: "t_outer" }),
      tool({ id: "call_agent", name: "Agent", taskId: "t_outer" }),
      task({ id: "t_sub", parentToolUseId: "call_agent" }),
      tool({ id: "call_deep", parentToolUseId: "call_agent", taskId: "t_sub" }),
    ];

    expect(ancestorsOf(events, "call_deep")).toEqual([
      "t_sub",
      "call_agent",
      "t_outer",
    ]);
  });

  it("returns nothing for an event at the top level", () => {
    expect(ancestorsOf([tool({ id: "a" })], "a")).toEqual([]);
  });

  it("is empty for an id it has never seen", () => {
    expect(ancestorsOf([tool({ id: "a" })], "ghost")).toEqual([]);
  });

  // A malformed stream could name a cycle; walking it must not hang.
  it("stops rather than looping on a cycle", () => {
    const a = task({ id: "a", taskId: "b" });
    const b = task({ id: "b", taskId: "a" });
    expect(ancestorsOf([a, b], "a")).toEqual(["b"]);
  });
});

describe("parallel tool calls", () => {
  /**
   * Several tool_use blocks in one assistant message is the only signal the
   * stream carries that calls ran at once, so a shared batchId is what makes
   * them siblings on parallel lanes rather than a sequence.
   */
  it("groups a batch onto parallel lanes", () => {
    const nodes = buildTree([
      tool({ id: "a", batchId: "b1" }),
      tool({ id: "b", batchId: "b1" }),
      tool({ id: "c" }),
    ]);

    const [batch, alone] = groupSiblings(nodes);
    expect(batch.kind).toBe("parallel");
    expect((batch as { nodes: TreeNode[] }).nodes.map((n) => n.event.id)).toEqual([
      "a",
      "b",
    ]);
    expect(alone.kind).toBe("single");
  });

  it("keeps separate batches apart", () => {
    const nodes = buildTree([
      tool({ id: "a", batchId: "b1" }),
      tool({ id: "b", batchId: "b1" }),
      tool({ id: "c", batchId: "b2" }),
      tool({ id: "d", batchId: "b2" }),
    ]);

    const groups = groupSiblings(nodes);
    expect(groups.map((g) => g.kind)).toEqual(["parallel", "parallel"]);
  });

  // A batch that ends up split across containers leaves one call on its own,
  // and one call is not a parallel group.
  it("treats a batch of one as an ordinary call", () => {
    const nodes = buildTree([tool({ id: "a", batchId: "b1" })]);
    expect(groupSiblings(nodes)[0].kind).toBe("single");
  });

  it("gives a batch one lane per call in the outline", () => {
    const nodes = buildTree([
      tool({ id: "a", batchId: "b1" }),
      tool({ id: "b", batchId: "b1" }),
    ]);

    const [item] = flowNodes(toolOnly(nodes));
    expect(item.kind).toBe("fork");
    expect((item as { branches: unknown[] }).branches).toHaveLength(2);
  });
});
