"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Caps } from "@/lib/types";

export default function Config({ cwd }: { cwd: string }) {
  const [caps, setCaps] = useState<Caps | null>(null);
  const [specs, setSpecs] = useState<any[]>([]);
  const [path, setPath] = useState("");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");

  const refresh = () => {
    if (!cwd) return;
    api.caps(cwd).then(setCaps).catch(() => setCaps(null));
    api.specs(cwd).then(setSpecs).catch(() => setSpecs([]));
  };
  useEffect(refresh, [cwd]);

  const open = async (p: string) => { setPath(p); setText((await api.doc(p)).text); setSaved(""); };
  const save = async () => { await api.putDoc(path, text); setSaved("saved"); refresh(); };
  const newSpec = () => {
    const name = prompt("spec name")?.trim();
    if (name) { setPath(`${cwd}/.claude/specs/${name}.md`); setText(`# ${name}\n\n## goal\n\n## constraints\n\n## acceptance\n`); setSaved(""); }
  };

  return (
    <>
      <div className="sect">
        <div className="sect-h">Documents</div>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {(caps?.claude_md ?? []).map((p) => <button className="ghost" key={p} data-on={path === p ? "1" : "0"} onClick={() => open(p)}>{p.replace(cwd, ".")}</button>)}
          <button className="ghost" onClick={() => open(`${cwd}/CLAUDE.md`)}>+ CLAUDE.md</button>
          {(caps?.settings ?? []).map((p) => <button className="ghost" key={p} data-on={path === p ? "1" : "0"} onClick={() => open(p)}>{p.replace(cwd, ".")}</button>)}
          {specs.map((s) => <button className="ghost" key={s.path} data-on={path === s.path ? "1" : "0"} onClick={() => open(s.path)}>spec/{s.name}</button>)}
          <button className="ghost" onClick={newSpec}>+ spec</button>
        </div>
        {path && (
          <>
            <div className="row" style={{ margin: "8px 0" }}>
              <span className="muted mono ell grow">{path}</span>
              <span className="muted">{saved}</span>
              <button className="go" onClick={save}>save</button>
            </div>
            <textarea className="doc" value={text} onChange={(e) => { setText(e.target.value); setSaved(""); }} />
          </>
        )}
      </div>

      {caps && (
        <div className="sect">
          <div className="sect-h">Visible to the agent</div>
          <Group title="mcp servers" items={caps.mcp.map((m) => `${m.name} · ${m.transport}`)} />
          <Group title="skills" items={caps.skills.map((s) => `/${s.name}`)} />
          <Group title="commands" items={caps.commands.map((s) => `/${s.name}`)} />
          <Group title="subagents" items={caps.agents.map((s) => s.name)} />
        </div>
      )}
    </>
  );
}

function Group({ title, items }: { title: string; items: string[] }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="muted" style={{ fontSize: 11.5 }}>{title} · {items.length}</div>
      <div className="grid2">{items.length === 0 ? <span className="muted">—</span> : items.map((i) => <span key={i}>{i}</span>)}</div>
    </div>
  );
}
