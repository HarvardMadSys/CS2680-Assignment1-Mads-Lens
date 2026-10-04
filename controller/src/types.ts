export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: string; [key: string]: unknown }

export interface InitEvent {
  type: 'system'
  subtype: 'init'
  session_id: string
  uuid: string
  cwd: string
  model: string
  tools: string[]
  mcp_servers: Array<{ name: string; status: string }>
  slash_commands?: string[]
  permissionMode?: string
  claude_code_version?: string
}

export interface MessageEvent {
  type: 'assistant' | 'user'
  message: { role: string; content: ContentBlock[] | string }
  parent_tool_use_id: string | null
  session_id: string
  uuid: string
}

export interface ResultEvent {
  type: 'result'
  subtype: string
  is_error: boolean
  num_turns: number
  duration_ms: number
  total_cost_usd: number
  result: string
  session_id: string
  permission_denials?: unknown[]
  uuid: string
}

export interface OtherEvent {
  type: string
  subtype?: string
  [key: string]: unknown
}

export type StreamEvent = InitEvent | MessageEvent | ResultEvent | OtherEvent

export const isInit = (e: StreamEvent): e is InitEvent =>
  e.type === 'system' && (e as OtherEvent).subtype === 'init'

export const isMessage = (e: StreamEvent): e is MessageEvent =>
  e.type === 'assistant' || e.type === 'user'

export const isResult = (e: StreamEvent): e is ResultEvent => e.type === 'result'

export function blocks(e: MessageEvent): ContentBlock[] {
  const content = e.message?.content
  return Array.isArray(content) ? content : []
}
