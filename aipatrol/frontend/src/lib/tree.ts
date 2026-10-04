import { isDelegating } from "./tools";
import type {
  Round,
  RunStatus,
  TaskEvent,
  ToolEvent,
  TrajectoryEvent,
} from "../types";

/**
 * A trajectory is not always flat. When the agent delegates, every event the
 * subagent emits carries the id of the tool call that spawned it, so the
 * stream is really a tree that arrives depth-first.
 */
export interface TreeNode {
  event: TrajectoryEvent;
  children: TreeNode[];
}

/**
 * Group events under the call that spawned them. Events from the main agent
 * (parentToolUseId === null) are roots; order is preserved throughout, so a
 * run with no subagents comes back as a flat list of roots.
 */
/**
 * What an event hangs off: the task it happened inside, or failing that the
 * subagent that emitted it. Tasks win because a task is always nested *within*
 * its agent context, never across one.
 */
export function containerOf(event: TrajectoryEvent): string | null {
  return event.taskId ?? event.parentToolUseId;
}

/**
 * The chain of containers above an event, innermost first — every task,
 * subagent and task-within-a-subagent it sits inside.
 *
 * Jumping to a call means opening all of these: a collapsed section is not
 * merely hidden, it is not rendered, so there would be nothing to scroll to.
 */
export function ancestorsOf(
  events: TrajectoryEvent[],
  id: string,
): string[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const chain: string[] = [];
  const seen = new Set<string>([id]);

  let current = byId.get(id);
  while (current) {
    const parentId = containerOf(current);
    // A malformed stream could name a cycle; stop rather than spin.
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    chain.push(parentId);
    current = byId.get(parentId);
  }

  return chain;
}

export function buildTree(events: TrajectoryEvent[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const event of events) {
    nodes.set(event.id, { event, children: [] });
  }

  const roots: TreeNode[] = [];
  for (const event of events) {
    const node = nodes.get(event.id);
    if (!node) continue;

    const containerId = containerOf(event);
    const parent = containerId ? nodes.get(containerId) : undefined;

    // An orphan — a parent we never saw — becomes a root rather than
    // disappearing. Losing events is worse than showing them flat.
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}

/**
 * Separate a round's closing assistant text from the work that produced it.
 * Only a *trailing* run of text nodes counts as the conclusion — text
 * followed by more tool calls is commentary along the way, not a verdict.
 */
export function splitConclusion(nodes: TreeNode[]): {
  work: TreeNode[];
  conclusion: TreeNode[];
} {
  let i = nodes.length;
  while (i > 0 && nodes[i - 1].event.kind === "text") i--;
  return { work: nodes.slice(0, i), conclusion: nodes.slice(i) };
}

/**
 * The outline is the tool calls only, keeping the tree shape — text blocks
 * are the dialogue, calls are the structure. A call that spawned subagents
 * keeps them as children, and sibling delegations stay siblings.
 */
export function toolOnly(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .filter((n) => n.event.kind === "tool" || n.event.kind === "task")
    .map((n) => ({ event: n.event, children: toolOnly(n.children) }));
}

/** One round's worth of outline, so the whole run can be surveyed at once. */
export interface OutlineSection {
  roundId: string;
  prompt: string;
  status: RunStatus;
  nodes: TreeNode[];
}

export function outlineSections(rounds: Round[]): OutlineSection[] {
  return rounds.map((round) => ({
    roundId: round.id,
    prompt: round.prompt,
    status: round.status,
    nodes: toolOnly(buildTree(round.events)),
  }));
}

/** Every call in the tree, at any depth. */
export function countCalls(nodes: TreeNode[]): number {
  return nodes.reduce(
    (n, node) =>
      n + (node.event.kind === "tool" ? 1 : 0) + countCalls(node.children),
    0,
  );
}

/** Failed calls, at any depth — what the outline header warns about. */
export function countFailures(nodes: TreeNode[]): number {
  return nodes.reduce(
    (n, node) =>
      n +
      (node.event.kind === "tool" && node.event.status === "error" ? 1 : 0) +
      countFailures(node.children),
    0,
  );
}

/** Every descendant, not just direct children. */
export function countEvents(nodes: TreeNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countEvents(node.children), 0);
}

/** Does this trajectory use subagents at all? */
export function hasSubagents(nodes: TreeNode[]): boolean {
  return nodes.some((n) => n.children.length > 0);
}

/**
 * Split a sibling list into runs of consecutive delegating calls and
 * everything else, so two subagents launched together read as one group of
 * tasks rather than two unrelated calls.
 */
export type NodeGroup =
  | { kind: "single"; node: TreeNode }
  | { kind: "tasks"; nodes: TreeNode[] }
  | { kind: "parallel"; nodes: TreeNode[] };

/**
 * What makes two adjacent siblings belong together:
 *   - the same batch — the agent issued them in one message, so they ran at
 *     the same time. This is the only evidence the stream gives of that.
 *   - both delegating — two subagents launched back to back.
 * Anything else stands alone.
 */
function groupKey(node: TreeNode): { key: string; kind: "tasks" | "parallel" } | null {
  if (node.event.kind !== "tool") return null;
  if (node.event.batchId) {
    return { key: `batch:${node.event.batchId}`, kind: "parallel" };
  }
  if (isDelegating(node.event.name)) {
    return { key: "delegating", kind: "tasks" };
  }
  return null;
}

export function groupSiblings(nodes: TreeNode[]): NodeGroup[] {
  const groups: NodeGroup[] = [];
  let openKey: string | null = null;

  for (const node of nodes) {
    const grouping = groupKey(node);
    const last = groups.at(-1);

    if (grouping && openKey === grouping.key && last && last.kind !== "single") {
      last.nodes.push(node);
      continue;
    }

    if (grouping) {
      groups.push({ kind: grouping.kind, nodes: [node] });
      openKey = grouping.key;
    } else {
      groups.push({ kind: "single", node });
      openKey = null;
    }
  }

  // A group of one is just a call; the heading earns its place at two.
  return groups.map((g) =>
    g.kind !== "single" && g.nodes.length === 1
      ? { kind: "single" as const, node: g.nodes[0] }
      : g,
  );
}

/** ------------------------------------------------------------------
 *  Flow layout for the outline
 *
 *  The outline is drawn as a spine running top to bottom. Sequential calls
 *  stack along it; a delegation opens a lane, and several delegations
 *  launched together open parallel lanes that fork off the spine and merge
 *  back into it.
 *  ------------------------------------------------------------------ */

export type FlowItem =
  | { kind: "round"; id: string; prompt: string; status: RunStatus }
  | { kind: "call"; id: string; call: ToolEvent }
  | { kind: "task"; id: string; task: TaskEvent }
  | { kind: "fork"; id: string; branches: FlowItem[][] };

/** One lane: the delegating call, then everything it did. */
function laneFor(node: TreeNode): FlowItem[] {
  const head: FlowItem[] =
    node.event.kind === "tool"
      ? [{ kind: "call", id: node.event.id, call: node.event }]
      : node.event.kind === "task"
        ? [{ kind: "task", id: node.event.id, task: node.event }]
        : [];
  return [...head, ...flowNodes(node.children)];
}

export function flowNodes(nodes: TreeNode[]): FlowItem[] {
  const items: FlowItem[] = [];

  for (const group of groupSiblings(nodes)) {
    if (group.kind !== "single") {
      // Work that happened at the same time — parallel lanes.
      items.push({
        kind: "fork",
        id: group.nodes[0].event.id,
        branches: group.nodes.map(laneFor),
      });
      continue;
    }

    const node = group.node;

    // A task opens a lane of its own — sequential, so one branch, not two.
    if (node.event.kind === "task") {
      items.push({ kind: "fork", id: node.event.id, branches: [laneFor(node)] });
      continue;
    }

    if (node.event.kind !== "tool") continue;

    if (node.children.length === 0) {
      items.push({ kind: "call", id: node.event.id, call: node.event });
    } else {
      // A lone delegation still opens a lane, so its work reads as its own.
      items.push({ kind: "fork", id: node.event.id, branches: [laneFor(node)] });
    }
  }

  return items;
}

/** The whole run as one flow, with each round's prompt marking its start. */
export function flowFor(rounds: Round[]): FlowItem[] {
  return rounds.flatMap((round) => [
    {
      kind: "round" as const,
      id: round.id,
      prompt: round.prompt,
      status: round.status,
    },
    ...flowNodes(toolOnly(buildTree(round.events))),
  ]);
}

/** Every pill a flow would draw, including inside its lanes. */
export function countFlowItems(items: FlowItem[]): number {
  return items.reduce(
    (n, item) =>
      n +
      (item.kind === "fork"
        ? item.branches.reduce((m, lane) => m + countFlowItems(lane), 0)
        : 1),
    0,
  );
}
