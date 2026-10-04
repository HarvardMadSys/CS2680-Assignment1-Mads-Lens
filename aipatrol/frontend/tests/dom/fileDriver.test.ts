import { describe, expect, it, vi } from "vitest";
import { createFileDriver } from "../../src/agent/fileDriver";
import { handlers } from "../helpers";

/**
 * A recording opened from disk replays through the same parser a live run
 * uses, so the page cannot tell the difference — that is what makes it a
 * usable stand-in while working on the rendering.
 */

const recording = (lines: unknown[], name = "events.jsonl") =>
  new File([lines.map((l) => JSON.stringify(l)).join("\n")], name, {
    type: "application/x-ndjson",
  });

const options = { prompt: "ignored", cwd: "/tmp", sessionId: null };

/** Let the driver's paced loop drain. */
async function drain() {
  await vi.runAllTimersAsync();
}

describe("createFileDriver", () => {
  it("replays a recording through the handlers, in order", async () => {
    vi.useFakeTimers();
    const h = handlers();

    createFileDriver(
      recording([
        { type: "system", subtype: "init", session_id: "s1" },
        { type: "assistant", message: { content: [{ type: "text", text: "on it" }] } },
        { type: "result", subtype: "success", session_id: "s1", num_turns: 1 },
      ]),
    )(options, h);

    await drain();

    expect(h.onSession).toHaveBeenCalledWith("s1");
    expect(h.onText).toHaveBeenCalledWith("on it", null);
    expect(h.onDone).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  // A recording may carry a stray log line; losing the rest of the run over
  // it would be worse than skipping it.
  it("skips a line it cannot parse and keeps going", async () => {
    vi.useFakeTimers();
    const h = handlers();

    const file = new File(
      [
        [
          JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first" }] } }),
          "not json at all",
          JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "second" }] } }),
        ].join("\n"),
      ],
      "messy.jsonl",
    );

    createFileDriver(file)(options, h);
    await drain();

    expect(h.onText.mock.calls.map((c) => c[0])).toEqual(["first", "second"]);
    expect(h.onError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("says so when the file holds no events", async () => {
    vi.useFakeTimers();
    const h = handlers();

    createFileDriver(new File(["   \n  \n"], "empty.jsonl"))(options, h);
    await drain();

    expect(h.onError.mock.calls[0][0]).toContain("empty.jsonl");
    vi.useRealTimers();
  });

  it("says so when nothing in the file is an event", async () => {
    vi.useFakeTimers();
    const h = handlers();

    createFileDriver(new File(["hello\nworld"], "notes.txt"))(options, h);
    await drain();

    expect(h.onError.mock.calls[0][0]).toContain("no readable events");
    vi.useRealTimers();
  });

  // Cancelling has to stop the replay, not merely stop rendering it.
  it("stops when cancelled", async () => {
    vi.useFakeTimers();
    const h = handlers();

    const cancel = createFileDriver(
      recording(
        Array.from({ length: 20 }, (_, i) => ({
          type: "assistant",
          message: { content: [{ type: "text", text: `line ${i}` }] },
        })),
      ),
    )(options, h);

    await vi.advanceTimersByTimeAsync(400);
    const sent = h.onText.mock.calls.length;
    cancel();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.onText.mock.calls.length).toBe(sent);
    expect(sent).toBeLessThan(20);
    vi.useRealTimers();
  });
});
