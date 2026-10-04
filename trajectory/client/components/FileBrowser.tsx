"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { num } from "@/lib/format";

type N = { name: string; path: string; dir: boolean; children?: N[]; edits?: number; versions?: number; size?: number };

export default function FileBrowser({ cwd, tick }: { cwd: string; tick?: number }) {
  const [data, setData] = useState<any>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [file, setFile] = useState<{ text: string } | null>(null);
  const [vers, setVers] = useState<any[]>([]);
  const [diff, setDiff] = useState<any>(null);
  const [showDiff, setShowDiff] = useState(false);

  useEffect(() => { if (cwd) api.files(cwd).then(setData).catch(() => setData(null)); }, [cwd, tick]);
  useEffect(() => {
    if (!sel) return;
    setDiff(null); setShowDiff(false);
    api.file(sel).then(setFile).catch(() => setFile(null));
    api.versions(sel).then((v) => setVers(v.versions)).catch(() => setVers([]));
  }, [sel]);

  if (!data) return <div className="sect muted">no directory</div>;

  return (
    <>
      {!sel && <Tree node={data.tree} max={data.max_edits ?? 0} depth={0} sel={sel} onSel={setSel} open />}
      {sel && (
        <>
          <div className="fhead">
            <button className="link" onClick={() => setSel(null)}>←</button>
            <span className="mono ell grow">{sel.replace(cwd, ".")}</span>
            {diff && <button className="link" onClick={() => setShowDiff((v) => !v)}>{showDiff ? "file" : "diff"}</button>}
            {diff && <span className="muted">+{diff.added} −{diff.removed}</span>}
          </div>
          {vers.length > 0 && (
            <div className="vers">
              {vers.map((v) => (
                <button className="ver" key={v.id} data-on={diff?.id === v.id ? "1" : "0"}
                  onClick={() => api.diff(v.id).then((d) => { setDiff({ ...d, id: v.id }); setShowDiff(true); })}>
                  <span className={`vk ${v.kind}`}>{v.kind}</span> <span className="muted ell">{v.prompt}</span>
                </button>
              ))}
            </div>
          )}
          {showDiff && diff ? <DiffView diff={diff} /> : <Source text={file?.text ?? ""} changed={diff?.changed ?? []} />}
        </>
      )}
    </>
  );
}

function Tree({ node, max, depth, sel, onSel, open: init }: { node: N; max: number; depth: number; sel: string | null; onSel: (p: string) => void; open?: boolean }) {
  const [open, setOpen] = useState(init ?? depth < 2);
  if (node.dir) {
    return (
      <>
        <button className="fnode" style={{ paddingLeft: 12 + depth * 12 }} onClick={() => setOpen((v) => !v)}>
          <span className="fcar">{open ? "▾" : "▸"}</span>
          <span className="grow ell">{node.name}</span>
          {node.edits ? <span className="fcount">{node.edits}</span> : null}
        </button>
        {open && (node.children ?? []).map((c) => (
          <Tree key={c.path} node={c} max={max} depth={depth + 1} sel={sel} onSel={onSel} />
        ))}
      </>
    );
  }
  const heat = max ? (node.edits ?? 0) / max : 0;
  return (
    <button className="fnode" data-on={sel === node.path ? "1" : "0"} style={{ paddingLeft: 24 + depth * 12 }}
      onClick={() => onSel(node.path)} title={`${node.edits ?? 0} edits · ${node.versions ?? 0} versions · ${num(node.size)}B`}>
      <span className="grow ell" style={{ color: node.edits ? "var(--fg)" : undefined }}>{node.name}</span>
      {node.edits ? <span className="fheat"><i style={{ width: `${Math.max(12, heat * 100)}%`, opacity: 0.35 + 0.65 * heat }} /></span> : null}
    </button>
  );
}

function Source({ text, changed }: { text: string; changed: number[] }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const hot = useMemo(() => new Set(changed), [changed]);
  return (
    <div className="srcwrap">
      <div className="src">
        {lines.map((l, i) => (
          <div className="sl" key={i} data-hot={hot.has(i + 1) ? "1" : "0"}>
            <span className="ln">{i + 1}</span><span className="lt">{l || " "}</span>
          </div>
        ))}
      </div>
      {changed.length > 0 && (
        <div className="minimap" title={`${changed.length} lines changed`}>
          {changed.map((n) => <i key={n} style={{ top: `${((n - 1) / Math.max(1, lines.length)) * 100}%` }} />)}
        </div>
      )}
    </div>
  );
}

function DiffView({ diff }: { diff: any }) {
  if (!diff.diff) return <div className="sect muted">no change between these snapshots</div>;
  return (
    <div className="src">
      {(diff.diff as string).split("\n").map((l, i) => (
        <div className="sl" key={i}
          data-d={l.startsWith("+") && !l.startsWith("+++") ? "a" : l.startsWith("-") && !l.startsWith("---") ? "r" : l.startsWith("@@") ? "h" : ""}>
          <span className="lt">{l || " "}</span>
        </div>
      ))}
    </div>
  );
}
