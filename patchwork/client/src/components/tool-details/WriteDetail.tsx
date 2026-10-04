import { diffLines } from 'diff'
import { CodeSurface } from '@/components/CodeSurface'
import { DiffView } from '@/components/DiffView'
import { PathLabel } from '@/components/PathLabel'
import { asRecord, asString, extractTextContent } from '@/lib/timeline/toolInputs'
import type { ToolCallNode } from '@/lib/timeline/types'

export function WriteDetail({ node }: { node: ToolCallNode }) {
  const input = asRecord(node.input)
  const path = asString(input.file_path) ?? ''
  const content = asString(input.content) ?? ''
  const hasDiff = node.previousContent !== undefined && node.previousContent !== content
  const resultText = node.result ? extractTextContent(node.result.content) : undefined

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <PathLabel path={path} className="text-xs text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          {node.status === 'pending'
            ? 'Proposed write'
            : node.status === 'success'
              ? 'Written'
              : 'Failed'}
        </span>
      </div>
      {hasDiff ? (
        <DiffView filename={path} parts={diffLines(node.previousContent ?? '', content)} />
      ) : (
        <CodeSurface text={content} filename={path} />
      )}
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
