export type Frame = {
  seq: number; ts: number; kind: string; parent?: string | null; group?: number; [k: string]: any;
};

export type ToolNode = {
  type: "tool"; id: string; name: string; input: any; call: Frame;
  result?: Frame; children: Node[];
  summary?: string;   // the small model's one line for this call
  eta?: number;       // ms this call took last time, for the progress bar
};
export type TextNode = { type: "text" | "thinking"; frame: Frame };
export type Node = ToolNode | TextNode;

export type Timing = {
  emit_ms?: number; ttft_ms?: number | null;
  by_tool?: Record<string, { ms: number; n: number }>;
  legs?: { phase: string; ms: number; at: number; label?: string }[];
};

export type RunSummary = {
  status: string; cost_usd?: number; duration_ms?: number; api_duration_ms?: number;
  num_turns?: number; session_id?: string; usage?: Record<string, number>;
  result?: string | null; phases?: Record<string, number>; timing?: Timing;
  error?: string; subtype?: string;
};

export type Turn = {
  runId: string; prompt: string; cwd: string; resumed?: string | null; replay?: string | null;
  frames: Frame[]; status: "starting" | "running" | "finished" | "failed";
  summary?: RunSummary; init?: Frame; startedAt: number;
};

export type Caps = {
  tools: string[]; models: string[]; efforts: string[]; permission_modes: string[];
  skills: Item[]; commands: Item[]; agents: Item[]; mcp: Mcp[];
  claude_md: string[]; settings: string[];
};
export type Item = { name: string; description: string; scope: string; kind: string; path: string };
export type Mcp = { name: string; transport: string; target: string; source: string };

export type Options = {
  model?: string; effort?: string; permission_mode?: string; skip_permissions?: boolean;
  tools?: string[]; allowed_tools?: string[]; disallowed_tools?: string[];
  disable_skills?: boolean; append_system_prompt?: string; agent?: string;
  max_turns?: number; add_dirs?: string[]; resume?: string; record?: string;
};
