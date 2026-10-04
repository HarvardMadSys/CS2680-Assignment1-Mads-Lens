import type { CSSProperties } from 'react'
import { AGENT_CHARACTERS, type AgentCharacter } from '@/lib/agentCharacters'
import type { AgentVisualIdentity } from '@/lib/timeline/agentIdentity'
import { cn } from '@/lib/utils'

interface AgentAvatarProps {
  working?: boolean
  size?: number
  className?: string
  /** Omit for Djordje, the main agent. Identities survive history, replay and resume. */
  identity?: AgentVisualIdentity | undefined
}

const INK = '#352b40'
const CREAM = '#fffbed'

function CharacterBody({ character }: { character: AgentCharacter }) {
  switch (character) {
    case 'robot':
      return (
        <>
          <g className="agent-avatar-accessory">
            <path d="M24 12V6" stroke={INK} strokeWidth="2" />
            <circle cx="24" cy="5" r="3" fill="#ffc857" />
          </g>
          <rect x="3" y="22" width="6" height="12" rx="3" fill="var(--agent-shade)" />
          <rect x="39" y="22" width="6" height="12" rx="3" fill="var(--agent-shade)" />
          <rect x="7" y="12" width="34" height="29" rx="10" fill="var(--agent-color)" />
          <rect x="11" y="19" width="26" height="15" rx="6" fill={INK} opacity=".18" />
          <path d="M19 37h10" stroke={INK} strokeWidth="2" strokeDasharray="1 3" />
        </>
      )
    case 'sprout':
      return (
        <>
          <path
            d="M7 30C5 18 13 14 24 14s19 5 17 17c-2 10-10 12-18 12S8 39 7 30"
            fill="var(--agent-color)"
          />
          <g className="agent-avatar-accessory">
            <path d="M24 17V8" stroke={INK} strokeWidth="2" />
            <path d="M24 12C14 13 12 7 12 4c8-1 13 2 12 8" fill="var(--agent-shade)" />
            <path d="M24 10C24 3 31 2 36 3c-1 7-6 10-12 7" fill="var(--agent-color)" />
          </g>
        </>
      )
    case 'jelly':
      return (
        <>
          <g
            className="agent-avatar-limbs"
            fill="none"
            stroke="var(--agent-color)"
            strokeWidth="5"
            strokeLinecap="round"
          >
            <path d="M11 31q-8 12-5 10M19 33q-5 13 0 10M28 33q5 13 0 10M36 31q9 11 7 6" />
          </g>
          <path d="M5 30C4 15 12 8 24 8s20 9 19 22c-5 9-33 9-38 0" fill="var(--agent-color)" />
          <path
            d="M13 16q3-4 7-4"
            stroke={CREAM}
            opacity=".45"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </>
      )
    case 'owl':
      return (
        <>
          <path d="M8 18L6 6l14 7h8L42 6l-2 14c8 25-39 34-32-2" fill="var(--agent-color)" />
          <path
            className="agent-avatar-limbs"
            d="M7 25q-7 9 3 14M41 25q7 9-3 14"
            fill="var(--agent-shade)"
          />
          <path d="M24 17c-15-9-20 15-5 18l5 5 5-5c15-3 10-27-5-18" fill={CREAM} />
        </>
      )
    case 'alien':
      return (
        <>
          <g className="agent-avatar-accessory" stroke={INK} strokeWidth="1.7">
            <path d="M15 15L10 7m23 8 5-8" />
            <circle cx="9" cy="6" r="3" fill="var(--agent-color)" />
            <circle cx="39" cy="6" r="3" fill="var(--agent-color)" />
          </g>
          <path d="M5 24C5 7 43 7 43 24c0 8-12 18-19 18S5 32 5 24" fill="var(--agent-color)" />
          <ellipse cx="24" cy="40" rx="17" ry="3" fill="var(--agent-shade)" />
          <circle cx="14" cy="40" r="1" fill={CREAM} />
          <circle cx="24" cy="41" r="1" fill={CREAM} />
          <circle cx="34" cy="40" r="1" fill={CREAM} />
        </>
      )
    case 'toast':
      return (
        <>
          <path d="M9 20C0 7 17 5 24 9c9-4 24-1 15 11v21H9Z" fill="var(--agent-shade)" />
          <path d="M13 20C6 11 18 10 24 13c7-3 19-1 11 7v17H13Z" fill="#ffe4ac" />
          <path
            className="agent-avatar-accessory"
            d="M17 6q-3-3 0-5m8 5q3-3 0-5m8 5q-3-3 0-5"
            fill="none"
            stroke="var(--agent-color)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path d="M7 27H4v6h5m30-6h5v6h-5" fill="var(--agent-color)" />
        </>
      )
    case 'wizard':
      return (
        <>
          <path d="M9 27c0-16 30-16 30 0v12c-6 6-24 6-30 0Z" fill="var(--agent-color)" />
          <g className="agent-avatar-accessory">
            <path d="M9 20L24 2l5 7 4 10Z" fill="var(--agent-shade)" />
            <path
              d="M5 21q18-7 37 0"
              fill="none"
              stroke="var(--agent-shade)"
              strokeWidth="5"
              strokeLinecap="round"
            />
            <path d="m23 8 1 3 3 1-3 1-1 3-1-3-3-1 3-1Z" fill="#ffdb75" />
          </g>
          <path d="M16 35l8 10 8-10" fill={CREAM} />
        </>
      )
    case 'dino':
      return (
        <>
          <path d="m32 14 5-7 3 9 6 1-5 7 5 4-6 4" fill="var(--agent-shade)" />
          <path
            d="M8 27C3 13 16 9 26 11s15 10 13 20l5 10-12-2C10 47 4 38 8 27"
            fill="var(--agent-color)"
          />
          <path
            className="agent-avatar-limbs"
            d="m12 34-6 3 6 1m21-4 5 3-5 1"
            stroke="var(--agent-shade)"
            strokeWidth="3"
            strokeLinecap="round"
            fill="none"
          />
        </>
      )
    case 'cat':
      return (
        <>
          <path
            className="agent-avatar-accessory"
            d="M37 37c13 0 9-17 4-12"
            fill="none"
            stroke="var(--agent-shade)"
            strokeWidth="4"
            strokeLinecap="round"
          />
          <path d="M8 21 7 6l13 8h8L41 6l-1 17c7 26-39 28-32-2" fill="var(--agent-color)" />
          <path d="m11 12 1 9 5-5m20-4-6 4 5 5" fill="#ffb8c7" />
          <path
            d="m3 28 8 2m-8 4 8-1m26-3 8-2m-8 5 8 1"
            stroke={INK}
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </>
      )
    case 'ghost':
      return (
        <>
          <path d="M8 24C5 3 40 4 40 24l3 18-9-4-6 5-8-5-9 5-6-4Z" fill="var(--agent-color)" />
          <path
            className="agent-avatar-limbs"
            d="m8 27-5 4m37-4 5 4"
            stroke="var(--agent-color)"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <path
            d="M15 15q3-3 6-3"
            stroke={CREAM}
            opacity=".5"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </>
      )
    case 'star':
      return (
        <path
          d="M21 5q3-5 6 0l5 10 11 2q5 1 1 5l-8 8 2 12q1 5-4 2l-10-6-10 6q-5 3-4-2l2-12-8-8q-4-4 1-5l11-2Z"
          fill="var(--agent-color)"
        />
      )
    case 'crab':
      return (
        <>
          <g
            className="agent-avatar-limbs"
            stroke="var(--agent-shade)"
            strokeWidth="2.5"
            strokeLinecap="round"
            fill="none"
          >
            <path d="m11 33-7 5m10-1-5 6m28-10 7 5m-10-1 5 6" />
          </g>
          <g className="agent-avatar-accessory" fill="var(--agent-color)">
            <path d="M12 27C-1 26 0 11 6 10l1 7 5-5c7 6 5 10 0 15M36 27c13-1 12-16 6-17l-1 7-5-5c-7 6-5 10 0 15" />
          </g>
          <ellipse cx="24" cy="29" rx="16" ry="12" fill="var(--agent-color)" />
        </>
      )
    default:
      return (
        <>
          <path
            d="M6 28C3 15 12 9 25 10s19 10 17 21c-2 10-10 13-20 12S8 39 6 28"
            fill="var(--agent-color)"
          />
          <path
            className="agent-avatar-accessory"
            d="M23 12c-8-4-4-11 0-9 5 3-1 8-1 8s7-9 10-5-5 8-9 6"
            fill="var(--agent-shade)"
          />
          <path
            d="M11 21q1-4 5-5"
            stroke={CREAM}
            opacity=".45"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </>
      )
  }
}

function CharacterFace({
  character,
  identity,
}: {
  character: AgentCharacter
  identity?: AgentVisualIdentity | undefined
}) {
  const spacing = (identity?.eyeSpacing ?? 4.5) * 1.4
  const eyes = character === 'ghost' ? [24] : [24 - spacing, 24 + spacing]
  return (
    <g className="agent-avatar-face">
      {eyes.map((cx, index) => (
        <g key={cx} transform={`rotate(${(identity?.eyeTilt ?? -5) * (index ? -1 : 1)} ${cx} 25)`}>
          <g
            className={cn('agent-avatar-eye', index === 1 && 'agent-avatar-eye-right')}
            style={{ transformOrigin: `${cx}px 25px` }}
          >
            <ellipse
              cx={cx}
              cy="25"
              rx={character === 'ghost' ? 8 : (identity?.eyeRx ?? 3.1) * 1.3}
              ry={character === 'ghost' ? 8 : (identity?.eyeRy ?? 5.2) * 1.15}
              fill={CREAM}
            />
            <g className="agent-avatar-pupil">
              <ellipse
                cx={cx + 0.4}
                cy={25 + (identity?.pupilDy ?? 0.8)}
                rx={character === 'ghost' ? 3.2 : (identity?.pupilRx ?? 1.35) * 1.2}
                ry={character === 'ghost' ? 4 : (identity?.pupilRy ?? 1.7) * 1.25}
                fill={INK}
              />
              <circle cx={cx + 1} cy="24" r=".65" fill="white" />
            </g>
          </g>
        </g>
      ))}
      {character === 'owl' ? (
        <>
          <g fill="none" stroke={INK} strokeWidth="1.6">
            <circle cx={24 - spacing} cy="25" r="7.5" />
            <circle cx={24 + spacing} cy="25" r="7.5" />
            <path d="M22 24h4" />
          </g>
          <path d="m21 34 3 4 3-4" fill="#ee8b38" />
        </>
      ) : character === 'robot' ? null : character === 'cat' ? (
        <path
          d="m22 33 2 2 2-2m-2 2q-3 4-5 1m5-1q3 4 5 1"
          fill="none"
          stroke={INK}
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      ) : character === 'ghost' || character === 'alien' ? (
        <ellipse cx="24" cy="36" rx="2" ry="2.6" fill={INK} />
      ) : (
        <>
          <path
            d={character === 'toast' ? 'M20 34q4-3 8 0' : 'M20 34q4 5 8 0'}
            fill="none"
            stroke={INK}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          {(character === 'dino' || character === 'jelly') && (
            <path d="M24 36v3q3 2 3-3" fill="#fa8ea5" />
          )}
        </>
      )}
      <g fill="#f8909b" opacity=".6">
        <ellipse cx="12" cy="32" rx="2.5" ry="1.4" />
        <ellipse cx="36" cy="32" rx="2.5" ry="1.4" />
      </g>
    </g>
  )
}

/** Original SVG cast: transform-only motion preserves surrounding layout. */
export function AgentAvatar({ working = false, size = 28, className, identity }: AgentAvatarProps) {
  const character = identity?.character ?? 'pip'
  const personality = AGENT_CHARACTERS[character]
  const hue = identity?.hue ?? 41
  const style = {
    '--agent-color': `oklch(0.75 0.15 ${hue})`,
    '--agent-shade': `oklch(0.56 0.15 ${hue})`,
    '--agent-delay': `${identity?.motionDelay ?? 0}s`,
  } as CSSProperties

  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      style={style}
      className={cn('agent-avatar', working && 'agent-avatar-working', className)}
      data-character={character}
      role="img"
      aria-label={`${personality.name}${working ? ' is working' : ', agent'}`}
    >
      <title>{`${personality.name} · ${working ? personality.trick : personality.title}`}</title>
      <ellipse
        className="agent-avatar-shadow"
        cx="24"
        cy="45"
        rx="12"
        ry="1.5"
        fill={INK}
        opacity=".1"
      />
      <g className="agent-avatar-stunt">
        <g className="agent-avatar-body">
          <CharacterBody character={character} />
          <CharacterFace character={character} identity={identity} />
        </g>
      </g>
    </svg>
  )
}
