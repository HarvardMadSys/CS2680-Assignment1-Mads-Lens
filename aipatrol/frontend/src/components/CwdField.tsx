import { useEffect, useRef, useState } from "react";
import { basename } from "../lib/format";

interface Props {
  cwd: string;
  onChange: (next: string) => void;
  /** Read-only display, e.g. the directory a past run already used. */
  locked?: boolean;
}

/**
 * The working directory the next run will be launched against.
 * A browser cannot open a native directory picker for an arbitrary path, so
 * this is a text field; the server validates the path when the run starts.
 */
export function CwdField({ cwd, onChange, locked }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cwd);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commit() {
    const next = draft.trim();
    if (next && next !== cwd) onChange(next);
    else setDraft(cwd);
    setEditing(false);
  }

  function cancel() {
    setDraft(cwd);
    setEditing(false);
  }

  if (locked) {
    return (
      <span className="cwd cwd--locked" title={cwd}>
        <FolderIcon />
        <span className="cwd__path">{cwd}</span>
      </span>
    );
  }

  if (editing) {
    return (
      <span className="cwd cwd--editing">
        <FolderIcon />
        <input
          ref={inputRef}
          className="cwd__input"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          aria-label="Working directory"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
        />
      </span>
    );
  }

  return (
    <button
      type="button"
      className="cwd cwd--button"
      onClick={() => {
        setDraft(cwd);
        setEditing(true);
      }}
      title={`${cwd}  (click to change)`}
    >
      <FolderIcon />
      <span className="cwd__path">
        <span className="cwd__dim">{cwd.slice(0, cwd.length - basename(cwd).length)}</span>
        <span className="cwd__leaf">{basename(cwd)}</span>
      </span>
    </button>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}
