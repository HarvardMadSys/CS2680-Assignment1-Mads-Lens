export type RunEndStatus = 'completed' | 'error' | 'interrupted'

/** A single parsed line from `claude --output-format stream-json`. Loosely typed — narrowed
 * on read since the CLI's event shapes aren't part of a published schema. */
export type ClaudeStreamEvent = Record<string, unknown>

/** The one envelope shared by live streaming, chat restore, and fixture replay. */
export type PersistedEvent =
  | { kind: 'run_start'; runId: string; ts: string; prompt: string }
  | { kind: 'run_end'; runId: string; ts: string; status: RunEndStatus; error?: string | undefined }
  | { kind: 'claude'; runId: string; ts: string; event: ClaudeStreamEvent }

export type ToolStatus = 'pending' | 'success' | 'error'

export interface ToolResult {
  content: unknown
  isError: boolean
}

export interface SubagentUsage {
  totalTokens?: number | undefined
  toolUses?: number | undefined
  durationMs?: number | undefined
  summary?: string | undefined
  /** Raw `task_notification.status` (e.g. `'completed'`) — the CLI's own vocabulary, passed
   * through rather than narrowed, since only `'completed'` has been observed in practice. */
  status?: string | undefined
}

export interface ToolCallNode {
  sequence?: number | undefined
  resultSequence?: number | undefined
  notificationSequence?: number | undefined
  agentId?: string | undefined
  taskId?: string | undefined
  kind: 'tool_call'
  id: string
  parentId: string | null
  name: string
  input: unknown
  status: ToolStatus
  result?: ToolResult
  children: TimelineNode[]
  startedAt: string
  endedAt?: string
  /** Populated from `task_notification` events for subagent-launching tools. */
  subagentUsage?: SubagentUsage
  /** From `task_started.is_backgrounded` — true means this Task's own `tool_result` only
   * confirms the subagent launched, not that it finished; real completion is a later
   * `task_notification`. Undefined for tools that never received a `task_started` event. */
  backgrounded?: boolean | undefined
  /** For a successful Write: the file's previously-known content, if any was cached from an
   * earlier Read/Write in this chat — lets the detail view show a diff instead of just content. */
  previousContent?: string | undefined
}

export interface TextNode {
  kind: 'text'
  id: string
  parentId: string | null
  role: 'assistant' | 'user'
  text: string
  createdAt: string
}

export interface ThinkingNode {
  kind: 'thinking'
  id: string
  parentId: string | null
  text: string
  createdAt: string
}

export type TimelineNode = ToolCallNode | TextNode | ThinkingNode

export interface RunMetrics {
  costUsd: number
  durationMs: number
  numTurns: number
}

export type RunStatus = 'running' | RunEndStatus

export interface Run {
  eventCount?: number | undefined
  sessionId?: string | undefined
  id: string
  prompt: string
  status: RunStatus
  startedAt: string
  endedAt?: string | undefined
  timeline: TimelineNode[]
  metrics?: RunMetrics
  error?: string | undefined
}

export interface TimelineState {
  runs: Run[]
  /** Absolute file path -> last known full content, derived from Read/Write tool activity.
   * Lets a later Write render a diff against previously-seen content. */
  fileContentCache: Record<string, string>
}

export function createEmptyTimelineState(): TimelineState {
  return { runs: [], fileContentCache: {} }
}
