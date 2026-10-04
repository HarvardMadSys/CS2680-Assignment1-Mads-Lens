import { describe, expect, it } from "vitest";
import { dispatchEvent } from "../../src/agent/parseEvent";
import { handlers, sawNothing } from "../helpers";

/** An assistant message carrying the given content blocks. */
const assistant = (content: unknown[], parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { content },
});

describe("system events", () => {
  it("announces the session from init", () => {
    const h = handlers();
    dispatchEvent({ type: "system", subtype: "init", session_id: "s1" }, h);
    expect(h.onSession).toHaveBeenCalledWith("s1");
  });

  // The other subtypes repeat the same id throughout the run; treating them
  // as session events would keep re-announcing it.
  it("ignores the other system subtypes", () => {
    const h = handlers();
    dispatchEvent({ type: "system", subtype: "task_started", session_id: "s1" }, h);
    dispatchEvent({ type: "system", subtype: "task_progress", session_id: "s1" }, h);
    expect(h.onSession).not.toHaveBeenCalled();
  });

  it("ignores an init with no session id", () => {
    const h = handlers();
    dispatchEvent({ type: "system", subtype: "init" }, h);
    expect(h.onSession).not.toHaveBeenCalled();
  });
});

describe("assistant events", () => {
  it("passes text blocks through", () => {
    const h = handlers();
    dispatchEvent(assistant([{ type: "text", text: "on it" }]), h);
    expect(h.onText).toHaveBeenCalledWith("on it", null);
  });

  it("drops blank text rather than rendering an empty bubble", () => {
    const h = handlers();
    dispatchEvent(assistant([{ type: "text", text: "  \n " }]), h);
    expect(h.onText).not.toHaveBeenCalled();
  });

  it("reads a tool_use block", () => {
    const h = handlers();
    dispatchEvent(
      assistant([
        { type: "tool_use", id: "call_a", name: "Bash", input: { command: "ls" } },
      ]),
      h,
    );
    expect(h.onToolUse).toHaveBeenCalledWith({
      id: "call_a",
      name: "Bash",
      input: { command: "ls" },
      parentToolUseId: null,
      // On its own in its message, so nothing ran alongside it.
      batchId: null,
    });
  });

  /**
   * Several tool_use blocks in one assistant message is the only evidence the
   * stream gives that the agent ran calls in parallel.
   */
  it("marks calls issued in one message as one batch", () => {
    const h = handlers();
    dispatchEvent(
      assistant([
        { type: "tool_use", id: "call_a", name: "Read", input: {} },
        { type: "tool_use", id: "call_b", name: "Read", input: {} },
      ]),
      h,
    );

    const batches = h.onToolUse.mock.calls.map(([c]) => c.batchId);
    expect(batches[0]).toBeTruthy();
    expect(batches[0]).toBe(batches[1]);
  });

  it("keeps separate messages in separate batches", () => {
    const h = handlers();
    const two = [
      { type: "tool_use", id: "a", name: "Read", input: {} },
      { type: "tool_use", id: "b", name: "Read", input: {} },
    ];
    dispatchEvent(assistant(two), h);
    dispatchEvent(assistant(two), h);

    const ids = h.onToolUse.mock.calls.map(([c]) => c.batchId);
    expect(new Set(ids).size).toBe(2);
  });

  it("defaults a missing or malformed input to an empty object", () => {
    const h = handlers();
    dispatchEvent(assistant([{ type: "tool_use", id: "a", name: "Bash" }]), h);
    dispatchEvent(
      assistant([{ type: "tool_use", id: "b", name: "Bash", input: "nope" }]),
      h,
    );
    expect(h.onToolUse.mock.calls.map((c) => c[0].input)).toEqual([{}, {}]);
  });

  it("skips a tool_use missing its id or name", () => {
    const h = handlers();
    dispatchEvent(assistant([{ type: "tool_use", name: "Bash" }]), h);
    dispatchEvent(assistant([{ type: "tool_use", id: "a" }]), h);
    expect(h.onToolUse).not.toHaveBeenCalled();
  });

  it("dispatches every block of a multi-block message, in order", () => {
    const h = handlers();
    dispatchEvent(
      assistant([
        { type: "text", text: "first" },
        { type: "tool_use", id: "a", name: "Read", input: {} },
        { type: "text", text: "second" },
      ]),
      h,
    );
    expect(h.onText.mock.calls.map((c) => c[0])).toEqual(["first", "second"]);
    expect(h.onToolUse).toHaveBeenCalledOnce();
  });

  // parent_tool_use_id is a top-level field, not part of the block.
  it("carries the parent id onto text and calls alike", () => {
    const h = handlers();
    dispatchEvent(
      assistant(
        [
          { type: "text", text: "sub says" },
          { type: "tool_use", id: "call_b", name: "Read", input: {} },
        ],
        "call_a",
      ),
      h,
    );
    expect(h.onText).toHaveBeenCalledWith("sub says", "call_a");
    expect(h.onToolUse.mock.calls[0][0].parentToolUseId).toBe("call_a");
  });

  it("survives a message with no usable content", () => {
    const h = handlers();
    dispatchEvent({ type: "assistant" }, h);
    dispatchEvent({ type: "assistant", message: { content: "text" } }, h);
    dispatchEvent({ type: "assistant", message: { content: [null, 3] } }, h);
    expect(h.onText).not.toHaveBeenCalled();
    expect(h.onToolUse).not.toHaveBeenCalled();
  });
});

describe("tool results", () => {
  const result = (block: Record<string, unknown>) => ({
    type: "user",
    message: { content: [{ type: "tool_result", ...block }] },
  });

  it("matches the call by tool_use_id and defaults to ok", () => {
    const h = handlers();
    dispatchEvent(result({ tool_use_id: "call_a", content: "output" }), h);
    expect(h.onToolResult).toHaveBeenCalledWith({
      id: "call_a",
      ok: true,
      content: "output",
    });
  });

  it("marks is_error results failed", () => {
    const h = handlers();
    dispatchEvent(
      result({ tool_use_id: "a", content: "boom", is_error: true }),
      h,
    );
    expect(h.onToolResult.mock.calls[0][0].ok).toBe(false);
  });

  // Content arrives as a string or as an array of blocks; both are real.
  it("joins an array of content blocks", () => {
    const h = handlers();
    dispatchEvent(
      result({
        tool_use_id: "a",
        content: [{ type: "text", text: "one" }, { type: "image" }, "two"],
      }),
      h,
    );
    expect(h.onToolResult.mock.calls[0][0].content).toBe("one\ntwo");
  });

  it("renders anything else it is handed", () => {
    const h = handlers();
    dispatchEvent(result({ tool_use_id: "a", content: null }), h);
    dispatchEvent(result({ tool_use_id: "b", content: { code: 2 } }), h);
    expect(h.onToolResult.mock.calls.map((c) => c[0].content)).toEqual([
      "",
      '{\n  "code": 2\n}',
    ]);
  });

  it("skips a result with no tool_use_id to match on", () => {
    const h = handlers();
    dispatchEvent(result({ content: "output" }), h);
    expect(h.onToolResult).not.toHaveBeenCalled();
  });
});

describe("the result event", () => {
  it("reports the numbers off a successful run", () => {
    const h = handlers();
    dispatchEvent(
      {
        type: "result",
        subtype: "success",
        session_id: "s1",
        total_cost_usd: 0.06,
        duration_ms: 2_800,
        num_turns: 2,
      },
      h,
    );
    expect(h.onDone).toHaveBeenCalledWith({
      sessionId: "s1",
      costUsd: 0.06,
      durationMs: 2_800,
      numTurns: 2,
    });
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("zeroes numbers the CLI did not send", () => {
    const h = handlers();
    dispatchEvent({ type: "result", subtype: "success", num_turns: "2" }, h);
    expect(h.onDone).toHaveBeenCalledWith({
      sessionId: "",
      costUsd: 0,
      durationMs: 0,
      numTurns: 0,
    });
  });

  it("treats a non-success subtype as a failure, with its text", () => {
    const h = handlers();
    dispatchEvent(
      { type: "result", subtype: "error_max_turns", result: "Turn limit." },
      h,
    );
    expect(h.onError).toHaveBeenCalledWith("Turn limit.");
    expect(h.onDone).not.toHaveBeenCalled();
  });

  it("names the subtype when the failure carries no text", () => {
    const h = handlers();
    dispatchEvent({ type: "result", subtype: "error_max_turns" }, h);
    expect(h.onError).toHaveBeenCalledWith(
      'Run ended with subtype "error_max_turns".',
    );
  });

  it("honours is_error even on a success subtype", () => {
    const h = handlers();
    dispatchEvent(
      { type: "result", subtype: "success", is_error: true, result: "nope" },
      h,
    );
    expect(h.onError).toHaveBeenCalledWith("nope");
    expect(h.onDone).not.toHaveBeenCalled();
  });
});

describe("events the server adds", () => {
  it("surfaces _error", () => {
    const h = handlers();
    dispatchEvent({ type: "_error", message: "claude not found on PATH" }, h);
    expect(h.onError).toHaveBeenCalledWith("claude not found on PATH");
  });

  it("has something to say when _error carries no message", () => {
    const h = handlers();
    dispatchEvent({ type: "_error" }, h);
    expect(h.onError).toHaveBeenCalledWith("The run failed.");
  });

  // stderr is progress noise, and a run that dies reports it via _error.
  it("keeps _stderr off the trajectory", () => {
    const h = handlers();
    dispatchEvent({ type: "_stderr", text: "warning: …" }, h);
    expect(sawNothing(h)).toBe(true);
  });
});

describe("anything else", () => {
  it("ignores unknown types and non-objects without throwing", () => {
    const h = handlers();
    for (const event of [null, "text", 42, [], { type: "future_thing" }, {}]) {
      expect(() => dispatchEvent(event, h)).not.toThrow();
    }
    expect(sawNothing(h)).toBe(true);
  });
});
