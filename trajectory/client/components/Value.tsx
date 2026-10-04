"use client";
import { useState } from "react";
import { lineDiff, trimContext } from "@/lib/diff";

const MULTILINE = (s: string) => s.includes("\n") || s.length > 110;

/** A tool's arguments, laid out the way that tool is actually read. */
export function ToolInput({ name, input }: { name: string; input: any }) {
  const [raw, setRaw] = useState(false);
  if (!input || typeof input !== "object") return <Json value={input} />;

  const body = raw ? <pre className="v-raw">{JSON.stringify(input, null, 2)}</pre> : shape(name, input);
  return (
    <>
      <div className="v-head">
        <span>input</span>
        <button className="link" onClick={() => setRaw((v) => !v)}>{raw ? "formatted" : "raw"}</button>
      </div>
      {body}
    </>
  );
}

function shape(name: string, i: any) {
  const rest = (skip: string[]) =>
    Object.entries(i).filter(([k, v]) => !skip.includes(k) && v !== undefined && v !== "");

  switch (name) {
    case "Bash":
      return (
        <>
          <Code text={i.command ?? ""} prompt />
          <Fields entries={rest(["command"])} />
        </>
      );
    case "Edit":
    case "MultiEdit":
      return (
        <>
          <Path p={i.file_path} />
          {i.edits ? (i.edits as any[]).map((e, k) => <Diff key={k} a={e.old_string} b={e.new_string} />)
                   : <Diff a={i.old_string ?? ""} b={i.new_string ?? ""} />}
          <Fields entries={rest(["file_path", "old_string", "new_string", "edits"])} />
        </>
      );
    case "Write":
      return (
        <>
          <Path p={i.file_path} />
          <Code text={String(i.content ?? "")} />
          <Fields entries={rest(["file_path", "content"])} />
        </>
      );
    case "Read":
    case "NotebookEdit":
      return (
        <>
          <Path p={i.file_path ?? i.notebook_path} />
          <Fields entries={rest(["file_path", "notebook_path"])} />
        </>
      );
    case "Task":
    case "Agent":
      return (
        <>
          {i.description && <div className="v-lead">{i.description}</div>}
          {i.prompt && <blockquote className="v-prose">{i.prompt}</blockquote>}
          <Fields entries={rest(["description", "prompt"])} />
        </>
      );
    case "TodoWrite":
      return (
        <ul className="v-todo">
          {(i.todos ?? []).map((t: any, k: number) => (
            <li key={k} data-s={t.status}>{t.content ?? t.activeForm}</li>
          ))}
        </ul>
      );
    default:
      return <Fields entries={rest([])} />;
  }
}

function Fields({ entries }: { entries: [string, any][] }) {
  if (!entries.length) return null;
  return (
    <dl className="v-f">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{k.replace(/_/g, " ")}</dt>
          <dd><Json value={v} /></dd>
        </div>
      ))}
    </dl>
  );
}

const Path = ({ p }: { p?: string }) =>
  p ? <div className="v-path" title={p}>{p.replace(/^.*\/(?=[^/]*\/[^/]*$)/, "…/")}</div> : null;

export function Code({ text, prompt }: { text: string; prompt?: boolean }) {
  return <pre className="v-code" data-prompt={prompt ? "1" : "0"}>{text}</pre>;
}

function Diff({ a, b }: { a: string; b: string }) {
  const lines = trimContext(lineDiff(a ?? "", b ?? ""));
  return (
    <div className="v-diff">
      {lines.map((l, k) => (
        <div key={k} data-t={l.t}>{l.t === "…" ? `⋯ ${l.s}` : `${l.t} ${l.s}`}</div>
      ))}
    </div>
  );
}

/** Anything else: strings become text, not escaped JSON; objects and arrays nest. */
export function Json({ value, depth = 0 }: { value: any; depth?: number }) {
  if (value === null || value === undefined) return <span className="v-null">—</span>;
  if (typeof value === "boolean") return <span className="v-lit">{String(value)}</span>;
  if (typeof value === "number") return <span className="v-lit">{value}</span>;
  if (typeof value === "string")
    return MULTILINE(value) ? <pre className="v-code">{value}</pre> : <span className="v-str">{value}</span>;

  if (Array.isArray(value)) {
    if (!value.length) return <span className="v-null">empty</span>;
    if (value.every((v) => typeof v !== "object" || v === null))
      return <span className="v-str">{value.join(", ")}</span>;
    return (
      <ol className="v-list">
        {value.map((v, k) => <li key={k}><Json value={v} depth={depth + 1} /></li>)}
      </ol>
    );
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (!entries.length) return <span className="v-null">empty</span>;
  return <Fields entries={entries} />;
}

/** Tool results are usually plain text; when they are JSON, show them like JSON. */
export function ResultBody({ text }: { text: string }) {
  const [raw, setRaw] = useState(false);
  const t = text.trim();
  const parsed = (t.startsWith("{") || t.startsWith("[")) ? safe(t) : undefined;
  if (parsed === undefined) return <pre>{text}</pre>;
  return (
    <>
      <div className="v-head"><span /><button className="link" onClick={() => setRaw((v) => !v)}>{raw ? "formatted" : "raw"}</button></div>
      {raw ? <pre>{text}</pre> : <Json value={parsed} />}
    </>
  );
}

const safe = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
