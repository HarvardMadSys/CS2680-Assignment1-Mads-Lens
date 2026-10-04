import { useCallback, useEffect, useState } from "react";
import { DEFAULT_SCHEME, isScheme } from "../lib/schemes";
import type { Scheme } from "../types";

const STORAGE_KEY = "cc-ui.scheme";

function readStored(): Scheme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isScheme(raw)) return raw;
  } catch {
    /* private mode / blocked storage — fall through to the default */
  }
  return DEFAULT_SCHEME;
}

/**
 * The colour palette, orthogonal to light/dark. Stamped as `data-scheme` on
 * <html>; the default is left off the element entirely, so bare `:root` holds
 * it and a page with no preference needs no attribute.
 */
export function useScheme() {
  const [scheme, setScheme] = useState<Scheme>(readStored);

  useEffect(() => {
    const root = document.documentElement;

    if (scheme === DEFAULT_SCHEME) root.removeAttribute("data-scheme");
    else root.setAttribute("data-scheme", scheme);

    try {
      localStorage.setItem(STORAGE_KEY, scheme);
    } catch {
      /* not fatal — the scheme still applies for this page load */
    }
  }, [scheme]);

  return { scheme, setScheme: useCallback((s: Scheme) => setScheme(s), []) };
}
