import { useEffect, useState, type CSSProperties } from 'react'
import type { BundledLanguage, Highlighter, ThemedToken } from 'shiki'
import { CopyButton } from '@/components/CopyButton'
import { cn } from '@/lib/utils'

const THEME = 'github-dark'
const CACHE_LIMIT = 160
const ANSI_LANGUAGE = 'ansi'
const PLAIN_LANGUAGE = 'plaintext'

const languageAliases: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cjs: 'javascript',
  csharp: 'csharp',
  cs: 'csharp',
  css: 'css',
  dart: 'dart',
  diff: 'diff',
  dockerfile: 'dockerfile',
  go: 'go',
  graphql: 'graphql',
  h: 'cpp',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  java: 'java',
  js: 'javascript',
  javascript: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  mjs: 'javascript',
  py: 'python',
  python: 'python',
  powershell: 'powershell',
  ps: 'powershell',
  ps1: 'powershell',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  sql: 'sql',
  svg: 'xml',
  swift: 'swift',
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  txt: PLAIN_LANGUAGE,
  text: PLAIN_LANGUAGE,
  xml: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  zsh: 'bash',
}

const knownLanguages = new Set([PLAIN_LANGUAGE, ...Object.values(languageAliases)])

const displayNames: Record<string, string> = {
  bash: 'shell',
  csharp: 'C#',
  cpp: 'C++',
  javascript: 'JavaScript',
  jsx: 'JSX',
  markdown: 'Markdown',
  plaintext: 'text',
  python: 'Python',
  typescript: 'TypeScript',
  tsx: 'TSX',
  xml: 'XML',
  yaml: 'YAML',
}

const highlightCache = new Map<string, ThemedToken[][]>()
const pendingHighlights = new Map<string, Promise<ThemedToken[][]>>()
let highlighterPromise: Promise<Highlighter> | null = null

export type CodeLineKind = 'added' | 'removed' | 'context'

export function inferLanguage(language?: string, filename?: string): string {
  const explicit = language
    ?.trim()
    .replace(/^language-/, '')
    .toLowerCase()
  if (explicit) return normalizeLanguage(explicit)

  const name = filename?.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  const extension = name.includes('.') ? name.split('.').pop() : undefined
  return normalizeLanguage(extension)
}

function normalizeLanguage(value?: string): string {
  if (!value) return PLAIN_LANGUAGE
  const normalized = value.trim().replace(/^\./, '').toLowerCase()
  const resolved = languageAliases[normalized] ?? normalized
  return knownLanguages.has(resolved) ? resolved : PLAIN_LANGUAGE
}

function languageLabel(language: string): string {
  return displayNames[language] ?? language
}

function cacheSet(key: string, value: ThemedToken[][]) {
  highlightCache.delete(key)
  highlightCache.set(key, value)
  while (highlightCache.size > CACHE_LIMIT) {
    const oldest = highlightCache.keys().next().value
    if (oldest === undefined) break
    highlightCache.delete(oldest)
  }
}

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({ themes: [THEME], langs: [] }),
    )
  }
  return highlighterPromise
}

async function highlight(text: string, language: string): Promise<ThemedToken[][]> {
  const cacheKey = `${language}\u0000${text}`
  const cached = highlightCache.get(cacheKey)
  if (cached) return cached

  const pending = pendingHighlights.get(cacheKey)
  if (pending) return pending

  const work = (async () => {
    const highlighter = await getHighlighter()
    if (language !== ANSI_LANGUAGE && language !== PLAIN_LANGUAGE) {
      await highlighter.loadLanguage(language as BundledLanguage)
    }
    const tokens = highlighter.codeToTokensBase(text, {
      lang: language as BundledLanguage,
      theme: THEME,
    })
    cacheSet(cacheKey, tokens)
    return tokens
  })()

  pendingHighlights.set(cacheKey, work)
  try {
    return await work
  } finally {
    pendingHighlights.delete(cacheKey)
  }
}

function tokenStyle(token: ThemedToken): CSSProperties {
  const fontStyle = token.fontStyle ?? 0
  return {
    color: token.color,
    fontStyle: fontStyle & 1 ? 'italic' : undefined,
    fontWeight: fontStyle & 2 ? 700 : undefined,
    textDecoration: fontStyle & 4 ? 'underline' : fontStyle & 8 ? 'line-through' : undefined,
  }
}

function lineKeys(text: string): string[] {
  let offset = 0
  return text.split('\n').map((line) => {
    const key = `${offset}:${line}`
    offset += line.length + 1
    return key
  })
}

function HighlightedCode({
  lines,
  keys,
  lineKinds,
  lineMarkers,
}: {
  lines: ThemedToken[][]
  keys: string[]
  lineKinds?: readonly CodeLineKind[] | undefined
  lineMarkers?: readonly string[] | undefined
}) {
  return (
    <pre className="shiki" style={{ backgroundColor: 'transparent', color: '#e1e4e8' }}>
      <code>
        {lines.map((line, lineIndex) => {
          const kind = lineKinds?.[lineIndex]
          const marker = lineMarkers?.[lineIndex]
          return (
            <span
              className="line"
              data-line-kind={kind}
              data-marker={marker || undefined}
              key={keys[lineIndex]}
            >
              {line.map((token) => (
                <span key={`${token.offset}-${token.content}`} style={tokenStyle(token)}>
                  {token.content}
                </span>
              ))}
            </span>
          )
        })}
      </code>
    </pre>
  )
}

export function CodeSurface({
  text,
  copyText = text,
  filename,
  language,
  label,
  terminal = false,
  lineNumbers = !terminal,
  lineKinds,
  lineMarkers,
  className,
  maxHeightClassName = 'max-h-96',
}: {
  text: string
  copyText?: string
  filename?: string | undefined
  language?: string | undefined
  label?: string | undefined
  terminal?: boolean
  lineNumbers?: boolean
  lineKinds?: readonly CodeLineKind[] | undefined
  lineMarkers?: readonly string[] | undefined
  className?: string | undefined
  maxHeightClassName?: string
}) {
  const resolvedLanguage = terminal ? ANSI_LANGUAGE : inferLanguage(language, filename)
  const [highlighted, setHighlighted] = useState<ThemedToken[][] | null>(
    () => highlightCache.get(`${resolvedLanguage}\u0000${text}`) ?? null,
  )

  useEffect(() => {
    let cancelled = false
    const cacheKey = `${resolvedLanguage}\u0000${text}`
    const cached = highlightCache.get(cacheKey)
    setHighlighted(cached ?? null)

    void highlight(text, resolvedLanguage)
      .then((tokens) => {
        if (!cancelled) setHighlighted(tokens)
      })
      .catch(() => {
        if (!cancelled) setHighlighted(null)
      })

    return () => {
      cancelled = true
    }
  }, [resolvedLanguage, text])

  const header = label ?? filename ?? languageLabel(resolvedLanguage)
  const showsLanguage = Boolean(filename && resolvedLanguage !== PLAIN_LANGUAGE && !terminal)

  return (
    <div
      className={cn(
        'code-surface group relative overflow-hidden rounded-md border border-slate-700/80 bg-[#24292e] text-[13px] text-slate-200 shadow-sm',
        lineNumbers && 'has-line-numbers',
        terminal && 'is-terminal',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-black/10 px-3 py-1.5 text-[10px] text-slate-400">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono">{header}</span>
          {showsLanguage && (
            <span className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[9px] tracking-wide text-slate-500 uppercase">
              {languageLabel(resolvedLanguage)}
            </span>
          )}
        </div>
        <CopyButton
          text={copyText}
          className="shrink-0 text-slate-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-white/10 hover:text-slate-100"
        />
      </div>
      <div className={cn('overflow-auto', maxHeightClassName)}>
        {highlighted ? (
          <HighlightedCode
            lines={highlighted}
            keys={lineKeys(text)}
            lineKinds={lineKinds}
            lineMarkers={lineMarkers}
          />
        ) : (
          <pre className="m-0 px-3 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
            {text}
          </pre>
        )}
      </div>
    </div>
  )
}
