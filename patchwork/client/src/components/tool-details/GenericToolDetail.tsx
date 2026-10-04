import { CodeSurface } from '@/components/CodeSurface'
import type { ToolCallNode } from '@/lib/timeline/types'

function pretty(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Fallback for any tool without a dedicated renderer — pretty-prints input/result as-is. */
export function GenericToolDetail({ node }: { node: ToolCallNode }) {
  return (
    <div className="space-y-2">
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">Input</div>
        <CodeSurface
          text={pretty(node.input)}
          language={typeof node.input === 'string' ? undefined : 'json'}
          label="input"
        />
      </div>
      {node.result && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Result</div>
          <CodeSurface
            text={pretty(node.result.content)}
            language={typeof node.result.content === 'string' ? undefined : 'json'}
            label="result"
            className={node.result.isError ? 'border-destructive/40' : undefined}
          />
        </div>
      )}
      {node.status === 'pending' && <p className="text-xs text-muted-foreground">Working…</p>}
    </div>
  )
}
