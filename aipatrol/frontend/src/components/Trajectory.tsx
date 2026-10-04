import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReveal } from "../hooks/useReveal";
import { isRunning } from "../lib/runs";
import type { Run } from "../types";
import { Round } from "./Round";

interface Props {
  run: Run;
  expandAll: boolean;
}

/** Treat the view as "at the bottom" within this many px. */
const STICK_SLOP = 48;

export function Trajectory({ run, expandAll }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const { target, nonce } = useReveal();

  // Follow the tail only while the reader is already at the bottom. Scrolling
  // up to read an earlier event must not be yanked back when the next one lands.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !stuck) return;
    el.scrollTop = el.scrollHeight;
  }, [run, stuck]);

  /**
   * Scroll to a revealed target. The sections above it were opened in the
   * same render, so the element does not exist until this effect runs — and
   * it needs one more frame for layout to settle before it can be centred.
   */
  useEffect(() => {
    if (!target) return;
    let frame = 0;

    const run = (attempt: number) => {
      const el = document.getElementById(target);
      if (!el) {
        // A deeply nested target can take a couple of frames to appear.
        if (attempt < 5) frame = requestAnimationFrame(() => run(attempt + 1));
        return;
      }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ev--flash");
      window.setTimeout(() => el.classList.remove("ev--flash"), 1200);
    };

    frame = requestAnimationFrame(() => run(0));
    return () => cancelAnimationFrame(frame);
  }, [target, nonce]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setStuck(distance <= STICK_SLOP);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Jumping to the newest round is the useful move once you have scrolled off.
  const showJump = !stuck;

  return (
    // The wrapper does not scroll, so the jump button can stay pinned to the
    // bottom of the view instead of scrolling away with the content.
    <div className="transcript-wrap">
      <div className="transcript" ref={scrollerRef}>
        <div className="transcript__inner">
          {run.rounds.map((round, i) => (
            <Round
              key={round.id}
              round={round}
              // The newest round stays open; earlier ones fold once you have
              // moved past them.
              foldByDefault={i < run.rounds.length - 1}
              expandAll={expandAll}
            />
          ))}
        </div>
      </div>

      {showJump && (
        <button
          type="button"
          className="jump"
          onClick={() => {
            const el = scrollerRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            setStuck(true);
          }}
        >
          {isRunning(run) ? "Jump to latest ↓" : "Jump to end ↓"}
        </button>
      )}
    </div>
  );
}
