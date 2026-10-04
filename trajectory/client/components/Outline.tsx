"use client";
import { toolArg } from "@/lib/format";
import type { Outline as O } from "@/lib/tree";
import Progress from "./Progress";

const glyph = { pending: "◌", ok: "✓", error: "✕" } as const;
const cls = { pending: "pend", ok: "ok", error: "err" } as const;

export type Group = { label: string; items: O[] };

export default function Outline({ groups, inputs }: { groups: Group[]; inputs: Record<string, any> }) {
  if (!groups.some((g) => g.items.length)) return <div className="sect muted">no calls yet</div>;
  return (
    <div className="ol">
      {groups.map((g, gi) => (
        <div key={gi}>
          {groups.length > 1 && <div className="ol-turn" title={g.label}>{g.label}</div>}
          {g.items.map((i, k) => (
            <a className="ol-i" key={`${i.id}-${k}`} href={`#t-${i.id}`} style={{ paddingLeft: 11 + i.depth * 12 }}>
              <span className={`st ${cls[i.status]}`}>{glyph[i.status]}</span>
              <b>{i.name}</b>
              <span className="arg">{i.summary || toolArg(i.name, inputs[i.id])}</span>
              {i.status === "pending" && <Progress since={i.since} eta={i.eta} />}
            </a>
          ))}
        </div>
      ))}
    </div>
  );
}

export function OutlineStrip({ groups }: { groups: Group[] }) {
  const items = groups.flatMap((g) => g.items);
  if (!items.length) return null;
  return (
    <div className="ol-strip">
      {items.map((i, k) => (
        <a className={`ol-chip ${cls[i.status]}`} key={`${i.id}-${k}`} href={`#t-${i.id}`}>
          {"·".repeat(i.depth)}{i.name}
        </a>
      ))}
    </div>
  );
}
