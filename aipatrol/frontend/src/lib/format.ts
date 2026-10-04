/** "just now", "4m ago", "2h ago", "3d ago" */
export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Wall-clock duration, from the result event's duration_ms.
 * Precision drops as the number grows: tenths matter at 5.5s, not at 42s.
 */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const totalSeconds = ms / 1000;
  if (totalSeconds < 10) return `${totalSeconds.toFixed(1)}s`;

  const seconds = Math.round(totalSeconds);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** total_cost_usd. Free is not the same as "less than a cent". */
export function cost(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Trailing path segment, for compact display of a working directory. */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  // "/" trims to nothing; the root still needs a name.
  if (!trimmed) return path ? "/" : "";
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1) || "/";
}

/** First line of a prompt, clipped — used as a run's title. */
export function titleFrom(prompt: string, max = 60): string {
  const line = prompt.trim().split("\n")[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
