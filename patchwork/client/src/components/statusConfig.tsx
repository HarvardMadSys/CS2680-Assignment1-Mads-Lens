import { AlertTriangle, CheckCircle2, Loader2, type LucideIcon, XCircle } from 'lucide-react'
import type { AgentNodeStatus } from '@/lib/timeline/selectors'
import type { RunStatus, ToolStatus } from '@/lib/timeline/types'
import { cn } from '@/lib/utils'

/** One status-to-visual mapping, shared by every place that renders a run/tool/agent status —
 * previously duplicated separately in RunStatusBar, ToolCallRow, and RunView. */
export interface StatusVisual {
  label: string
  icon: LucideIcon
  className: string
  spin?: boolean
}

export const RUN_STATUS_CONFIG: Record<RunStatus, StatusVisual> = {
  running: { label: 'Running', icon: Loader2, className: 'text-muted-foreground', spin: true },
  completed: {
    label: 'Completed',
    icon: CheckCircle2,
    className: 'text-emerald-600 dark:text-emerald-400',
  },
  error: { label: 'Failed', icon: XCircle, className: 'text-destructive' },
  interrupted: {
    label: 'Interrupted',
    icon: AlertTriangle,
    className: 'text-amber-600 dark:text-amber-400',
  },
}

export const TOOL_STATUS_CONFIG: Record<ToolStatus, StatusVisual> = {
  pending: { label: 'Running', icon: Loader2, className: 'text-muted-foreground', spin: true },
  success: {
    label: 'Done',
    icon: CheckCircle2,
    className: 'text-emerald-600 dark:text-emerald-400',
  },
  error: { label: 'Failed', icon: XCircle, className: 'text-destructive' },
}

/** `delegated`/`working` are kept distinct in the underlying status (see `selectors.ts`) even
 * though they render the same way here — a backgrounded launch that hasn't produced any nested
 * activity yet vs. one that has are both still "not finished," which is the only thing this
 * pill needs to communicate. */
export const AGENT_NODE_STATUS_CONFIG: Record<AgentNodeStatus, StatusVisual> = {
  cancelled: { label: 'Cancelled', icon: XCircle, className: 'text-muted-foreground' },
  interrupted: { label: 'Interrupted', icon: AlertTriangle, className: 'text-amber-600' },
  unknown: { label: 'Unknown', icon: AlertTriangle, className: 'text-muted-foreground' },
  delegated: { label: 'Delegated', icon: Loader2, className: 'text-muted-foreground', spin: true },
  working: { label: 'Working', icon: Loader2, className: 'text-muted-foreground', spin: true },
  returned: {
    label: 'Returned',
    icon: CheckCircle2,
    className: 'text-emerald-600 dark:text-emerald-400',
  },
  error: { label: 'Failed', icon: XCircle, className: 'text-destructive' },
}

export function StatusIcon({ config, className }: { config: StatusVisual; className?: string }) {
  const Icon = config.icon
  return (
    <Icon className={cn('shrink-0', config.className, config.spin && 'animate-spin', className)} />
  )
}
