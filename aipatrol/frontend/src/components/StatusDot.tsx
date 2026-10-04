import type { RunStatus } from "../types";

const LABEL: Record<RunStatus, string> = {
  running: "Running",
  done: "Finished",
  error: "Failed",
};

export function StatusDot({ status }: { status: RunStatus }) {
  return (
    <span
      className={`status-dot status-dot--${status}`}
      role="img"
      aria-label={LABEL[status]}
      title={LABEL[status]}
    />
  );
}
