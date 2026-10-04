import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Run } from './timeline/types'
import { useTrajectoryVisibility } from './useTrajectoryVisibility'

type ObservedRun = Pick<Run, 'id' | 'status'> | undefined
describe('trajectory visibility', () => {
  it.each(['completed', 'error', 'interrupted'] as const)(
    'closes desktop and mobile immediately on %s, then permits manual reopening',
    (status) => {
      const { result, rerender } = renderHook(
        ({ run }: { run: ObservedRun }) => useTrajectoryVisibility(run),
        {
          initialProps: { run: { id: 'first', status: 'running' } },
        },
      )
      act(() => result.current.setMobileOpen(true))
      rerender({ run: { id: 'first', status } })
      expect(result.current.open).toBe(false)
      expect(result.current.mobileOpen).toBe(false)
      act(() => {
        result.current.setOpen(true)
        result.current.setMobileOpen(true)
      })
      rerender({ run: { id: 'first', status } })
      expect(result.current.open).toBe(true)
      expect(result.current.mobileOpen).toBe(true)
    },
  )
  it('closes restored history and opens the next live run without forcing the drawer open', () => {
    const { result, rerender } = renderHook(
      ({ run }: { run: ObservedRun }) => useTrajectoryVisibility(run),
      {
        initialProps: { run: undefined as ObservedRun },
      },
    )
    rerender({ run: { id: 'old', status: 'completed' } })
    expect(result.current.open).toBe(false)
    rerender({ run: { id: 'new', status: 'running' } })
    expect(result.current.open).toBe(true)
    expect(result.current.mobileOpen).toBe(false)
    act(() => result.current.setOpen(false))
    rerender({ run: { id: 'new', status: 'running' } })
    expect(result.current.open).toBe(false)
  })
})
