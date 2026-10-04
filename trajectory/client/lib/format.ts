import type { ToolNode } from "./types";

export const ms = (v?: number | null) =>
  v == null ? "—" : v < 1000 ? `${Math.round(v)}ms` : v < 60000 ? `${(v / 1000).toFixed(1)}s` : `${Math.floor(v / 60000)}m ${Math.round((v % 60000) / 1000)}s`;

export const usd = (v?: number | null) => (v == null ? "—" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

export const num = (v?: number | null) =>
  v == null ? "—" : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : `${v}`;

export const clock = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const short = (s?: string | null, n = 8) => (s ? s.slice(0, n) : "—");

/** One-line label for a tool call: the argument that identifies it. */
export function toolArg(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const pick = (k: string) => (typeof input[k] === "string" ? input[k] : "");
  switch (name) {
    case "Bash": return pick("command");
    case "Read": case "Write": case "Edit": case "MultiEdit": return tail(pick("file_path"));
    case "NotebookEdit": return tail(pick("notebook_path"));
    case "Glob": return pick("pattern") + (input.path ? ` in ${tail(input.path)}` : "");
    case "Grep": return `"${pick("pattern")}"` + (input.path ? ` in ${tail(input.path)}` : "");
    case "Task": return pick("description") || pick("subagent_type");
    case "WebFetch": case "WebSearch": return pick("url") || pick("query");
    case "TodoWrite": return `${(input.todos ?? []).length} items`;
    default: return Object.values(input).filter((v) => typeof v === "string")[0] ?? "";
  }
}
export const tail = (p: string, n = 2) => (p ? p.split("/").slice(-n).join("/") : "");

/** "4m", "2h", "3d" — compact enough for a card corner. */
export function ago(ts: number): string {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 604800) return `${Math.floor(d / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * A few words that say what a tool call did — its node label, and its line inside a card.
 * The small model's summary wins; without one we fall back to the call's own description and
 * then to the identifying argument, which is all a run recorded before summaries can offer.
 */
export const toolLine = (t: ToolNode): string => {
  const d = typeof t.input?.description === "string" ? t.input.description : "";
  return t.summary || d || toolArg(t.name, t.input) || t.name;
};
