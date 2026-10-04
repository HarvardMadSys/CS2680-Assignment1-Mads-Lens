import {
  Bot,
  FilePlus2,
  FileText,
  Globe,
  type LucideIcon,
  PenLine,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react'
import { isSubagentTool } from '@/lib/timeline/toolInputs'

const ICONS: Record<string, LucideIcon> = {
  Read: FileText,
  Write: FilePlus2,
  Edit: PenLine,
  Bash: Terminal,
  WebSearch: Search,
  WebFetch: Globe,
}

export function toolIcon(name: string): LucideIcon {
  if (isSubagentTool(name)) return Bot
  return ICONS[name] ?? Wrench
}
