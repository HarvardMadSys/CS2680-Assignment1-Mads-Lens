import { blocks, isMessage, type StreamEvent } from './types.ts'

export interface ToolNode {
  id: string
  name: string
  input: Record<string, unknown>
  parentId: string | null
  isError?: boolean
  result?: string
  children: ToolNode[]
}

function preview(value: unknown, max = 120): string {
  const text =
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value.map((part) => (typeof part === 'string' ? part : ((part as { text?: string })?.text ?? ''))).join(' ')
        : JSON.stringify(value ?? '')
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export function buildTree(events: StreamEvent[]): ToolNode[] {
  const byId = new Map<string, ToolNode>()
  const roots: ToolNode[] = []

  for (const event of events) {
    if (!isMessage(event)) continue
    for (const block of blocks(event)) {
      if (block.type !== 'tool_use') continue
      const { id, name, input } = block as { id: string; name: string; input: Record<string, unknown> }
      byId.set(id, { id, name, input, parentId: event.parent_tool_use_id ?? null, children: [] })
    }
  }

  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  for (const event of events) {
    if (!isMessage(event)) continue
    for (const block of blocks(event)) {
      if (block.type !== 'tool_result') continue
      const { tool_use_id, content, is_error } = block as {
        tool_use_id: string
        content?: unknown
        is_error?: boolean
      }
      const node = byId.get(tool_use_id)
      if (!node) continue
      node.isError = is_error ?? false
      node.result = preview(content)
    }
  }

  return roots
}

const LABEL_KEYS = ['file_path', 'path', 'command', 'pattern', 'url', 'description', 'query', 'prompt']

export function label(node: ToolNode): string {
  for (const key of LABEL_KEYS) {
    const value = node.input?.[key]
    if (typeof value === 'string' && value.trim()) return preview(value, 60)
  }
  return ''
}

export function renderTree(nodes: ToolNode[], indent = ''): string {
  return nodes
    .map((node, index) => {
      const last = index === nodes.length - 1
      const status = node.result === undefined ? '…' : node.isError ? '✗' : '✓'
      const detail = label(node)
      const head = `${indent}${last ? '└─' : '├─'} ${status} ${node.name}${detail ? `  ${detail}` : ''}`
      const child = renderTree(node.children, `${indent}${last ? '   ' : '│  '}`)
      return child ? `${head}\n${child}` : head
    })
    .join('\n')
}

export function countNodes(nodes: ToolNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0)
}
