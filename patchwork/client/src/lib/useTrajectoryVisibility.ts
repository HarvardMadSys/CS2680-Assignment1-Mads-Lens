import { useEffect, useRef, useState } from 'react'
import type { Run } from '@/lib/timeline/types'

/** Close once per finished run, not on every update, so history can be reopened manually. */
export function useTrajectoryVisibility(run: Pick<Run, 'id' | 'status'> | undefined) {
  const [open, setOpen] = useState(!run || run.status === 'running')
  const [mobileOpen, setMobileOpen] = useState(false)
  const previous = useRef(run)

  useEffect(() => {
    const changedRun = run?.id !== previous.current?.id
    const finished =
      run && run.status !== 'running' && (changedRun || previous.current?.status === 'running')
    if (finished) {
      setOpen(false)
      setMobileOpen(false)
    } else if (changedRun && run?.status === 'running') {
      // Follow the next prompt on desktop; never open a mobile drawer over the composer.
      setOpen(true)
    }
    previous.current = run
  }, [run])

  return { open, setOpen, mobileOpen, setMobileOpen }
}
