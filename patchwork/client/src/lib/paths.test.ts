import { describe, expect, it } from 'vitest'
import { relativizePath } from './paths'

describe('relativizePath', () => {
  it('strips the workspace prefix', () => {
    expect(relativizePath('/workspace/demo/src/App.tsx', '/workspace/demo')).toBe('src/App.tsx')
  })

  it('handles a cwd with a trailing slash', () => {
    expect(relativizePath('/workspace/demo/src/App.tsx', '/workspace/demo/')).toBe('src/App.tsx')
  })

  it('returns "." for the workspace root itself', () => {
    expect(relativizePath('/workspace/demo', '/workspace/demo')).toBe('.')
  })

  it('falls back to the full path outside the workspace', () => {
    expect(relativizePath('/etc/hosts', '/workspace/demo')).toBe('/etc/hosts')
  })

  it('falls back to the full path when cwd is unknown', () => {
    expect(relativizePath('/workspace/demo/src/App.tsx', undefined)).toBe(
      '/workspace/demo/src/App.tsx',
    )
  })
})
