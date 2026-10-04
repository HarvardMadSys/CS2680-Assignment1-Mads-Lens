import { basename, relativeTime } from "../lib/format";
import { runStatus } from "../lib/runs";
import type { Run } from "../types";
import { StatusDot } from "./StatusDot";

interface Props {
  runs: Run[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

export function Sidebar({ runs, activeId, onSelect, onNew, onDelete }: Props) {
  return (
    <nav className="sidebar" aria-label="Run history">
      <div className="sidebar__head">
        <span className="sidebar__label">History</span>
        <button type="button" className="new-run" onClick={onNew}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
            fill="none" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New run
        </button>
      </div>

      <ul className="runlist">
        {runs.length === 0 && (
          <li className="runlist__empty">No runs yet.</li>
        )}

        {runs.map((run) => (
          <li key={run.id}>
            <div
              className={`runitem${run.id === activeId ? " runitem--active" : ""}`}
            >
              <button
                type="button"
                className="runitem__main"
                onClick={() => onSelect(run.id)}
                aria-current={run.id === activeId ? "true" : undefined}
              >
                <span className="runitem__top">
                  <StatusDot status={runStatus(run)} />
                  <span className="runitem__title">{run.title}</span>
                </span>
                <span className="runitem__meta">
                  <span className="runitem__cwd" title={run.cwd}>
                    {basename(run.cwd)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{relativeTime(run.startedAt)}</span>
                </span>
              </button>

              <button
                type="button"
                className="runitem__delete"
                onClick={() => onDelete(run.id)}
                aria-label={`Delete run: ${run.title}`}
                title="Delete run"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"
                  fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </li>
        ))}
      </ul>
    </nav>
  );
}
