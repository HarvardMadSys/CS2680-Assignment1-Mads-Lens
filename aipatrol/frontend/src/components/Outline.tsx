import { createContext, useContext } from "react";
import { useCollapsible } from "../hooks/useCollapsible";
import { countFlowItems, type FlowItem } from "../lib/tree";
import { isDelegating, toolTarget } from "../lib/tools";
import type { TaskEvent, ToolEvent } from "../types";
import { StatusDot } from "./StatusDot";

interface Props {
  items: FlowItem[];
  callCount: number;
  failureCount: number;
  /** Narrow layout: the outline is a strip that can fold away. */
  folded: boolean;
  onToggleFold: () => void;
  /** Drag the left edge to resize; double-click it to reset. */
  onResize: (px: number) => void;
  onResetWidth: () => void;
  onHide: () => void;
  /** Open whatever contains this event, then scroll to it. */
  onReveal: (eventId: string, domId: string) => void;
  /** The run-level expand-all also opens every lane here. */
  expandAll: boolean;
  /** Label delegations by what they were asked to do, rather than "Agent". */
  showNames: boolean;
  onToggleNames: () => void;
}

/**
 * A map of the run, drawn as a flow: a spine running top to bottom with one
 * node per call. A delegation opens a lane; several launched together fork
 * into parallel lanes and merge back. Names only — enough to survey the shape
 * of a run at a glance, and to jump to any call.
 */
export function Outline({
  items,
  callCount,
  failureCount,
  folded,
  onToggleFold,
  onResize,
  onResetWidth,
  onHide,
  onReveal,
  expandAll,
  showNames,
  onToggleNames,
}: Props) {
  // The outline sits on the right, so dragging the handle left widens it.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);

    const startX = e.clientX;
    const startWidth = handle.parentElement?.getBoundingClientRect().width ?? 0;

    const onMove = (move: PointerEvent) =>
      onResize(startWidth + (startX - move.clientX));
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  return (
    <aside className="outline" aria-label="Trajectory outline">
      <div
        className="outline__grip"
        onPointerDown={onPointerDown}
        onDoubleClick={onResetWidth}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize outline (double-click to reset)"
        title="Drag to resize · double-click to reset"
      />

      <header className="outline__bar">
        <button
          type="button"
          className="outline__head"
          onClick={onToggleFold}
          aria-expanded={!folded}
        >
          <span className="outline__title">Outline</span>
          <span className="outline__count">
            {callCount} call{callCount === 1 ? "" : "s"}
            {failureCount > 0 && (
              <span className="outline__fails"> · {failureCount} failed</span>
            )}
          </span>
          <span className="outline__caret" aria-hidden="true">
            {folded ? "▸" : "▾"}
          </span>
        </button>

        <button
          type="button"
          className={`outline__names${showNames ? " outline__names--on" : ""}`}
          onClick={onToggleNames}
          aria-pressed={showNames}
          title={
            showNames
              ? "Showing what each subagent was asked to do — switch to tool names"
              : "Showing tool names — switch to what each subagent was asked to do"
          }
        >
          {showNames ? "Names" : "Tools"}
        </button>

      <button
        type="button"
        className="outline__hide"
        onClick={onHide}
        aria-label="Hide outline"
        title="Hide outline"
      >
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
      </header>

      {!folded && (
        <div className="outline__body">
          <RevealFn.Provider value={onReveal}>
            <ExpandAll.Provider value={expandAll}>
              <ShowNames.Provider value={showNames}>
                <Flow items={items} />
              </ShowNames.Provider>
            </ExpandAll.Provider>
          </RevealFn.Provider>
        </div>
      )}
    </aside>
  );
}

const RevealFn = createContext<(eventId: string, domId: string) => void>(
  () => {},
);

const ExpandAll = createContext(false);
const ShowNames = createContext(true);

/**
 * Past this many pills a lane arrives folded. A long run is mostly scrolling
 * otherwise — thirty calls in one lane buries everything after it.
 */
const FOLD_LANE_OVER = 8;

function Flow({ items }: { items: FlowItem[] }) {
  return (
    <div className="flow">
      {items.map((item, i) => (
        <FlowRow key={item.id} item={item} atEnd={i === items.length - 1} />
      ))}
    </div>
  );
}

/**
 * `atEnd` means nothing follows this item *anywhere*, not merely in its own
 * list. A fork at the end of a task's lane still has to merge, because the
 * run carries on after the task — without that, lanes stop dead and the next
 * node appears to descend out of blank space.
 */
function FlowRow({ item, atEnd }: { item: FlowItem; atEnd: boolean }) {
  const reveal = useContext(RevealFn);

  if (item.kind === "round") {
    return (
      <div className="flow__item">
        <button
          type="button"
          className={`node node--round node--${item.status}`}
          onClick={() => reveal(item.id, `round-${item.id}`)}
          title={`${item.prompt} — ${ROUND_LABEL[item.status]}`}
        >
          <StatusDot status={item.status} />
          <span className="node__label">You</span>
        </button>
      </div>
    );
  }

  if (item.kind === "call") {
    return (
      <div className="flow__item">
        <CallPill call={item.call} />
      </div>
    );
  }

  if (item.kind === "task") {
    return (
      <div className="flow__item">
        <TaskPill task={item.task} />
      </div>
    );
  }

  // Lanes merge back into the spine only when something follows. A fork that
  // ends the run has nothing to merge into, so each lane simply stops.
  return (
    <div className="flow__item">
      <div
        className={
          "flow__branches" +
          // One lane is not a fork — it is nested work, and has to look it.
          (item.branches.length === 1 ? " flow__branches--single" : "") +
          (atEnd ? " flow__branches--open" : "")
        }
      >
        {item.branches.map((lane, i) => (
          <Lane key={lane[0]?.id ?? i} items={lane} atEnd={atEnd} />
        ))}
      </div>
    </div>
  );
}

/** Tool status and run status share the three names, so reuse the dot. */
function statusOf(status: ToolEvent["status"]) {
  return status === "ok" ? "done" : status === "error" ? "error" : "running";
}

const ROUND_LABEL = {
  running: "in progress",
  done: "finished",
  error: "failed",
} as const;

const CALL_LABEL = {
  pending: "still running",
  ok: "succeeded",
  error: "failed",
} as const;

function TaskPill({ task }: { task: TaskEvent }) {
  const reveal = useContext(RevealFn);
  return (
    <button
      type="button"
      className={`node node--task node--${task.status}`}
      onClick={() => reveal(task.id, `task-${task.id}`)}
      title={`Task: ${task.title} · ${ROUND_LABEL[task.status]}`}
    >
      <StatusDot status={task.status} />
      <span className="node__label">{task.title}</span>
    </button>
  );
}

/**
 * One lane: its head pill, and everything it did, behind a caret. Folding
 * here is how a thirty-call run stays surveyable — the outline exists to be
 * read at a glance, so any one branch has to be foldable away.
 */
function Lane({ items, atEnd }: { items: FlowItem[]; atEnd: boolean }) {
  const [head, ...body] = items;
  const total = countFlowItems(body);
  const expandAll = useContext(ExpandAll);

  const [open, setOpen] = useCollapsible({
    initiallyOpen: total <= FOLD_LANE_OVER,
    expandAll,
    revealed: false,
    revealNonce: 0,
  });

  return (
    <div className="flow__lane">
      <div className="flow__head">
        {total > 0 && (
          <button
            type="button"
            className="flow__caret"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Fold this branch" : `Unfold ${total} more`}
            title={open ? "Fold this branch" : `Unfold ${total} more`}
          >
            {open ? "▾" : "▸"}
          </button>
        )}
        {head && <FlowRow item={head} atEnd={atEnd && body.length === 0} />}
      </div>

      {open ? (
        body.map((sub, j) => (
          <FlowRow
            key={sub.id}
            item={sub}
            atEnd={atEnd && j === body.length - 1}
          />
        ))
      ) : (
        <button
          type="button"
          className="flow__folded"
          onClick={() => setOpen(true)}
        >
          {total} more
        </button>
      )}

      {/* Stretches so every lane reaches the merge, whatever its length. */}
      {!atEnd && <div className="flow__tail" />}
    </div>
  );
}

function CallPill({ call }: { call: ToolEvent }) {
  const reveal = useContext(RevealFn);
  const target = toolTarget(call.name, call.input);
  const detail = `${call.name}${target ? ` — ${target}` : ""} · ${CALL_LABEL[call.status]}`;

  // A delegation is a named piece of work, and the name is the whole point:
  // two lanes both labelled "Agent" say nothing about which is which. Every
  // other call is identified by its tool.
  const delegating = isDelegating(call.name);
  const named = useContext(ShowNames);
  const label = delegating && named && target ? target : call.name;

  return (
    <button
      type="button"
      className={`node node--${call.status}${
        delegating && named ? " node--agent" : ""
      }`}
      onClick={() => reveal(call.id, `call-${call.id}`)}
      title={detail}
    >
      {/* The same three-state vocabulary the history list and run header use. */}
      <StatusDot status={statusOf(call.status)} />
      <span className="node__label">{label}</span>
    </button>
  );
}

