import type { Change } from 'diff'
import { CodeSurface, type CodeLineKind } from '@/components/CodeSurface'

interface DiffRow {
  text: string
  type: 'added' | 'removed' | 'context'
}

function toRows(parts: Change[]): DiffRow[] {
  const rows: DiffRow[] = []
  for (const part of parts) {
    const type = part.added ? 'added' : part.removed ? 'removed' : 'context'
    const lines = part.value.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '' && part.value.endsWith('\n')) {
      lines.pop()
    }
    for (const text of lines) {
      rows.push({ text, type })
    }
  }
  return rows
}

export function DiffView({ parts, filename }: { parts: Change[]; filename?: string | undefined }) {
  const rows = toRows(parts)
  const text = rows.map((row) => row.text).join('\n')
  const copyText = rows
    .map(
      (row) => `${row.type === 'added' ? '+ ' : row.type === 'removed' ? '- ' : '  '}${row.text}`,
    )
    .join('\n')
  const lineKinds = rows.map((row): CodeLineKind => row.type)
  const lineMarkers = rows.map((row) =>
    row.type === 'added' ? '+' : row.type === 'removed' ? '-' : '',
  )

  return (
    <CodeSurface
      text={text}
      copyText={copyText}
      filename={filename}
      label={filename ? undefined : 'diff'}
      lineKinds={lineKinds}
      lineMarkers={lineMarkers}
    />
  )
}
