import { useEffect, useState } from "react";
import { useReveal } from "../hooks/useReveal";
import { buildTree, countEvents, splitConclusion } from "../lib/tree";
import type { Round as RoundType } from "../types";
import { EventList } from "./EventNode";
import { RoundOutcome } from "./RoundOutcome";

interface Props {
  round: RoundType;
  /** The newest round stays open; earlier ones fold once a new one starts. */
  foldByDefault: boolean;
  expandAll: boolean;
}

/**
 * One prompt and everything the agent did about it.
 *
 * A finished round folds once you have moved on from it, but folding keeps
 * the conclusion — the closing assistant text — visible. What you want back
 * from an old round is what it decided, not the 23 steps it took.
 */
export function Round({ round, foldByDefault, expandAll }: Props) {
  const [folded, setFolded] = useState(foldByDefault);
  const { open, nonce } = useReveal();
  const targeted = open.has(round.id);

  useEffect(() => {
    setFolded(expandAll || targeted ? false : foldByDefault);
    // `nonce` re-runs this when the same target is clicked again, after the
    // reader has folded the round back up in between.
  }, [expandAll, foldByDefault, targeted, nonce]);

  const { conclusion, work } = splitConclusion(buildTree(round.events));
  const hidden = countEvents(work);
  const canFold = hidden > 0;
  const showWork = !canFold || !folded;

  return (
    <section className="round" id={`round-${round.id}`}>
      <article className="ev ev--prompt">
        <div className="ev__role">You</div>
        <div className="prompt-body">{round.prompt}</div>
      </article>

      {round.resumedFrom && round.status !== "running" && (
        <p className="round__resumed">
          continues session{" "}
          <code title={round.resumedFrom}>{round.resumedFrom.slice(0, 8)}…</code>
        </p>
      )}

      {canFold && folded && (
        <button
          type="button"
          className="fold-round"
          onClick={() => setFolded(false)}
        >
          <span className="fold-round__caret" aria-hidden="true">▸</span>
          {hidden} event{hidden === 1 ? "" : "s"}, folded
        </button>
      )}

      {showWork && <EventList nodes={work} expandAll={expandAll} />}

      {/* The conclusion survives folding. */}
      <EventList nodes={conclusion} expandAll={expandAll} />

      <RoundOutcome round={round} />
    </section>
  );
}
