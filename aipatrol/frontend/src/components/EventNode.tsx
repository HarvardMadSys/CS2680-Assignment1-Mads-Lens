import { useCollapsible } from "../hooks/useCollapsible";
import { useReveal } from "../hooks/useReveal";
import { countEvents, groupSiblings, type TreeNode } from "../lib/tree";
import { Markdown } from "./Markdown";
import { StatusDot } from "./StatusDot";
import { ToolCall } from "./ToolCall";

/**
 * Beyond this many events, a subagent's work is collapsed by default — the
 * point of nesting is that a long delegation must not bury the main agent.
 */
const AUTO_COLLAPSE_OVER = 8;

interface Props {
  node: TreeNode;
  expandAll: boolean;
}

export function EventNode({ node, expandAll }: Props) {
  if (node.event.kind === "text") {
    return (
      <article className="ev ev--text">
        <Markdown>{node.event.text}</Markdown>
      </article>
    );
  }

  if (node.event.kind === "task") {
    return <TaskNode node={node} expandAll={expandAll} />;
  }

  return <ToolNode node={node} expandAll={expandAll} />;
}

/**
 * A logical task the agent announced, holding everything it did inside —
 * calls, prose, subagents, and further tasks. Collapsible, because the point
 * of naming a unit of work is being able to fold it away once you trust it.
 */
function TaskNode({ node, expandAll }: Props) {
  const task = node.event as Extract<TreeNode["event"], { kind: "task" }>;
  const total = countEvents(node.children);

  // A finished task folds once it is no longer the one being worked on; the
  // running one stays open, because it is what you are watching.
  const reveal = useReveal();
  // Open if it is being worked on, or small enough to be worth showing. A
  // task does not fold itself the moment it finishes — you are usually still
  // reading what it just did.
  const [open, setOpen] = useCollapsible({
    initiallyOpen: task.status === "running" || total <= AUTO_COLLAPSE_OVER,
    expandAll,
    revealed: reveal.open.has(task.id),
    revealNonce: reveal.nonce,
  });

  return (
    <section className={`task task--${task.status}`} id={`task-${task.id}`}>
      <button
        type="button"
        className="task__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="task__caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <StatusDot status={task.status} />
        <span className="task__title">{task.title}</span>
        <span className="task__count">
          {total} event{total === 1 ? "" : "s"}
        </span>
      </button>

      {open && (
        <div className="task__body">
          <EventList nodes={node.children} expandAll={expandAll} />
        </div>
      )}
    </section>
  );
}

function ToolNode({ node, expandAll }: Props) {
  const total = countEvents(node.children);
  const delegated = node.children.length > 0;

  const reveal = useReveal();
  const [open, setOpen] = useCollapsible({
    initiallyOpen: total <= AUTO_COLLAPSE_OVER,
    expandAll,
    revealed: reveal.open.has(node.event.id),
    revealNonce: reveal.nonce,
  });

  return (
    <article className="ev ev--tool" id={`call-${node.event.id}`}>
      <ToolCall
        event={node.event as never}
        expandAll={expandAll}
        delegated={delegated}
      />

      {delegated && (
        <div className={`subagent${open ? " subagent--open" : ""}`}>
          <button
            type="button"
            className="subagent__toggle"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            <span className="subagent__caret" aria-hidden="true">
              {open ? "▾" : "▸"}
            </span>
            {open
              ? `${total} event${total === 1 ? "" : "s"} from this subagent`
              : `${total} event${total === 1 ? "" : "s"} collapsed`}
          </button>

          {open && (
            <div className="subagent__body">
              <EventList nodes={node.children} expandAll={expandAll} />
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * A list of sibling events. Consecutive delegations are wrapped together, so
 * two subagents launched for one purpose read as one group of tasks rather
 * than two unrelated calls.
 */
export function EventList({
  nodes,
  expandAll,
}: {
  nodes: TreeNode[];
  expandAll: boolean;
}) {
  return (
    <>
      {groupSiblings(nodes).map((group) =>
        group.kind === "single" ? (
          <EventNode
            key={group.node.event.id}
            node={group.node}
            expandAll={expandAll}
          />
        ) : (
          <div className="tasks" key={group.nodes[0].event.id}>
            <div className="tasks__label">
              {group.kind === "parallel" ? "In parallel" : "Tasks"}
              <span className="tasks__count">{group.nodes.length}</span>
            </div>
            {group.nodes.map((n) => (
              <EventNode key={n.event.id} node={n} expandAll={expandAll} />
            ))}
          </div>
        ),
      )}
    </>
  );
}
