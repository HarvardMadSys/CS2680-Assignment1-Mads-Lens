import { describe, expect, it } from 'vitest'
import { agentIdentityFor } from './agentIdentity'

describe('agentIdentityFor', () => {
  it('gives the first six collaborators distinct eye profiles as well as colors', () => {
    const faces = Array.from({ length: 6 }, (_, index) => agentIdentityFor(`agent-${index}`, index))
    expect(new Set(faces.map((f) => f.hue)).size).toBe(6)
    expect(
      new Set(faces.map((f) => JSON.stringify([f.eyeTilt, f.eyeRy, f.pupilRx, f.eyeOffset]))).size,
    ).toBe(6)
  })
  it('is a pure function of the id: identical input always yields identical output', () => {
    expect(agentIdentityFor('toolu_abc')).toEqual(agentIdentityFor('toolu_abc'))
  })

  it('spreads hues across a real multi-agent run instead of clustering them together', () => {
    // These are the actual five reviewer tool_use ids from the real recorded concurrent-review
    // session — an earlier hue formula (continuous hash * golden angle, mod 360) placed two of
    // these within ~7 degrees of each other, which read as visually identical in the app.
    const ids = [
      'toolu_01QPwR5bqS6XaZmDdKH5KpYx',
      'toolu_01Mob5TcSwtxAnMhAb1HCLfB',
      'toolu_012U8E3x4hngYX8y7MwWbJvo',
      'toolu_01VhMupMx5zcG1e1SSVXTBoH',
      'toolu_012VTf9ZwFwQR4U1XqbnZCwf',
    ]
    const hues = ids.map((id, index) => agentIdentityFor(id, index).hue).sort((a, b) => a - b)
    for (let i = 1; i < hues.length; i++) {
      const gap = (hues[i] as number) - (hues[i - 1] as number)
      expect(gap === 0 || gap >= 10).toBe(true)
    }
  })

  it('keeps eye geometry within a tight range of the base mascot design', () => {
    for (const id of ['toolu_a', 'toolu_b', 'toolu_c', 'toolu_d', 'toolu_e']) {
      const identity = agentIdentityFor(id)
      expect(identity.hue).toBeGreaterThanOrEqual(0)
      expect(identity.hue).toBeLessThan(360)
      expect(identity.eyeRx).toBeGreaterThan(2.5)
      expect(identity.eyeRx).toBeLessThan(3.7)
      expect(identity.eyeRy).toBeGreaterThan(4.5)
      expect(identity.eyeRy).toBeLessThan(6)
      expect(identity.eyeSpacing).toBeGreaterThan(3.8)
      expect(identity.eyeSpacing).toBeLessThan(5.2)
      expect(identity.pupilDy).toBeGreaterThan(0.4)
      expect(identity.pupilDy).toBeLessThan(1.2)
    }
  })
})
