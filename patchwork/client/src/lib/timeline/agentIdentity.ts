import { SUBAGENT_CHARACTERS, type AgentCharacter } from '@/lib/agentCharacters'

/** A stable, cosmetic-only visual identity for one subagent, derived from its Task tool_use id
 * plus its order of first appearance in this chat — the same every time the event log is
 * replayed, so no persistence is needed to keep an agent's face consistent across a reload or a
 * replay. Never used for the main agent, which keeps the app's default identity throughout a
 * run. */
export interface AgentVisualIdentity {
  character: AgentCharacter
  motionDelay: number
  hue: number
  eyeRx: number
  eyeRy: number
  eyeSpacing: number
  pupilDy: number
  eyeTilt?: number | undefined
  pupilRx?: number | undefined
  pupilRy?: number | undefined
  eyeOffset?: number | undefined
}

// FNV-1a-style fold: cheap, deterministic, good-enough bit dispersion for a handful of ids.
function hashString(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function bitSlice(hash: number, shift: number, bits: number): number {
  return (hash >>> shift) & ((1 << bits) - 1)
}

// The hue's *bucket* comes from `orderIndex`, not from hashing the id: two real agents' ids
// hashing close together (measured against the real concurrent-review recording — a plain
// `hash % 360` placed two of five reviewers within ~7° of each other) would otherwise read as
// visually identical. First-appearance order picks a palette slot and eye profile; the id hash
// supplies small variations. agentIdentities carries this identity through resumed agents.
// Alternate distant hues so collaborators beside each other are immediately distinguishable.
// Orange belongs to the main agent. Later cycles get deterministic hue variations.
const HUES = [250, 150, 315, 85, 200, 355, 280, 120, 225, 175, 60, 335]
const EYES = [
  {
    eyeRx: 3.1,
    eyeRy: 5.7,
    eyeSpacing: 4.5,
    pupilDy: 0.8,
    eyeTilt: -9,
    pupilRx: 1.2,
    pupilRy: 1.8,
    eyeOffset: 0,
  },
  {
    eyeRx: 3.8,
    eyeRy: 4.4,
    eyeSpacing: 4.8,
    pupilDy: 0.1,
    eyeTilt: 0,
    pupilRx: 1.7,
    pupilRy: 1.7,
    eyeOffset: 0,
  },
  {
    eyeRx: 2.8,
    eyeRy: 5.9,
    eyeSpacing: 4.7,
    pupilDy: 1,
    eyeTilt: 12,
    pupilRx: 1,
    pupilRy: 1.8,
    eyeOffset: 0.8,
  },
  {
    eyeRx: 3.7,
    eyeRy: 4.9,
    eyeSpacing: 4.8,
    pupilDy: -0.4,
    eyeTilt: -5,
    pupilRx: 1.2,
    pupilRy: 1.2,
    eyeOffset: -0.7,
  },
  {
    eyeRx: 3.2,
    eyeRy: 5.5,
    eyeSpacing: 5,
    pupilDy: 0.4,
    eyeTilt: 7,
    pupilRx: 1.7,
    pupilRy: 2,
    eyeOffset: 0,
  },
  {
    eyeRx: 3.6,
    eyeRy: 4.6,
    eyeSpacing: 4.4,
    pupilDy: 0.9,
    eyeTilt: -12,
    pupilRx: 1.3,
    pupilRy: 1.5,
    eyeOffset: 0.6,
  },
]

export function agentIdentityFor(taskToolUseId: string, orderIndex = 0): AgentVisualIdentity {
  const hash = hashString(taskToolUseId)
  const bucket = orderIndex % HUES.length
  const jitterUnit = bitSlice(hash, 8, 8) / 255 - 0.5
  const hue =
    ((HUES[bucket] ?? 250) + jitterUnit * 6 + Math.floor(orderIndex / HUES.length) * 7) % 360
  return {
    character: SUBAGENT_CHARACTERS[orderIndex % SUBAGENT_CHARACTERS.length] ?? 'robot',
    motionDelay: -(bitSlice(hash, 0, 8) / 255) * 5,
    ...EYES[orderIndex % EYES.length],
    hue,
    eyeRx: (EYES[orderIndex % EYES.length]?.eyeRx ?? 3.1) + bitSlice(hash, 16, 4) / 150,
    eyeRy: EYES[orderIndex % EYES.length]?.eyeRy ?? 5.2,
    eyeSpacing: EYES[orderIndex % EYES.length]?.eyeSpacing ?? 4.5,
    pupilDy: EYES[orderIndex % EYES.length]?.pupilDy ?? 0.8,
  }
}
