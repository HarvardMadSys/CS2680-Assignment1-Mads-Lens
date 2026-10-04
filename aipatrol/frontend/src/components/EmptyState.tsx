import { Logo } from "./Logo";

interface Props {
  cwd: string;
  hasHistory: boolean;
}

const FEATURES = [
  {
    title: "Watch the trajectory live",
    body: "Every assistant message and tool call appears as it arrives, not when the run ends. A call shows as running until its result attaches.",
  },
  {
    title: "Tasks, nested",
    body: "The agent announces each logical unit of work. Tasks hold calls, subagents and further tasks — fold one away once you trust it.",
  },
  {
    title: "Subagents on their own lane",
    body: "Delegated work nests under the call that spawned it, and several launched together run as parallel lanes that merge back.",
  },
  {
    title: "An outline you can steer by",
    body: "The whole run as a flow graph. Spot the one call that failed and click straight to it.",
  },
  {
    title: "Results, cut to size",
    body: "A test log runs to thousands of lines. You get the head and the tail — the summary line is the part you wanted.",
  },
  {
    title: "Keep the conversation",
    body: "A follow-up resumes the same session, so the agent keeps its context. Runs go on in the background while you read another.",
  },
];

export function EmptyState({ cwd, hasHistory }: Props) {
  if (hasHistory) {
    return (
      <div className="empty">
        <h2>Start another run</h2>
        <p>
          It will run against <code className="empty__cwd">{cwd}</code>. Your
          other runs keep going.
        </p>
      </div>
    );
  }

  return (
    <div className="welcome">
      <div className="welcome__mark">
        <Logo size={40} />
      </div>

      <h2 className="welcome__title">AIPatrol</h2>
      <p className="welcome__lede">
        A window onto Claude Code while it works. Describe a task and watch
        every step as it happens.
      </p>

      {/* A working directory can be a very long path — it gets its own line
          rather than tearing the sentence above into ragged pieces. */}
      <p className="welcome__cwd" title={cwd}>
        runs in <code>{cwd}</code>
      </p>

      <ul className="features">
        {FEATURES.map((feature) => (
          <li className="feature" key={feature.title}>
            <h3 className="feature__title">{feature.title}</h3>
            <p className="feature__body">{feature.body}</p>
          </li>
        ))}
      </ul>

      <p className="welcome__foot">
        Change the directory below the prompt box before your first run.
      </p>
    </div>
  );
}
