import { CodeSurface } from '@/components/CodeSurface'

export function ScrollableOutput({
  text,
  className,
  maxHeightClassName = 'max-h-72',
}: {
  text: string
  className?: string | undefined
  maxHeightClassName?: string
}) {
  return (
    <CodeSurface
      text={text}
      terminal
      className={className}
      maxHeightClassName={maxHeightClassName}
    />
  )
}
