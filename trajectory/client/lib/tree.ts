import type { Frame, Node, ToolNode } from "./types";

/** Group frames by parent_tool_use_id and nest subagent events under the Task call. */
export function build(frames: Frame[]): Node[] {
  const byParent = new Map<string, Frame[]>();
  for (const f of frames) {
    const key = f.parent ?? "";
    (byParent.get(key) ?? byParent.set(key, []).get(key)!).push(f);
  }
  const results = new Map<string, Frame>();
  const lines = new Map<string, string>();
  for (const f of frames) {
    if (f.kind === "tool.result") results.set(f.id, f);
    // a generated line arrives after its call and supersedes whatever rode along with it
    else if (f.kind === "tool.summary" && f.text) lines.set(f.id, f.text);
  }

  const level = (key: string): Node[] => {
    const out: Node[] = [];
    for (const f of byParent.get(key) ?? []) {
      if (f.kind === "text" || f.kind === "thinking") out.push({ type: f.kind, frame: f } as Node);
      else if (f.kind === "tool.call")
        out.push({ type: "tool", id: f.id, name: f.name, input: f.input, call: f, result: results.get(f.id), children: level(f.id), summary: lines.get(f.id) ?? f.summary ?? undefined, eta: f.eta_ms ?? undefined } as ToolNode);
    }
    return out;
  };
  return level("");
}

export type Outline = {
  id: string; name: string; depth: number; status: "pending" | "ok" | "error";
  summary?: string; eta?: number; since: number;
};

export function outline(nodes: Node[], depth = 0, acc: Outline[] = []): Outline[] {
  for (const n of nodes) {
    if (n.type !== "tool") continue;
    acc.push({ id: n.id, name: n.name, depth, summary: n.summary, eta: n.eta, since: n.call.ts,
               status: !n.result ? "pending" : n.result.is_error ? "error" : "ok" });
    outline(n.children, depth + 1, acc);
  }
  return acc;
}

export const countEvents = (nodes: Node[]): number =>
  nodes.reduce((s, n) => s + 1 + (n.type === "tool" ? countEvents(n.children) : 0), 0);
