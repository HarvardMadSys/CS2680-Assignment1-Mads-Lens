import { CodeSurface } from '@/components/CodeSurface'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

const components: Components = {
  code: ({ className, children, ...props }) => {
    const text = String(children).replace(/\n$/, '')
    const language = className?.match(/language-([^\s]+)/)?.[1]
    const isBlock = Boolean(language) || text.includes('\n')

    if (isBlock) {
      return <CodeSurface text={text} language={language} />
    }

    return (
      <code
        className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]', className)}
        {...props}
      >
        {children}
      </code>
    )
  },
  // The code component owns fenced blocks so the shared editor surface is not wrapped in a
  // second, light Markdown <pre> surface.
  pre: ({ children }) => children,
  a: ({ children, ...props }) => (
    <a
      className="text-primary underline underline-offset-2"
      target="_blank"
      rel="noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('markdown-body text-sm leading-relaxed', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
