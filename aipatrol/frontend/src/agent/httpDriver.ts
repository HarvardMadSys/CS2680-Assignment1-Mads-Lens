import type { AgentDriver } from "./driver";
import { dispatchEvent } from "./parseEvent";

/**
 * Talks to the local server, which spawns the CLI. The response is a stream of
 * newline-delimited JSON — the CLI's own events, forwarded — so each complete
 * line is parsed and dispatched the moment it arrives.
 *
 * Each call is its own request, so concurrent runs are simply concurrent
 * fetches. Aborting closes the response, which is what tells the server to
 * kill the subprocess.
 */
export const httpDriver: AgentDriver = (
  { prompt, cwd, sessionId },
  handlers,
) => {
  const controller = new AbortController();

  (async () => {
    let response: Response;
    try {
      response = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, cwd, sessionId }),
        signal: controller.signal,
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        handlers.onError(
          `Could not reach the server. Is it running? (${message(err)})`,
        );
      }
      return;
    }

    if (!response.ok || !response.body) {
      // A rejected run (bad directory, missing prompt) answers with JSON.
      const detail = await response
        .json()
        .then((b) => (b as { error?: string }).error)
        .catch(() => null);
      handlers.onError(detail || `Server returned ${response.status}.`);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Everything up to the last newline is complete; the rest is a
        // partial line waiting for the next chunk.
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.trim()) handleLine(line, handlers);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) handleLine(buffer, handlers);
    } catch (err) {
      if (!controller.signal.aborted) {
        handlers.onError(`Stream ended unexpectedly: ${message(err)}`);
      }
    }
  })();

  return () => controller.abort();
};

function handleLine(line: string, handlers: RunHandlersLike) {
  try {
    dispatchEvent(JSON.parse(line), handlers);
  } catch {
    // A malformed line is a bug worth seeing, not one to swallow.
    console.warn("Unparseable event line:", line);
  }
}

type RunHandlersLike = Parameters<typeof dispatchEvent>[1];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
