"use client";
import { useEffect, useState } from "react";
import { ms } from "@/lib/format";

/**
 * How long a call has been running, and — when we have seen the same call before — how far
 * through it probably is. Past the estimate the bar gives up and just counts, because a wrong
 * ETA that keeps insisting is worse than none.
 */
export default function Progress({ since, eta }: { since: number; eta?: number }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 200);
    return () => clearInterval(t);
  }, []);

  const el = Math.max(0, (now - since) * 1000);
  const over = eta == null || el > eta;
  return (
    <span className="pg" data-over={over ? "1" : "0"}>
      <span className="pg-bar" style={over ? undefined : { width: `${(el / eta!) * 100}%` }} />
      <span className="pg-t">{ms(el)}{over ? "" : ` / ~${ms(eta!)}`}</span>
    </span>
  );
}
