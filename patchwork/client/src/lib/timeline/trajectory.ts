import type { ExecutionStep } from './execution'
import { deriveAgentNodeStatus } from './selectors'
import { asRecord, asString, extractTextContent, summarizeToolInput } from './toolInputs'
import type { Run, ToolCallNode } from './types'

export interface ActivityGroup {
  id: string
  title: string
  steps: [ExecutionStep, ...ExecutionStep[]]
}

function activityKind(step: ExecutionStep): string | undefined {
  if (step.kind === 'return' || step.childLaneId) return undefined
  if (step.node.name === 'Read') return 'Inspecting files'
  if (['Glob', 'Grep', 'Search'].includes(step.node.name)) return 'Searching the codebase'
  if (['Write', 'Edit'].includes(step.node.name)) return 'Updating files'
  if (step.node.name === 'Bash') return 'Running commands'
  return undefined
}

/** Group only adjacent activity in the same lane. Interleaved work by other agents does not
 * create empty rows; assignments and returns remain boundaries. The raw tree is untouched. */
export function groupLaneActivity(steps: ExecutionStep[], laneId: string): ActivityGroup[] {
  const groups: ActivityGroup[] = []
  for (const step of steps.filter((s) => s.laneId === laneId)) {
    const title = activityKind(step)
    const previous = groups.at(-1)
    if (title && previous?.title === title) previous.steps.push(step)
    else groups.push({ id: step.id, title: title ?? step.node.name, steps: [step] })
  }
  return groups
}

export function shortToolSummary(node: ToolCallNode): string {
  const summary = summarizeToolInput(node.name, node.input)
  return ['Read', 'Write', 'Edit'].includes(node.name)
    ? summary.replace(/^.*[/\\]([^/\\]+)$/, '$1')
    : summary
}

export function activitySummary(group: ActivityGroup): string {
  const names = [...new Set(group.steps.map((s) => shortToolSummary(s.node)).filter(Boolean))]
  const reads = group.steps.every((s) => s.node.name === 'Read')
  const files = new Set(group.steps.map((s) => summarizeToolInput(s.node.name, s.node.input))).size
  const count = reads
    ? `Read ${files} file${files === 1 ? '' : 's'}`
    : `${group.steps.length} steps`
  const repeated = reads && files !== group.steps.length ? ` · ${group.steps.length} reads` : ''
  return `${count}${repeated} · ${names.slice(0, 2).join(', ')}${names.length > 2 ? ', …' : ''}`
}

export function isInputRequest(node: ToolCallNode): boolean {
  return node.name === 'AskUserQuestion' || node.name === 'AskUser'
}

export function needsAttention(node: ToolCallNode): boolean {
  return node.status === 'error' || isInputRequest(node)
}

export function inputQuestion(node: ToolCallNode): string | undefined {
  const input = asRecord(node.input)
  if (Array.isArray(input.questions))
    return input.questions
      .map((q) => asString(asRecord(q).question))
      .filter(Boolean)
      .join(' ')
  return asString(input.question)
}

/** A launch acknowledgement is never presented as a background agent's result. */
export function recordedResult(node: ToolCallNode, run: Run): string | undefined {
  if (node.backgrounded) return node.subagentUsage?.summary?.trim() || undefined
  if (deriveAgentNodeStatus(node, run) === 'working' || node.status === 'pending') return undefined
  return (
    node.subagentUsage?.summary?.trim() ||
    extractTextContent(node.result?.content)?.trim() ||
    undefined
  )
}

/** A plain-text excerpt, not a generated finding. Full Markdown remains available in chat.
 * Prefer report content after its first heading to conversational preambles; recordings may
 * end inside a code fence, in which case the report heading is the only readable excerpt. */
export function resultExcerpt(text: string | undefined): string | undefined {
  if (!text) return undefined
  const heading = /^#{1,6}\s+(.+)$/m.exec(text)
  const body = heading ? text.slice(heading.index) : text
  const prose = body
    .replace(/^\[harness:[\s\S]*?\](?:…)?\s*/, '')
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s/.test(line))
    .join(' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*`]/g, '')
  const sentence = prose.match(/^.*?[.!?](?=\s|$)/)?.[0] || prose || heading?.[1]
  if (!sentence) return undefined
  return sentence.length > 220 ? `${sentence.slice(0, 217)}…` : sentence
}
