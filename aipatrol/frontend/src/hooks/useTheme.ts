import { useCallback, useEffect, useState } from "react";
import type { Theme, ThemePreference } from "../types";

const STORAGE_KEY = "cc-ui.theme";

function readStored(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* private mode / blocked storage — fall through to system */
  }
  return "system";
}

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * Theme state with three settings: light, dark, and system.
 * An explicit choice stamps data-theme on <html>; "system" removes the
 * attribute so the CSS media query takes over.
 */
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readStored);
  const [resolved, setResolved] = useState<Theme>(() =>
    preference === "system" ? systemTheme() : preference,
  );

  useEffect(() => {
    const root = document.documentElement;

    if (preference === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", preference);
    }

    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      /* not fatal — the theme still applies for this page load */
    }

    if (preference !== "system") {
      setResolved(preference);
      return;
    }

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setResolved(mq.matches ? "dark" : "light");
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [preference]);

  const toggle = useCallback(() => {
    setPreference(resolved === "dark" ? "light" : "dark");
  }, [resolved]);

  return { preference, resolved, setPreference, toggle };
}
