import { describe, expect, it } from "vitest";
import {
  buildTree,
  countCalls,
  countEvents,
  countFailures,
  groupSiblings,
  hasSubagents,
  outlineSections,
  splitConclusion,
  toolOnly,
} from "../../src/lib/tree";
import type { TreeNode } from "../../src/lib/tree";
import { round, text, tool } from "../helpers";

const ids = (nodes: TreeNode[]) => nodes.map((n) => n.event.id);

describe("buildTree", () => {
  it("returns a flat run of roots when nothing delegated", () => {
    const events = [text(), tool(), text()];
    const tree = buildTree(events);
    expect(ids(tree)).toEqual(events.map((e) => e.id));
    expect(hasSubagents(tree)).toBe(false);
  });

  it("nests a subagent's events under the call that spawned it", () => {
    const call = tool({ id: "call_a", name: "Agent" });
    const inner = tool({ id: "call_b", parentToolUseId: "call_a" });
    const said = text({ id: "t_inner", parentToolUseId: "call_a" });

    const tree = buildTree([call, inner, said, text({ id: "t_main" })]);

    expect(ids(tree)).toEqual(["call_a", "t_main"]);
    expect(ids(tree[0].children)).toEqual(["call_b", "t_inner"]);
    expect(hasSubagents(tree)).toBe(true);
  });

  it("nests to any depth", () => {
    const tree = buildTree([
      tool({ id: "a", name: "Agent" }),
      tool({ id: "b", name: "Agent", parentToolUseId: "a" }),
      tool({ id: "c", parentToolUseId: "b" }),
    ]);
    expect(ids(tree[0].children[0].children)).toEqual(["c"]);
  });

  // Losing events is worse than showing them flat.
  it("promotes an orphan to a root rather than dropping it", () => {
    const tree = buildTree([tool({ id: "b", parentToolUseId: "never-seen" })]);
    expect(ids(tree)).toEqual(["b"]);
  });

  it("does not let an event parent itself", () => {
    const tree = buildTree([tool({ id: "a", parentToolUseId: "a" })]);
    expect(ids(tree)).toEqual(["a"]);
    expect(tree[0].children).toEqual([]);
  });

  it("preserves arrival order among siblings", () => {
    const tree = buildTree([
      tool({ id: "p", name: "Agent" }),
      tool({ id: "one", parentToolUseId: "p" }),
      tool({ id: "two", parentToolUseId: "p" }),
      tool({ id: "three", parentToolUseId: "p" }),
    ]);
    expect(ids(tree[0].children)).toEqual(["one", "two", "three"]);
  });

  it("is empty for no events", () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe("splitConclusion", () => {
  it("takes only a trailing run of text as the verdict", () => {
    const tree = buildTree([
      text({ id: "t1" }),
      tool({ id: "c1" }),
      text({ id: "t2" }),
      text({ id: "t3" }),
    ]);
    const { work, conclusion } = splitConclusion(tree);
    expect(ids(work)).toEqual(["t1", "c1"]);
    expect(ids(conclusion)).toEqual(["t2", "t3"]);
  });

  // Text followed by more calls is commentary along the way, not a verdict.
  it("keeps commentary in the work when a call follows it", () => {
    const tree = buildTree([text({ id: "t1" }), tool({ id: "c1" })]);
    const { work, conclusion } = splitConclusion(tree);
    expect(ids(work)).toEqual(["t1", "c1"]);
    expect(conclusion).toEqual([]);
  });

  it("handles a round that is all conclusion, and one that is empty", () => {
    const allText = buildTree([text({ id: "t1" }), text({ id: "t2" })]);
    expect(ids(splitConclusion(allText).conclusion)).toEqual(["t1", "t2"]);
    expect(splitConclusion([])).toEqual({ work: [], conclusion: [] });
  });
});

describe("toolOnly", () => {
  it("drops text but keeps the tree shape", () => {
    const tree = buildTree([
      text({ id: "t_main" }),
      tool({ id: "call_a", name: "Agent" }),
      text({ id: "t_inner", parentToolUseId: "call_a" }),
      tool({ id: "call_b", parentToolUseId: "call_a" }),
    ]);
    const outline = toolOnly(tree);
    expect(ids(outline)).toEqual(["call_a"]);
    expect(ids(outline[0].children)).toEqual(["call_b"]);
  });

  it("keeps a delegation whose subagent only talked", () => {
    const tree = buildTree([
      tool({ id: "a", name: "Agent" }),
      text({ id: "t_inner", parentToolUseId: "a" }),
    ]);
    const outline = toolOnly(tree);
    expect(ids(outline)).toEqual(["a"]);
    expect(outline[0].children).toEqual([]);
  });
});

describe("counting", () => {
  const tree = buildTree([
    text({ id: "t_main" }),
    tool({ id: "a", name: "Agent" }),
    tool({ id: "b", parentToolUseId: "a", status: "error" }),
    text({ id: "t_inner", parentToolUseId: "a" }),
    tool({ id: "c", status: "pending" }),
  ]);

  it("counts calls at any depth", () => {
    expect(countCalls(tree)).toBe(3);
  });

  it("counts failures at any depth", () => {
    expect(countFailures(tree)).toBe(1);
  });

  it("counts every node, text included", () => {
    expect(countEvents(tree)).toBe(5);
  });

  it("counts nothing for an empty tree", () => {
    expect(countCalls([])).toBe(0);
    expect(countFailures([])).toBe(0);
    expect(countEvents([])).toBe(0);
  });
});

describe("outlineSections", () => {
  it("gives one section per round, calls only", () => {
    const sections = outlineSections([
      round({
        id: "d1",
        prompt: "first",
        status: "done",
        events: [text(), tool({ id: "a" })],
      }),
      round({ id: "d2", prompt: "second", status: "running", events: [] }),
    ]);

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ roundId: "d1", prompt: "first", status: "done" });
    expect(ids(sections[0].nodes)).toEqual(["a"]);
    expect(sections[1].nodes).toEqual([]);
  });
});

describe("groupSiblings", () => {
  it("groups consecutive delegations under one heading", () => {
    const nodes = buildTree([
      tool({ id: "a", name: "Agent" }),
      tool({ id: "b", name: "Task" }),
    ]);
    const groups = groupSiblings(nodes);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("tasks");
    expect(groups[0].kind === "tasks" && ids(groups[0].nodes)).toEqual([
      "a",
      "b",
    ]);
  });

  // The heading earns its place at two; one delegation is just a call.
  it("leaves a lone delegation a plain call", () => {
    const groups = groupSiblings(buildTree([tool({ id: "a", name: "Agent" })]));
    expect(groups).toEqual([
      expect.objectContaining({ kind: "single" }),
    ]);
  });

  it("breaks a group when an ordinary call interrupts", () => {
    const groups = groupSiblings(
      buildTree([
        tool({ id: "a", name: "Agent" }),
        tool({ id: "b", name: "Agent" }),
        tool({ id: "c", name: "Bash" }),
        tool({ id: "d", name: "Agent" }),
        tool({ id: "e", name: "Agent" }),
      ]),
    );
    expect(groups.map((g) => g.kind)).toEqual(["tasks", "single", "tasks"]);
  });

  it("leaves a list with no delegations untouched", () => {
    const nodes = buildTree([text(), tool({ name: "Bash" })]);
    const groups = groupSiblings(nodes);
    expect(groups.map((g) => g.kind)).toEqual(["single", "single"]);
  });

  it("is empty for no siblings", () => {
    expect(groupSiblings([])).toEqual([]);
  });
});
