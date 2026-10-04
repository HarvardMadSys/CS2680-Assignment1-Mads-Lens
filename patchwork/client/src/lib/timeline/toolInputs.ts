export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Undo the `cat -n`-style "     1\t..." prefix the Read tool puts on each line. */
export function stripLineNumbers(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\t/, ''))
    .join('\n')
}

const SUBAGENT_TOOL_NAMES = new Set(['Task', 'Agent'])

export function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name)
}

/** A short one-line description of a tool call's input, for the collapsed row. */
export function summarizeToolInput(name: string, input: unknown): string {
  const rec = asRecord(input)
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return asString(rec.file_path) ?? ''
    case 'Bash':
      return asString(rec.command) ?? ''
    default:
      if (isSubagentTool(name)) {
        return asString(rec.description) ?? asString(rec.subagent_type) ?? ''
      }
      for (const value of Object.values(rec)) {
        if (typeof value === 'string' && value.trim()) return value
      }
      try {
        return JSON.stringify(input) ?? ''
      } catch {
        return ''
      }
  }
}

export function extractTextContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const first = content.find((block) => asRecord(block).type === 'text')
    return first ? asString(asRecord(first).text) : undefined
  }
  return undefined
}
