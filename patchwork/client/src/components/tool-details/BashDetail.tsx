import { CodeSurface } from '@/components/CodeSurface'
import { asRecord, asString, extractTextContent } from '@/lib/timeline/toolInputs'
import type { ToolCallNode } from '@/lib/timeline/types'

export function BashDetail({ node }: { node: ToolCallNode }) {
  const input = asRecord(node.input)
  const command = asString(input.command) ?? ''
  const description = asString(input.description)
  const output = node.result ? extractTextContent(node.result.content) : undefined

  return (
    <div className="space-y-2">
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      <CodeSurface
        text={`$ ${command}`}
        language="bash"
        label="command"
        lineNumbers={false}
        maxHeightClassName="max-h-32"
      />
      {node.status === 'pending' && <p className="text-xs text-muted-foreground">Working…</p>}
      {output !== undefined && (
        <CodeSurface
          text={output}
          terminal
          label="output"
          maxHeightClassName="max-h-72"
          className={node.status === 'error' ? 'border-destructive/40' : undefined}
        />
      )}
    </div>
  )
}
