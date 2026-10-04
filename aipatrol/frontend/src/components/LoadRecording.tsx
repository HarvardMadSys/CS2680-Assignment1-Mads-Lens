import { useRef, useState } from "react";

interface Props {
  onLoad: (file: File) => void;
}

/**
 * Opens a recorded run from the reader's own disk.
 *
 * The file never leaves the browser — it is parsed here and replayed through
 * the same code a live run uses, so any `.jsonl` captured from
 * `claude -p --output-format stream-json` can be inspected without a server,
 * an agent, or any spend.
 */
export function LoadRecording({ onLoad }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  function accept(file: File | undefined) {
    if (!file) return;

    // The picker's filter is a hint, not a guarantee — a dragged or renamed
    // file still arrives here.
    if (!/\.(jsonl|ndjson|json|txt)$/i.test(file.name)) {
      setProblem(`${file.name} is not a .jsonl recording.`);
      return;
    }

    setProblem(null);
    onLoad(file);
  }

  return (
    <>
      <button
        type="button"
        className="icon-button"
        onClick={() => inputRef.current?.click()}
        aria-label="Open a recorded run"
        title="Open a recorded run (.jsonl) — replayed in the browser"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
          fill="none" stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          <path d="M12 16v-5" />
          <path d="m9.5 13.5 2.5-2.5 2.5 2.5" />
        </svg>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept=".jsonl,.ndjson,.json,.txt"
        hidden
        onChange={(e) => {
          accept(e.target.files?.[0]);
          // Clearing it means picking the same file twice still fires.
          e.target.value = "";
        }}
      />

      {problem && (
        <p className="load-problem" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}
