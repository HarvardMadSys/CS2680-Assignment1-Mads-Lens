import { ChevronRight } from 'lucide-react'
import { useContext } from 'react'
import { AgentAvatar } from '@/components/AgentAvatar'
import { RunIdentityContext, useAgentIdentity } from '@/components/AgentIdentityContext'
import { Markdown } from '@/components/Markdown'
import { PathLabel } from '@/components/PathLabel'
import { StatusIcon, TOOL_STATUS_CONFIG, AGENT_NODE_STATUS_CONFIG } from '@/components/statusConfig'
import { deriveAgentNodeStatus } from '@/lib/timeline/selectors'
import { BashDetail } from '@/components/tool-details/BashDetail'
import { EditDetail } from '@/components/tool-details/EditDetail'
import { GenericToolDetail } from '@/components/tool-details/GenericToolDetail'
import { ReadDetail } from '@/components/tool-details/ReadDetail'
import { WriteDetail } from '@/components/tool-details/WriteDetail'
import { toolIcon } from '@/components/toolIcons'
import { asRecord, asString, isSubagentTool, summarizeToolInput } from '@/lib/timeline/toolInputs'
import type { TimelineNode, ToolCallNode } from '@/lib/timeline/types'
import { cn } from '@/lib/utils'
import { AGENT_CHARACTERS } from '@/lib/agentCharacters'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

const PATH_TOOL_NAMES = new Set(['Read', 'Write', 'Edit'])

export type OutlineRefMap = Map<string, HTMLElement>
export type RunRevealMap = Map<string, (toolId: string) => void>

function ToolDetail({ node }: { node: ToolCallNode }) {
  switch (node.name) {
    case 'Read':
      return <ReadDetail node={node} />
    case 'Edit':
      return <EditDetail node={node} />
    case 'Write':
      return <WriteDetail node={node} />
    case 'Bash':
      return <BashDetail node={node} />
    default:
      return <GenericToolDetail node={node} />
  }
}

export function ToolCallRow({
  node,
  depth,
  outlineRefs,
  expandedToolIds,
  onToggleTool,
  selectedToolId,
  flashToolId,
}: {
  node: ToolCallNode
  depth: number
  outlineRefs?: OutlineRefMap | undefined
  expandedToolIds: ReadonlySet<string>
  onToggleTool: (toolId: string) => void
  selectedToolId?: string | null | undefined
  flashToolId?: string | null | undefined
}) {
  const expanded = expandedToolIds.has(node.id)
  const Icon = toolIcon(node.name)
  const summary = summarizeToolInput(node.name, node.input)
  const subagent = isSubagentTool(node.name)
  const run = useContext(RunIdentityContext)
  const identity = useAgentIdentity(run?.id ?? '', node.id)
  const status = subagent
    ? AGENT_NODE_STATUS_CONFIG[deriveAgentNodeStatus(node, run)]
    : node.status === 'pending' && run && run.status !== 'running'
      ? AGENT_NODE_STATUS_CONFIG[run.status === 'interrupted' ? 'interrupted' : 'unknown']
      : TOOL_STATUS_CONFIG[node.status]
  const filePath = PATH_TOOL_NAMES.has(node.name)
    ? asString(asRecord(node.input).file_path)
    : undefined
  const selected = selectedToolId === node.id
  const flashing = flashToolId === node.id

  return (
    <div
      ref={(el) => {
        if (outlineRefs) {
          if (el) outlineRefs.set(node.id, el)
          else outlineRefs.delete(node.id)
        }
      }}
      data-tool-call-id={node.id}
      className={cn(
        'rounded-md border border-border bg-card',
        depth > 0 && 'ml-4',
        selected && 'ring-1 ring-primary/50',
        flashing && 'outline-flash',
      )}
    >
      <button
        type="button"
        onClick={() => onToggleTool(node.id)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40"
        aria-expanded={expanded}
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
        {subagent ? (
          <AgentAvatar size={24} identity={identity} working={Boolean(status.spin)} />
        ) : (
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 font-medium">
          {node.name}
          {subagent && identity && (
            <span title={AGENT_CHARACTERS[identity.character].name}>
              {' '}
              · {AGENT_CHARACTERS[identity.character].shortName}
            </span>
          )}
        </span>
        {filePath ? (
          <PathLabel path={filePath} className="truncate text-xs text-muted-foreground" />
        ) : (
          summary && (
            <span className="truncate font-mono text-xs text-muted-foreground">{summary}</span>
          )
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {subagent && node.children.length > 0 && (
            <span className="text-xs text-muted-foreground">{node.children.length} nested</span>
          )}
          {subagent && <span className="text-[10px] text-muted-foreground">{status.label}</span>}
          <StatusIcon config={status} className="size-3.5" />
        </span>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-border px-3 py-2">
          <ToolDetail node={node} />
          {['Read', 'Write', 'Edit', 'Bash'].includes(node.name) && (
            <Collapsible className="rounded-md border border-border/70 text-xs">
              <CollapsibleTrigger className="group flex w-full items-center gap-1 px-2 py-1.5 text-left text-muted-foreground">
                <ChevronRight className="size-3 group-data-[state=open]:rotate-90" />
                Complete input &amp; result
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-2 border-t p-2">
                <GenericToolDetail node={node} />
              </CollapsibleContent>
            </Collapsible>
          )}
          {node.children.length > 0 && (
            <div className="space-y-2 pt-1">
              <TimelineNodeList
                nodes={node.children}
                depth={depth + 1}
                outlineRefs={outlineRefs}
                expandedToolIds={expandedToolIds}
                onToggleTool={onToggleTool}
                selectedToolId={selectedToolId}
                flashToolId={flashToolId}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function TimelineNodeList({
  nodes,
  depth,
  outlineRefs,
  expandedToolIds,
  onToggleTool,
  selectedToolId,
  flashToolId,
}: {
  nodes: TimelineNode[]
  depth: number
  outlineRefs?: OutlineRefMap | undefined
  expandedToolIds: ReadonlySet<string>
  onToggleTool: (toolId: string) => void
  selectedToolId?: string | null | undefined
  flashToolId?: string | null | undefined
}) {
  return (
    <div className="space-y-2">
      {nodes.map((node) => {
        if (node.kind === 'tool_call') {
          return (
            <ToolCallRow
              key={node.id}
              node={node}
              depth={depth}
              outlineRefs={outlineRefs}
              expandedToolIds={expandedToolIds}
              onToggleTool={onToggleTool}
              selectedToolId={selectedToolId}
              flashToolId={flashToolId}
            />
          )
        }
        if (node.kind === 'thinking') {
          return (
            <p key={node.id} className="text-xs text-muted-foreground italic">
              {node.text}
            </p>
          )
        }
        return <AgentMessage key={node.id} text={node.text} parentId={node.parentId} />
      })}
    </div>
  )
}

function AgentMessage({ text, parentId }: { text: string; parentId: string | null }) {
  const run = useContext(RunIdentityContext)
  const identity = useAgentIdentity(run?.id ?? '', parentId ?? '')
  return (
    <div className="flex gap-2">
      {identity && <AgentAvatar identity={identity} size={22} className="shrink-0" />}
      <div className="min-w-0 flex-1">
        {identity && (
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">
            {AGENT_CHARACTERS[identity.character].name}
          </p>
        )}
        <Markdown text={text} />
      </div>
    </div>
  )
}
