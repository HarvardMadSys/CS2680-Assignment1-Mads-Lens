import { useMemo } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: false })

// DOMPurify needs a DOM, which always exists in the browser. Outside one it has
// no `sanitize`, so fall back to escaped plain text rather than crashing or --
// far worse -- emitting unsanitised HTML.
const canSanitize = typeof DOMPurify.sanitize === 'function'

function escapeHtml(text) {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}

/**
 * Assistant prose and final results are Markdown. Tool output can contain
 * anything, so everything is sanitised before it reaches the DOM.
 */
export default function Markdown({ text }) {
  const html = useMemo(() => {
    const source = text ?? ''
    if (!canSanitize) return `<pre>${escapeHtml(source)}</pre>`
    return DOMPurify.sanitize(marked.parse(source, { async: false }))
  }, [text])

  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
