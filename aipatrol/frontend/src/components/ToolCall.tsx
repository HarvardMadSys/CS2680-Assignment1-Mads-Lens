import { useEffect, useState } from "react";
import { basename } from "../lib/format";
import {
  foldResult,
  formatInput,
  targetIsPath,
  toolTarget,
  toolVerb,
} from "../lib/tools";
import type { ToolEvent } from "../types";

interface Props {
  event: ToolEvent;
  /** Run-level "expand all": opens every pane and unfolds every result. */
  expandAll: boolean;
  /** This call spawned a subagent, whose events nest under it. */
  delegated?: boolean;
}

export function ToolCall({ event, expandAll, delegated }: Props) {
  /** Open = the full input and the unfolded result. */
  const [open, setOpen] = useState(expandAll);

  // Follow the run-level toggle, including for calls that arrive while it is
  // already on. Individual toggles still work afterwards.
  useEffect(() => {
    setOpen(expandAll);
  }, [expandAll]);

  const target = toolTarget(event.name, event.input);
  const verb = toolVerb(event.name);
  const isPath = targetIsPath(event.name);

  const failed = event.status === "error";
  const result = event.result ?? "";
  const hasResult = event.status !== "pending" && result.length > 0;
  const fold = hasResult ? foldResult(event.name, failed, result) : null;

  return (
    <div
      className={`tool tool--${event.status}${open ? " tool--open" : ""}${
        delegated ? " tool--delegating" : ""
      }`}
    >
      <button
        type="button"
        className="tool__row"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Chevron open={open} />
        <span className="tool__name">{event.name}</span>

        {target && (
          <span className={`tool__target${isPath ? " tool__target--path" : ""}`}>
            {isPath ? (
              <>
                <span className="tool__dir">
                  {target.slice(0, target.length - basename(target).length)}
                </span>
                {basename(target)}
              </>
            ) : (
              target
            )}
          </span>
        )}

        <ToolStatusMark status={event.status} />
      </button>

      {/* The full input, only when asked for — the row already names the
          field that matters. */}
      {open && (
        <section className="tool__section">
          <h4>
            Input{verb ? <span className="tool__verb"> · {verb}</span> : null}
          </h4>
          <pre className="tool__pre tool__pre--full">
            {formatInput(event.input)}
          </pre>
        </section>
      )}

      {/* The result sits with its call, folded unless expanded. */}
      {hasResult && fold && (
        <section className="tool__section">
          {open && (
            <h4>
              Result
              <span className="tool__count">
                {fold.totalLines} line{fold.totalLines === 1 ? "" : "s"}
              </span>
            </h4>
          )}

          <pre className={`tool__pre${open ? " tool__pre--full" : ""}`}>
            {open ? (
              result
            ) : (
              <>
                {fold.head.join("\n")}
                {fold.hiddenLines > 0 && (
                  <>
                    {"\n"}
                    <span
                      className="fold"
                      role="button"
                      tabIndex={0}
                      onClick={() => setOpen(true)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setOpen(true);
                        }
                      }}
                    >
                      ⋯ {fold.hiddenLines} more line
                      {fold.hiddenLines === 1 ? "" : "s"} — show all
                    </span>
                    {"\n"}
                  </>
                )}
                {fold.tail.join("\n")}
              </>
            )}
          </pre>
        </section>
      )}
    </div>
  );
}

function ToolStatusMark({ status }: { status: ToolEvent["status"] }) {
  if (status === "pending") {
    return (
      <span className="tool__mark tool__mark--pending" title="Still running">
        <span className="spinner" aria-hidden="true" />
        <span className="tool__marklabel">running</span>
      </span>
    );
  }
  if (status === "ok") {
    return (
      <span
        className="tool__mark tool__mark--ok"
        title="Succeeded"
        aria-label="Succeeded"
      >
        ✓
      </span>
    );
  }
  return (
    <span
      className="tool__mark tool__mark--error"
      title="Failed"
      aria-label="Failed"
    >
      failed
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`chevron${open ? " chevron--open" : ""}`}
      viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="2.4"
      strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
