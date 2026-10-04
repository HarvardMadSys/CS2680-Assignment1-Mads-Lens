import { useState } from 'react'

const PREVIEW_LINES = 12
const PREVIEW_CHARS = 1200

export function previewOf(text) {
  const full = text ?? ''
  const lines = full.split('\n')

  const byLines = lines.length > PREVIEW_LINES
  const byChars = full.length > PREVIEW_CHARS

  if (!byLines && !byChars) return { preview: full, truncated: false, hiddenLines: 0 }

  let preview = lines.slice(0, PREVIEW_LINES).join('\n')
  if (preview.length > PREVIEW_CHARS) preview = preview.slice(0, PREVIEW_CHARS)

  return {
    preview,
    truncated: true,
    hiddenLines: Math.max(lines.length - PREVIEW_LINES, 0),
  }
}

/**
 * Monospace block that shows a bounded preview by default and expands on
 * demand. Whitespace and line breaks are preserved for terminal/test output.
 */
export default function Collapsible({ text, label, tone = 'default' }) {
  const [expanded, setExpanded] = useState(false)
  const { preview, truncated, hiddenLines } = previewOf(text)

  if (!text) return null

  const folded = truncated && !expanded

  return (
    <div className={`block block-${tone}${folded ? ' block-folded' : ''}`}>
      {label && <div className="block-label">{label}</div>}
      <pre className="block-body">{folded ? preview : text}</pre>
      {/* An explicit marker so a folded block never looks like the whole output. */}
      {folded && <div className="fold-marker">{'⋯'}</div>}
      {truncated && (
        <button className="link" onClick={() => setExpanded((v) => !v)}>
          {expanded
            ? 'Collapse'
            : `Show all (${hiddenLines > 0 ? `${hiddenLines} more lines` : `${text.length} chars`})`}
        </button>
      )}
    </div>
  )
}
