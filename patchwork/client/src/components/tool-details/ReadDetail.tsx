import { CodeSurface } from '@/components/CodeSurface'
import { PathLabel } from '@/components/PathLabel'
import { asRecord, asString, extractTextContent } from '@/lib/timeline/toolInputs'
import type { ToolCallNode } from '@/lib/timeline/types'

export function ReadDetail({ node }: { node: ToolCallNode }) {
  const path = asString(asRecord(node.input).file_path) ?? ''
  const content = node.result ? extractTextContent(node.result.content) : undefined

  return (
    <div className="space-y-2">
      <div>
        <PathLabel path={path} className="text-xs text-muted-foreground" />
      </div>
      {node.status === 'pending' && <p className="text-xs text-muted-foreground">Working…</p>}
      {content !== undefined && (
        <CodeSurface
          text={content}
          filename={path}
          className={node.status === 'error' ? 'border-destructive/40' : undefined}
        />
      )}
    </div>
  )
}
