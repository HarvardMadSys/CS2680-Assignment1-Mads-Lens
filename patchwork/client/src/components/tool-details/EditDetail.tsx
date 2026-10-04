import { diffLines } from 'diff'
import { CodeSurface } from '@/components/CodeSurface'
import { DiffView } from '@/components/DiffView'
import { PathLabel } from '@/components/PathLabel'
import { asRecord, asString, extractTextContent } from '@/lib/timeline/toolInputs'
import type { ToolCallNode } from '@/lib/timeline/types'

export function EditDetail({ node }: { node: ToolCallNode }) {
  const input = asRecord(node.input)
  const path = asString(input.file_path) ?? ''
  const oldString = asString(input.old_string) ?? ''
  const newString = asString(input.new_string) ?? ''
  const resultText = node.result ? extractTextContent(node.result.content) : undefined

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <PathLabel path={path} className="text-xs text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          {node.status === 'pending'
            ? 'Proposed edit'
            : node.status === 'success'
              ? 'Applied'
              : 'Failed'}
        </span>
      </div>
      <DiffView filename={path} parts={diffLines(oldString, newString)} />
      {resultText !== undefined && (
        <CodeSurface
          text={resultText}
          label="result"
          maxHeightClassName="max-h-40"
          className={node.result?.isError ? 'border-destructive/40' : undefined}
        />
      )}
    </div>
  )
}
