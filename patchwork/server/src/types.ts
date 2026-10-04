export type ChatStatus = 'idle' | 'running'

export interface ChatMeta {
  id: string
  cwd: string
  title: string
  sessionId?: string | undefined
  activeRunId?: string | undefined
  activePid?: number | undefined
  createdAt: string
  updatedAt: string
  status: ChatStatus
  lastRunStatus?: RunEndStatus | undefined
  lastError?: string | undefined
}

export interface ChatSummary {
  id: string
  cwd: string
  title: string
  status: ChatStatus
  updatedAt: string
  lastRunStatus?: RunEndStatus | undefined
  lastError?: string | undefined
}

export type RunEndStatus = 'completed' | 'error' | 'interrupted'

/** A single parsed line from `claude --output-format stream-json`. Shape is loosely typed
 * here; the client does the detailed narrowing needed to render it. */
export type ClaudeStreamEvent = Record<string, unknown>

export type PersistedEvent =
  | { kind: 'run_start'; runId: string; ts: string; prompt: string }
  | { kind: 'run_end'; runId: string; ts: string; status: RunEndStatus; error?: string | undefined }
  | { kind: 'claude'; runId: string; ts: string; event: ClaudeStreamEvent }
