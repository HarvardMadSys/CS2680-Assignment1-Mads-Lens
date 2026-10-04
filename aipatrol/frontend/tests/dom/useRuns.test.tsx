import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDriver, RunHandlers, StartOptions } from "../../src/agent/driver";
import { useRuns } from "../../src/hooks/useRuns";

/**
 * A driver that records every invocation instead of talking to the server, so
 * a test can play the agent: start a run, then hand it events by hand.
 */
function fakeDriver() {
  const calls: {
    options: StartOptions;
    handlers: RunHandlers;
    cancel: ReturnType<typeof vi.fn>;
  }[] = [];

  const driver: AgentDriver = (options, handlers) => {
    const cancel = vi.fn();
    calls.push({ options, handlers, cancel });
    return cancel;
  };

  return { driver, calls, last: () => calls[calls.length - 1] };
}

function setup() {
  const agent = fakeDriver();
  const hook = renderHook(() => useRuns(agent.driver));
  return { agent, hook, result: hook.result };
}

const done = (over: Partial<Parameters<RunHandlers["onDone"]>[0]> = {}) => ({
  sessionId: "s1",
  costUsd: 0.06,
  durationMs: 2_800,
  numTurns: 2,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("starting a run", () => {
  it("opens a running round and makes it active", () => {
    const { agent, result } = setup();

    act(() => void result.current.startRun("fix the parser", "/tmp/scratch"));

    const run = result.current.runs[0];
    expect(result.current.runs).toHaveLength(1);
    expect(run).toMatchObject({ title: "fix the parser", cwd: "/tmp/scratch" });
    expect(run.rounds).toHaveLength(1);
    expect(run.rounds[0]).toMatchObject({
      prompt: "fix the parser",
      status: "running",
      resumedFrom: null,
      events: [],
    });
    expect(result.current.active?.id).toBe(run.id);
    expect(result.current.runningCount).toBe(1);

    expect(agent.last().options).toEqual({
      prompt: "fix the parser",
      cwd: "/tmp/scratch",
      sessionId: null,
    });
  });

  it("puts the newest run at the head of the history", () => {
    const { result } = setup();

    act(() => void result.current.startRun("first", "/tmp"));
    act(() => void result.current.startRun("second", "/tmp"));

    expect(result.current.runs.map((r) => r.title)).toEqual(["second", "first"]);
  });
});

describe("events arriving", () => {
  it("records the session as soon as init lands", () => {
    const { agent, result } = setup();
    act(() => void result.current.startRun("go", "/tmp"));

    act(() => agent.last().handlers.onSession("sess-42"));

    expect(result.current.runs[0].sessionId).toBe("sess-42");
    expect(result.current.runs[0].rounds[0].sessionId).toBe("sess-42");
  });

  it("appends text and calls in arrival order", () => {
    const { agent, result } = setup();
    act(() => void result.current.startRun("go", "/tmp"));
    const h = agent.last().handlers;

    act(() => {
      h.onText("on it", null);
      h.onToolUse({ id: "call_a", name: "Bash", input: { command: "ls" }, parentToolUseId: null });
    });

    const events = result.current.runs[0].rounds[0].events;
    expect(events.map((e) => e.kind)).toEqual(["text", "tool"]);
    expect(events[1]).toMatchObject({ id: "call_a", name: "Bash", status: "pending" });
  });

  // The result may arrive many events later; it completes the call where it
  // already sits rather than appending a second row.
  it("completes a call in place, matching on its id", () => {
    const { agent, result } = setup();
    act(() => void result.current.startRun("go", "/tmp"));
    const h = agent.last().handlers;

    act(() => {
      h.onToolUse({ id: "call_a", name: "Bash", input: {}, parentToolUseId: null });
      h.onToolUse({ id: "call_b", name: "Read", input: {}, parentToolUseId: null });
      h.onText("meanwhile", null);
      h.onToolResult({ id: "call_a", ok: true, content: "total 0" });
      h.onToolResult({ id: "call_b", ok: false, content: "ENOENT" });
    });

    const events = result.current.runs[0].rounds[0].events;
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ status: "ok", result: "total 0" });
    expect(events[1]).toMatchObject({ status: "error", result: "ENOENT" });
    expect(events[0].kind === "tool" && events[0].endedAt).toBeGreaterThan(0);
  });

  it("ignores a result for a call it never saw", () => {
    const { agent, result } = setup();
    act(() => void result.current.startRun("go", "/tmp"));

    act(() => agent.last().handlers.onToolResult({ id: "ghost", ok: true, content: "x" }));

    expect(result.current.runs[0].rounds[0].events).toEqual([]);
  });

  it("keeps a subagent's parent id on the event", () => {
    const { agent, result } = setup();
    act(() => void result.current.startRun("go", "/tmp"));

    act(() => agent.last().handlers.onText("sub says", "call_a"));

    expect(result.current.runs[0].rounds[0].events[0].parentToolUseId).toBe("call_a");
  });
});

describe("finishing", () => {
  it("records the numbers off the result event", () => {
    const { agent, result } = setup();
    act(() => void result.current.startRun("go", "/tmp"));

    act(() => agent.last().handlers.onDone(done()));

    expect(result.current.runs[0].rounds[0]).toMatchObject({
      status: "done",
      sessionId: "s1",
      costUsd: 0.06,
      durationMs: 2_800,
      numTurns: 2,
    });
    expect(result.current.runningCount).toBe(0);
  });

  // Nothing is coming for a call still open when the round ends.
  it("closes out calls left pending, on success and on failure", () => {
    for (const finish of [
      (h: RunHandlers) => h.onDone(done()),
      (h: RunHandlers) => h.onError("The CLI exited."),
    ]) {
      const { agent, result } = setup();
      act(() => void result.current.startRun("go", "/tmp"));
      const h = agent.last().handlers;

      act(() => h.onToolUse({ id: "call_a", name: "Bash", input: {}, parentToolUseId: null }));
      act(() => finish(h));

      const [event] = result.current.runs[0].rounds[0].events;
      expect(event).toMatchObject({ status: "error" });
      expect(event.kind === "tool" && event.result).toBeTruthy();
    }
  });

  it("keeps the session from init when the round fails", () => {
    const { agent, result } = setup();
    act(() => void result.current.startRun("go", "/tmp"));
    const h = agent.last().handlers;

    act(() => h.onSession("sess-42"));
    act(() => h.onError("Turn limit."));

    expect(result.current.runs[0].rounds[0]).toMatchObject({
      status: "error",
      error: "Turn limit.",
      sessionId: "sess-42",
    });
    expect(result.current.runs[0].sessionId).toBe("sess-42");
  });
});

describe("following up", () => {
  it("opens a round that resumes the run's session", () => {
    const { agent, result } = setup();
    act(() => void result.current.startRun("go", "/tmp"));
    act(() => agent.last().handlers.onSession("sess-42"));
    act(() => agent.last().handlers.onDone(done({ sessionId: "sess-42" })));

    act(() => result.current.sendFollowUp(result.current.runs[0].id, "now the README"));

    const run = result.current.runs[0];
    expect(run.rounds).toHaveLength(2);
    expect(run.rounds[1]).toMatchObject({
      prompt: "now the README",
      resumedFrom: "sess-42",
      status: "running",
    });
    expect(agent.last().options).toEqual({
      prompt: "now the README",
      cwd: "/tmp",
      sessionId: "sess-42",
    });
  });

  // A failed round does not end the conversation — the session survives it.
  it("resumes after a failed round", () => {
    const { agent, result } = setup();
    act(() => void result.current.startRun("go", "/tmp"));
    act(() => agent.last().handlers.onSession("sess-42"));
    act(() => agent.last().handlers.onError("Turn limit."));

    act(() => result.current.sendFollowUp(result.current.runs[0].id, "try again"));

    expect(agent.last().options.sessionId).toBe("sess-42");
  });

  it("refuses to interleave a follow-up with a round still running", () => {
    const { agent, result } = setup();
    act(() => void result.current.startRun("go", "/tmp"));

    act(() => result.current.sendFollowUp(result.current.runs[0].id, "and again"));

    expect(result.current.runs[0].rounds).toHaveLength(1);
    expect(agent.calls).toHaveLength(1);
  });

  it("ignores a follow-up to a run that is gone", () => {
    const { agent, result } = setup();
    act(() => result.current.sendFollowUp("nope", "hello"));
    expect(agent.calls).toHaveLength(0);
  });
});

describe("stopping and deleting", () => {
  it("aborts the driver and marks the round stopped", () => {
    const { agent, result } = setup();
    act(() => void result.current.startRun("go", "/tmp"));
    const { handlers: h, cancel } = agent.last();

    act(() => h.onToolUse({ id: "call_a", name: "Bash", input: {}, parentToolUseId: null }));
    act(() => result.current.cancelRun(result.current.runs[0].id));

    expect(cancel).toHaveBeenCalledOnce();
    expect(result.current.runs[0].rounds[0]).toMatchObject({
      status: "error",
      error: "Stopped.",
    });
    expect(result.current.runs[0].rounds[0].events[0]).toMatchObject({ status: "error" });
  });

  it("leaves a finished round alone when stop arrives late", () => {
    const { agent, result } = setup();
    act(() => void result.current.startRun("go", "/tmp"));
    act(() => agent.last().handlers.onDone(done()));

    act(() => result.current.cancelRun(result.current.runs[0].id));

    expect(result.current.runs[0].rounds[0].status).toBe("done");
  });

  it("deleting a run stops it and clears the selection", () => {
    const { agent, result } = setup();
    act(() => void result.current.startRun("go", "/tmp"));
    const { cancel } = agent.last();

    act(() => result.current.deleteRun(result.current.runs[0].id));

    expect(cancel).toHaveBeenCalledOnce();
    expect(result.current.runs).toEqual([]);
    expect(result.current.active).toBeNull();
  });

  it("cancels everything still in flight when the page goes away", () => {
    const { agent, hook, result } = setup();
    act(() => void result.current.startRun("one", "/tmp"));
    act(() => void result.current.startRun("two", "/tmp"));

    hook.unmount();

    expect(agent.calls.map((c) => c.cancel.mock.calls.length)).toEqual([1, 1]);
  });
});

describe("several runs at once", () => {
  it("keeps concurrent runs independent", () => {
    const { agent, result } = setup();
    act(() => void result.current.startRun("first", "/tmp/a"));
    act(() => void result.current.startRun("second", "/tmp/b"));
    const [first, second] = agent.calls;

    act(() => {
      second.handlers.onText("from the second", null);
      first.handlers.onDone(done({ sessionId: "sess-first" }));
    });

    const [newest, oldest] = result.current.runs;
    expect(newest.title).toBe("second");
    expect(newest.rounds[0].status).toBe("running");
    expect(newest.rounds[0].events).toHaveLength(1);
    expect(oldest.rounds[0].status).toBe("done");
    expect(oldest.rounds[0].events).toEqual([]);
    expect(result.current.runningCount).toBe(1);
  });

  it("switching runs does not stop anything", () => {
    const { agent, result } = setup();
    act(() => void result.current.startRun("first", "/tmp"));
    const firstId = result.current.runs[0].id;
    act(() => void result.current.startRun("second", "/tmp"));

    act(() => result.current.selectRun(firstId));
    expect(result.current.active?.title).toBe("first");
    expect(agent.calls.every((c) => c.cancel.mock.calls.length === 0)).toBe(true);

    act(() => result.current.newRun());
    expect(result.current.active).toBeNull();
    expect(result.current.runs).toHaveLength(2);
  });
});
