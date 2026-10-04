import { createContext, useContext } from "react";

/**
 * What the outline asks the dialogue to open.
 *
 * Collapsed sections are not rendered, so scrolling to something inside one
 * has to open its ancestors first and wait for them to appear. `nonce` makes
 * a repeat click on the same target count as a fresh request.
 */
export interface RevealState {
  /** Container ids that must be open. */
  open: ReadonlySet<string>;
  /** The DOM id to scroll to once it exists. */
  target: string | null;
  nonce: number;
}

export const EMPTY_REVEAL: RevealState = {
  open: new Set(),
  target: null,
  nonce: 0,
};

export const RevealContext = createContext<RevealState>(EMPTY_REVEAL);

export function useReveal() {
  return useContext(RevealContext);
}

/** Should this collapsible be open because something inside it was targeted? */
export function useRevealed(id: string): boolean {
  return useReveal().open.has(id);
}
