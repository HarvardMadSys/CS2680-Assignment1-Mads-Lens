import { Coffee, Sparkles } from 'lucide-react'
import { useRef, useState } from 'react'
import { AgentAvatar } from '@/components/AgentAvatar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { AGENT_CHARACTERS, SUBAGENT_CHARACTERS } from '@/lib/agentCharacters'
import { agentIdentityFor } from '@/lib/timeline/agentIdentity'
import { cn } from '@/lib/utils'

const LEAD = { character: 'pip' as const, identity: undefined }
const CREW = [
  LEAD,
  ...SUBAGENT_CHARACTERS.map((character, index) => ({
    character,
    identity: agentIdentityFor(`crew-preview-${character}`, index),
  })),
]

/** A sandbox for the mascots. Preview controls never dispatch work to an agent. */
export function AgentCrew() {
  const [selected, setSelected] = useState(0)
  const [working, setWorking] = useState(true)
  const spotlightRef = useRef<HTMLDivElement>(null)
  const member = CREW[selected] ?? LEAD
  const personality = AGENT_CHARACTERS[member.character]

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="agent-crew-trigger"
          aria-label="Meet the Patchwork crew"
          title="Meet the Patchwork crew"
        >
          <AgentAvatar size={28} />
        </button>
      </DialogTrigger>
      <DialogContent className="agent-crew-dialog">
        <div className="agent-crew-heading">
          <span className="agent-crew-eyebrow">
            <Sparkles size={13} /> THE PATCHWORK COLLECTIVE
          </span>
          <DialogTitle className="agent-crew-title">
            Different time zones. Same bad idea.
          </DialogTitle>
          <DialogDescription>
            Thirteen hackers. One group chat. A deeply questionable amount of experience.
          </DialogDescription>
        </div>
        <div
          className="agent-crew-spotlight"
          ref={spotlightRef}
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="agent-crew-portrait">
            <span className="agent-crew-doodle agent-crew-doodle-one" aria-hidden="true">
              ✧
            </span>
            <AgentAvatar identity={member.identity} size={128} working={working} />
            <span className="agent-crew-doodle agent-crew-doodle-two" aria-hidden="true">
              ✳
            </span>
          </div>
          <div className="agent-crew-bio">
            <span className="agent-crew-eyebrow">
              {selected === 0
                ? 'THE PERSON WHO STARTED THE GROUP CHAT'
                : `CREW DOSSIER / ${String(selected).padStart(2, '0')}`}
            </span>
            <h3>
              {personality.name}
              <span>{personality.title}</span>
            </h3>
            <p className="agent-crew-origin">
              <span aria-hidden="true">{personality.flag}</span>
              {personality.location}
            </p>
            <p className="agent-crew-specialty">{personality.specialty}</p>
          </div>
          <div className="agent-crew-record">
            <p className="agent-crew-story">{personality.story}</p>
            <p className="agent-crew-experience">
              <span>QUESTIONABLE CREDENTIALS</span>
              {personality.experience}
            </p>
            <p className="agent-crew-quote">“{personality.quote}”</p>
            <p className="agent-crew-activity">
              <span className={cn('agent-crew-dot', working && 'is-working')} />
              {working ? personality.trick : 'Off duty. Still a little odd.'}
            </p>
          </div>
        </div>
        <div className="agent-crew-toolbar">
          <span className="agent-crew-hint">Everyone has a past. Pick a suspect.</span>
          <fieldset className="agent-crew-mode" aria-label="Preview animation">
            <button type="button" aria-pressed={!working} onClick={() => setWorking(false)}>
              <Coffee size={13} />
              On a break
            </button>
            <button type="button" aria-pressed={working} onClick={() => setWorking(true)}>
              <Sparkles size={13} />
              On a mission
            </button>
          </fieldset>
        </div>
        <div className="agent-crew-grid">
          {CREW.map(({ character, identity }, index) => {
            const friend = AGENT_CHARACTERS[character]
            return (
              <button
                type="button"
                key={character}
                className="agent-crew-card"
                aria-label={`Meet ${friend.name}`}
                aria-pressed={selected === index}
                onClick={() => {
                  setSelected(index)
                  spotlightRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
                }}
              >
                <AgentAvatar size={54} identity={identity} working={working} />
                <span className="agent-crew-card-name">{friend.shortName}</span>
                <span className="agent-crew-card-detail">
                  <span aria-hidden="true">{friend.flag}</span> {friend.location.split(',')[0]}
                </span>
              </button>
            )
          })}
        </div>
        <p className="agent-crew-footnote">
          Fictional résumés. Very real facial expressions. Hover for a hello.
        </p>
      </DialogContent>
    </Dialog>
  )
}
