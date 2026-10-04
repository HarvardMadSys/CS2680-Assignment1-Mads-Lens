import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { relativizePath } from '@/lib/paths'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/state/ChatStore'

/** Shows a file path relative to the active chat's workspace, with the full absolute path
 * available on hover — so long paths don't crowd out the filename, but it's never hidden. */
export function PathLabel({ path, className }: { path: string; className?: string }) {
  const { activeChat } = useChatStore()
  const relative = relativizePath(path, activeChat?.cwd)

  if (relative === path) {
    return <span className={cn('font-mono', className)}>{path}</span>
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'cursor-default font-mono underline decoration-dotted underline-offset-2',
            className,
          )}
        >
          {relative}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="font-mono text-xs">
        {path}
      </TooltipContent>
    </Tooltip>
  )
}
