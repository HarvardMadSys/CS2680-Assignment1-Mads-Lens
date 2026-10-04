import { useEffect, useRef, useState } from "react";

interface Options {
  /** Where it starts, decided once — when the section first appears. */
  initiallyOpen: boolean;
  /** The run-level expand/collapse. */
  expandAll: boolean;
  /** The outline asked to jump to something inside this section. */
  revealed: boolean;
  /** Changes on every reveal, so a repeat jump re-opens. */
  revealNonce: number;
}

/**
 * Open/closed state for a section that can also be commanded open.
 *
 * The commands apply *when they change*, not continuously. That distinction
 * is the whole point: a section growing underneath must never re-derive its
 * own state, or every arriving event would discard whatever you had chosen —
 * and a lane would snap shut the instant a new child pushed it past the fold
 * threshold, while you were watching it.
 */
export function useCollapsible({
  initiallyOpen,
  expandAll,
  revealed,
  revealNonce,
}: Options) {
  const [open, setOpen] = useState(initiallyOpen || revealed);

  // Effects run on mount too, which would overwrite the initial choice above
  // with the command's idea of it. Only later changes are commands.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setOpen(expandAll);
  }, [expandAll]);

  useEffect(() => {
    if (revealed) setOpen(true);
  }, [revealed, revealNonce]);

  return [open, setOpen] as const;
}
