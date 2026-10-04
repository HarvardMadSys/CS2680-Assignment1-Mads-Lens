import { useCallback, useEffect, useState } from "react";

const WIDTH_KEY = "cc-ui.outline-width";
const HIDDEN_KEY = "cc-ui.outline-hidden";
const NAMES_KEY = "cc-ui.outline-names";

export const OUTLINE_MIN = 180;
export const OUTLINE_MAX = 560;
/**
 * Wide enough that two parallel lanes can each show a delegation's name.
 * At 240 a lane left about ten characters, which broke "Summarise" in half.
 */
export const OUTLINE_DEFAULT = 300;

function clamp(px: number): number {
  return Math.min(OUTLINE_MAX, Math.max(OUTLINE_MIN, Math.round(px)));
}

function read<T>(key: string, parse: (raw: string) => T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) return parse(raw);
  } catch {
    /* private mode / blocked storage — use the default */
  }
  return fallback;
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not fatal — the setting still applies for this page load */
  }
}

/** Whether the outline is shown, and how wide. Both remembered. */
export function useOutline() {
  const [hidden, setHidden] = useState(() =>
    read(HIDDEN_KEY, (raw) => raw === "1", false),
  );
  // Whether a delegation shows what it was asked to do, or just its tool.
  const [showNames, setShowNames] = useState(() =>
    read(NAMES_KEY, (raw) => raw !== "0", true),
  );
  const [width, setWidthState] = useState(() =>
    read(
      WIDTH_KEY,
      (raw) => (Number.isFinite(Number(raw)) ? clamp(Number(raw)) : OUTLINE_DEFAULT),
      OUTLINE_DEFAULT,
    ),
  );

  useEffect(() => write(HIDDEN_KEY, hidden ? "1" : "0"), [hidden]);
  useEffect(() => write(WIDTH_KEY, String(width)), [width]);
  useEffect(() => write(NAMES_KEY, showNames ? "1" : "0"), [showNames]);

  return {
    hidden,
    width,
    showNames,
    toggleNames: useCallback(() => setShowNames((v) => !v), []),
    toggleHidden: useCallback(() => setHidden((v) => !v), []),
    show: useCallback(() => setHidden(false), []),
    setWidth: useCallback((px: number) => setWidthState(clamp(px)), []),
    resetWidth: useCallback(() => setWidthState(OUTLINE_DEFAULT), []),
  };
}
