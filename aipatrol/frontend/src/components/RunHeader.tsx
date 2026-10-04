import { cost, duration } from "../lib/format";
import { runError, runStatus, runTotals } from "../lib/runs";
import type { Run } from "../types";
import { CwdField } from "./CwdField";
import { StatusDot } from "./StatusDot";

interface Props {
  run: Run;
  onCancel: (id: string) => void;
  expandAll: boolean;
  onToggleExpandAll: () => void;
  outlineHidden: boolean;
  onToggleOutline: () => void;
  hasOutline: boolean;
}

export function RunHeader({
  run,
  onCancel,
  expandAll,
  onToggleExpandAll,
  outlineHidden,
  onToggleOutline,
  hasOutline,
}: Props) {
  const status = runStatus(run);
  const totals = runTotals(run);
  const error = runError(run);
  const toolCount = run.rounds.reduce(
    (n, r) => n + r.events.filter((e) => e.kind === "tool").length,
    0,
  );

  return (
    <header className="runhead">
      <div className="runhead__row">
        <StatusDot status={status} />
        <h2 className="runhead__title">{run.title}</h2>

        {run.source.kind === "recording" && (
          <span className="runhead__badge" title={`Replayed from ${run.source.name}`}>
            recording
          </span>
        )}

        {run.rounds.length > 1 && (
          <span className="runhead__rounds">
            {run.rounds.length} rounds
          </span>
        )}

        {toolCount > 0 && (
          <button
            type="button"
            className="text-button"
            onClick={onToggleExpandAll}
            title={
              expandAll
                ? "Fold every round and tool result back down"
                : `Expand all ${toolCount} tool calls in full`
            }
          >
            {expandAll ? "Collapse all" : "Expand all"}
          </button>
        )}

        {hasOutline && (
          <button
            type="button"
            className={`text-button${outlineHidden ? "" : " text-button--on"}`}
            onClick={onToggleOutline}
            aria-pressed={!outlineHidden}
            title={outlineHidden ? "Show the outline" : "Hide the outline"}
          >
            Outline
          </button>
        )}

        {status === "running" && (
          <button
            type="button"
            className="text-button text-button--danger"
            onClick={() => onCancel(run.id)}
          >
            Stop
          </button>
        )}
      </div>

      <div className="runhead__row runhead__row--meta">
        {/* A run's directory is fixed once it starts — it is where the
            subprocess was spawned, so it is shown but not editable. */}
        <CwdField cwd={run.cwd} onChange={() => {}} locked />

        {totals.numTurns > 0 && (
          <>
            <span className="sep" aria-hidden="true">·</span>
            <span title="Total across every round">
              {cost(totals.costUsd)} · {duration(totals.durationMs)} ·{" "}
              {totals.numTurns} turn{totals.numTurns === 1 ? "" : "s"}
            </span>
          </>
        )}

        {status === "error" && error && (
          <>
            <span className="sep" aria-hidden="true">·</span>
            <span className="runhead__error">{error}</span>
          </>
        )}
      </div>
    </header>
  );
}
