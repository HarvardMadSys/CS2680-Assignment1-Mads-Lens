import { cost, duration } from "../lib/format";
import type { Round } from "../types";

/**
 * How a round ended, at its foot. The run header carries the same status
 * permanently; this marks the spot in the stream where it happened, which is
 * where you are looking when it does.
 */
export function RoundOutcome({ round }: { round: Round }) {
  if (round.status === "running") {
    return (
      <div className="outcome outcome--running">
        <span className="thinking" aria-label="Working">
          <i /><i /><i />
        </span>
        <span className="outcome__label">running</span>
        {round.resumedFrom && (
          <span className="outcome__meta">
            resumed session <Session id={round.resumedFrom} />
          </span>
        )}
      </div>
    );
  }

  if (round.status === "done") {
    return (
      <div className="outcome outcome--done" role="status">
        <span className="outcome__mark">✓</span>
        <span className="outcome__label">finished</span>
        <span className="outcome__meta">
          {round.costUsd !== undefined && (
            <>
              <span title="What this round cost (total_cost_usd)">
                {cost(round.costUsd)}
              </span>
              {" · "}
              <span title="Wall-clock time for this round (duration_ms)">
                {duration(round.durationMs ?? 0)}
              </span>
              {" · "}
              <span title="Assistant turns in this round (num_turns)">
                {round.numTurns} turn{round.numTurns === 1 ? "" : "s"}
              </span>
            </>
          )}
          {round.sessionId && (
            <>
              {" · "}session <Session id={round.sessionId} />
            </>
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="outcome outcome--error" role="alert">
      <div className="outcome__head">
        <span className="outcome__mark">✕</span>
        <span className="outcome__label">failed</span>
      </div>
      {round.error && <p className="outcome__error">{round.error}</p>}
    </div>
  );
}

/** Session ids are long and only the head is worth reading at a glance. */
function Session({ id }: { id: string }) {
  return (
    <code className="session" title={id}>
      {id.slice(0, 8)}…
    </code>
  );
}
