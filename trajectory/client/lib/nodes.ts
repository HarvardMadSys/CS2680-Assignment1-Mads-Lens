import type { Frame, Node, ToolNode } from "./types";

/** One assistant message: the unit the tree shows as a node. */
export type Step = {
  id: string;
  ts: number;
  text?: Frame;
  thinking?: Frame;
  tools: ToolNode[];
  branches: ToolNode[];      // tool calls that spawned a subagent
  status: "pend" | "ok" | "err";
};

/**
 * Group a turn's nodes by the assistant message they came from. Runs recorded before frames
 * carried a `group` fall back to: a text block opens a step, tool calls join it, and a tool that
 * starts after the previous one already returned opens the next.
 */
export function steps(nodes: Node[], prefix: string): Step[] {
  const out: Step[] = [];
  let group: number | undefined;
  let prevEnd = 0;

  for (const n of nodes) {
    const f: Frame = n.type === "tool" ? n.call : n.frame;
    let cur = out[out.length - 1];
    const fresh = !cur
      || (f.group != null && f.group !== group)
      || (f.group == null && (n.type === "tool" ? f.ts > prevEnd + 0.05 : cur.tools.length > 0));
    if (fresh) {
      cur = { id: `${prefix}:${out.length}`, ts: f.ts, tools: [], branches: [], status: "ok" };
      out.push(cur);
      group = f.group;
    }

    if (n.type === "tool") {
      cur.tools.push(n);
      if (n.children.length) cur.branches.push(n);
      prevEnd = n.result?.ts ?? f.ts;
      if (!n.result) cur.status = "pend";
      else if (n.result.is_error && cur.status !== "pend") cur.status = "err";
    } else if (n.type === "thinking") {
      cur.thinking = join(cur.thinking, n.frame);
    } else {
      cur.text = join(cur.text, n.frame);
    }
  }
  return out;
}

/** One assistant message can carry several text blocks; keep every one of them. */
const join = (a: Frame | undefined, b: Frame): Frame =>
  a ? { ...a, text: `${a.text ?? ""}\n\n${b.text ?? ""}`.trim() } : b;

export const branchSize = (t: ToolNode): number =>
  t.children.reduce((n, c) => n + 1 + (c.type === "tool" ? branchSize(c) : 0), 0);
