import { branchSize, steps, type Step } from "./nodes";
import { toolLine } from "./format";
import { build } from "./tree";
import type { Frame, ToolNode, Turn } from "./types";

export type TNode = {
  id: string;
  kind: "prompt" | "text" | "tool" | "summary";
  turn: Turn;
  frame?: Frame;        // text nodes: what the model said, or thought
  think?: boolean;
  tool?: ToolNode;
  label: string;
  status: "ok" | "err" | "pend" | "note";
  children: TNode[];
  sub?: boolean;   // the head of a subagent's sequence: the one child that starts a new column
  x: number;   // column; the vertical position needs measured heights, so TreeView owns it
  cols?: number;   // roots only: how many extra columns this turn needs, so it can size its own
  subs: number;
};

/**
 * Build the run as a node-link tree. A turn is the flat sequence of what happened — the model
 * thinks, says something, then calls tools — and a call that delegates hangs the subagent's own
 * sequence off to the right. A parent sits in its first child's column, so the trunk never wanders
 * and every branch claims a fresh column of its own.
 */
export function tree(turns: Turn[]): { roots: TNode[]; cols: number } {
  const roots: TNode[] = [];
  let col = 0;

  const seq = (list: Step[], turn: Turn): TNode[] => {
    const out: TNode[] = [];
    for (const s of list) {
      if (s.thinking)
        out.push(node({ id: `${s.id}:t`, kind: "text", turn, frame: s.thinking, think: true,
                        label: s.thinking.text, status: "note" }));
      if (s.text)
        out.push(node({ id: `${s.id}:s`, kind: "text", turn, frame: s.text, label: s.text.text,
                        status: "note" }));
      for (const t of s.tools) {
        const n = node({ id: `${turn.runId}/${t.id}`, kind: "tool", turn, tool: t,
                         label: toolLine(t),
                         subs: t.children.length ? branchSize(t) : 0,
                         status: !t.result ? "pend" : t.result.is_error ? "err" : "ok" });
        if (t.children.length) {
          n.children = link(seq(steps(t.children, `${turn.runId}/${t.id}`), turn), []);
          if (n.children[0]) n.children[0].sub = true;
        }
        out.push(n);
      }
    }
    return out;
  };

  /** Chain a sequence: a node's first child is what happened next, after any branch it spawned. */
  const link = (ns: TNode[], tail: TNode[]): TNode[] => {
    for (let i = ns.length - 1; i >= 0; i--)
      ns[i].children = [...(i + 1 < ns.length ? [ns[i + 1]] : tail), ...ns[i].children];
    return ns[0] ? [ns[0]] : tail;
  };

  for (const turn of turns) {
    const end = node({ id: `${turn.runId}:end`, kind: "summary", turn, label: turn.status,
                       status: turn.status === "failed" ? "err" : "note" });
    const root = node({ id: `${turn.runId}:p`, kind: "prompt", turn, label: turn.prompt, status: "note" });
    root.children = link(seq(steps(build(turn.frames), turn.runId), turn), [end]);
    roots.push(root);
  }

  let widest = 0;
  for (const r of roots) {
    col = 0;            // every turn's trunk starts at column 0
    place(r, 0);
    r.cols = col;       // turns never share horizontal space, so each sizes its columns alone
    widest = Math.max(widest, col);
  }
  return { roots, cols: widest };

  /** A node keeps its column; only a branch moves right. Branches claim columns as they appear
   *  down the trunk, which means before the trunk below them — the other order crosses the two. */
  function place(n: TNode, x: number) {
    n.x = x;
    for (const c of n.children) if (c.sub) place(c, ++col);
    const next = n.children.find((c) => !c.sub);
    if (next) place(next, x);
  }

  function node(p: Partial<TNode> & Pick<TNode, "id" | "kind" | "turn" | "label" | "status">): TNode {
    return { children: [], x: 0, subs: 0, ...p };
  }
}

export function flatten(roots: TNode[]): TNode[] {
  const out: TNode[] = [];
  const go = (n: TNode) => { out.push(n); n.children.forEach(go); };
  roots.forEach(go);
  return out;
}
