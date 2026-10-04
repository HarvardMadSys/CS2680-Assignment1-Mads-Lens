"use client";
import { useEffect, useState } from "react";

const KEY = "cwd";

/**
 * Working directory, persisted in localStorage. `null` until it has been read, so nothing can
 * start a run against a fallback directory (an agent with skipped permissions in $HOME is not a
 * mistake worth making twice).
 */
export function useCwd(): [string | null, (p: string) => void] {
  const [cwd, set] = useState<string | null>(null);
  useEffect(() => {
    try { set(localStorage.getItem(KEY) || ""); } catch { set(""); }
    const sync = (e: StorageEvent) => { if (e.key === KEY) set(e.newValue || ""); };
    addEventListener("storage", sync);
    return () => removeEventListener("storage", sync);
  }, []);
  return [cwd, (p: string) => { try { localStorage.setItem(KEY, p); } catch {} set(p); }];
}
