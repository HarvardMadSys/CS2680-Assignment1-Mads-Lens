import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { AgentVisualIdentity } from '@/lib/timeline/agentIdentity'
import { agentIdentities, toolKey } from '@/lib/timeline/execution'
import type { Run } from '@/lib/timeline/types'

const Identities = createContext(new Map<string, AgentVisualIdentity>())
export const RunIdentityContext = createContext<Run | undefined>(undefined)
export function AgentIdentityProvider({ runs, children }: { runs: Run[]; children: ReactNode }) {
  const value = useMemo(() => agentIdentities(runs), [runs])
  return <Identities.Provider value={value}>{children}</Identities.Provider>
}
export function useAgentIdentity(runId: string, toolId: string) {
  return useContext(Identities).get(toolKey(runId, toolId))
}
export function useAgentIdentities() {
  return useContext(Identities)
}
