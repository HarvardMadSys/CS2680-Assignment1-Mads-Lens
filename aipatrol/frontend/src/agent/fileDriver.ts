import type { AgentDriver } from "./driver";
import { dispatchEvent } from "./parseEvent";

/** Events are paced so a loaded run can be watched, not just appear. */
const STEP_MS = 180;

/**
 * Replays a recording the reader picked from their own disk.
 *
 * Nothing leaves the browser: the file is read with the File API and pushed
 * through the same parser a live run uses, so what you see is what the real
 * stream would have produced. That makes any `.jsonl` captured from
 * `claude -p --output-format stream-json` inspectable without a server, an
 * agent, or any spend.
 */
export function createFileDriver(file: File): AgentDriver {
  return (_options, handlers) => {
    let cancelled = false;

    (async () => {
      let text: string;
      try {
        text = await file.text();
      } catch (err) {
        handlers.onError(`Could not read ${file.name}: ${message(err)}`);
        return;
      }

      const lines = text.split("\n").filter((line) => line.trim());
      if (lines.length === 0) {
        handlers.onError(`${file.name} is empty.`);
        return;
      }

      let dispatched = 0;

      for (const line of lines) {
        if (cancelled) return;

        try {
          dispatchEvent(JSON.parse(line), handlers);
          dispatched += 1;
        } catch {
          // A recording may carry a stray log line; skip it rather than
          // abandoning the rest of the run.
          console.warn("Skipping unparseable line in", file.name);
        }

        await wait(STEP_MS);
      }

      if (cancelled) return;

      if (dispatched === 0) {
        handlers.onError(
          `${file.name} has no readable events. Is it stream-json output?`,
        );
      }
      // A well-formed recording ends with its own result event, which has
      // already finished the round. One that does not simply stops here.
    })();

    return () => {
      cancelled = true;
    };
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
