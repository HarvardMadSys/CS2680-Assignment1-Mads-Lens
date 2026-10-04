import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentDriver } from "../agent/driver";
import { httpDriver } from "../agent/httpDriver";
import { sweepOpenTasks, sweepPending } from "../lib/events";
import { TaskStacks } from "../lib/tasks";
import { titleFrom } from "../lib/format";
import { isRunning } from "../lib/runs";
import type { Round, Run, RunSource, TrajectoryEvent } from "../types";

let seq = 0;
const nextId = (prefix: string) => `${prefix}${++seq}`;

/**
 * Owns every run. Runs are independent: each one's driver writes back by id,
 * so several can be in flight at once without clobbering each other.
 *
 * Within a run, each prompt opens a new round. The first round starts a
 * session; every later one resumes it, so the agent keeps its context.
 */
export function useRuns(driver: AgentDriver = httpDriver) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  /** Cancel functions for in-flight runs, keyed by run id. */
  const inFlight = useRef(new Map<string, () => void>());

  /**
   * A run may have its own driver — a recording loaded from disk replays
   * through the same handlers as a live run, so only the source differs.
   * Follow-ups reuse whatever the run started with.
   */
  const drivers = useRef(new Map<string, AgentDriver>());

  /** Mirrors `runs` so callbacks can read current state without re-binding. */
  const runsRef = useRef(runs);
  runsRef.current = runs;

  useEffect(() => {
    const pending = inFlight.current;
    return () => {
      pending.forEach((cancel) => cancel());
      pending.clear();
    };
  }, []);

  const patchRun = useCallback(
    (id: string, change: Partial<Run> | ((r: Run) => Partial<Run>)) => {
      setRuns((prev) =>
        prev.map((r) =>
          r.id === id
            ? { ...r, ...(typeof change === "function" ? change(r) : change) }
            : r,
        ),
      );
    },
    [],
  );

  /** Update one round of one run. Rounds are addressed by id, not position. */
  const patchRound = useCallback(
    (
      runId: string,
      roundId: string,
      change: Partial<Round> | ((r: Round) => Partial<Round>),
    ) => {
      setRuns((prev) =>
        prev.map((run) =>
          run.id === runId
            ? {
                ...run,
                rounds: run.rounds.map((round) =>
                  round.id === roundId
                    ? {
                        ...round,
                        ...(typeof change === "function" ? change(round) : change),
                      }
                    : round,
                ),
              }
            : run,
        ),
      );
    },
    [],
  );

  const appendEvent = useCallback(
    (runId: string, roundId: string, event: TrajectoryEvent) => {
      patchRound(runId, roundId, (r) => ({ events: [...r.events, event] }));
    },
    [patchRound],
  );

  /** Complete a pending tool call in place, matching on its tool_use_id. */
  const completeTool = useCallback(
    (
      runId: string,
      roundId: string,
      toolId: string,
      ok: boolean,
      content: string,
    ) => {
      patchRound(runId, roundId, (r) => ({
        events: r.events.map((e) =>
          e.kind === "tool" && e.id === toolId
            ? {
                ...e,
                status: ok ? ("ok" as const) : ("error" as const),
                result: content,
                endedAt: Date.now(),
              }
            : e,
        ),
      }));
    },
    [patchRound],
  );

  /** Wire one driver invocation to a round's lifecycle. */
  const drive = useCallback(
    (run: Run, round: Round) => {
      const runDriver = drivers.current.get(run.id) ?? driver;
      // Open tasks, per agent context, for the life of this round. The main
      // agent and each subagent bracket their own work independently.
      const tasks = new TaskStacks();

      /** Close a task in place, whatever the reason. */
      const closeTask = (taskId: string, status: "done" | "error") =>
        patchRound(run.id, round.id, (r) => ({
          events: r.events.map((e) =>
            e.kind === "task" && e.id === taskId
              ? { ...e, status, endedAt: Date.now() }
              : e,
          ),
        }));

      const cancel = runDriver(
        { prompt: round.prompt, cwd: run.cwd, sessionId: round.resumedFrom },
        {
          // Recorded as soon as the init event lands, so the next follow-up
          // can resume even if this round goes on to fail.
          onSession: (sessionId) => {
            patchRound(run.id, round.id, { sessionId });
            patchRun(run.id, { sessionId });
          },

          onText: (text, parentToolUseId) =>
            appendEvent(run.id, round.id, {
              kind: "text",
              id: nextId("e"),
              text,
              at: Date.now(),
              parentToolUseId,
              taskId: tasks.current(parentToolUseId),
            }),

          onToolUse: ({ id, name, input, parentToolUseId, batchId }) =>
            appendEvent(run.id, round.id, {
              kind: "tool",
              id,
              name,
              input,
              status: "pending",
              at: Date.now(),
              parentToolUseId,
              taskId: tasks.current(parentToolUseId),
              batchId: batchId ?? null,
            }),

          onTaskStart: (title, parentToolUseId) => {
            const id = nextId("task");
            // Nest under whatever task is already open in this context.
            appendEvent(run.id, round.id, {
              kind: "task",
              id,
              title,
              status: "running",
              at: Date.now(),
              parentToolUseId,
              taskId: tasks.current(parentToolUseId),
            });
            tasks.push(parentToolUseId, id);
          },

          onTaskEnd: (parentToolUseId) => {
            // An unmatched end is the agent over-closing; ignore it rather
            // than letting it pop a task it does not own.
            const id = tasks.pop(parentToolUseId);
            if (id) closeTask(id, "done");
          },

          onToolResult: ({ id, ok, content }) =>
            completeTool(run.id, round.id, id, ok, content),

          onDone: ({ sessionId, costUsd, durationMs, numTurns }) => {
            inFlight.current.delete(run.id);
            if (sessionId) patchRun(run.id, { sessionId });
            patchRound(run.id, round.id, (r) => ({
              status: "done",
              sessionId: sessionId || r.sessionId,
              endedAt: Date.now(),
              costUsd,
              durationMs,
              numTurns,
              // The round succeeded, so work the agent forgot to close did
              // in fact finish — it just never said so.
              events: sweepOpenTasks(
                sweepPending(
                  r.events,
                  "The round ended with no result for this call.",
                ),
                "done",
              ),
            }));
          },

          onError: (error) => {
            inFlight.current.delete(run.id);
            patchRound(run.id, round.id, (r) => ({
              status: "error",
              error,
              endedAt: Date.now(),
              events: sweepOpenTasks(
                sweepPending(
                  r.events,
                  "The round failed before this call reported back.",
                ),
                "error",
              ),
            }));
          },
        },
      );
      inFlight.current.set(run.id, cancel);
    },
    [driver, appendEvent, completeTool, patchRound, patchRun],
  );

  function newRound(prompt: string, resumedFrom: string | null): Round {
    return {
      id: nextId("d"),
      prompt,
      events: [],
      status: "running",
      startedAt: Date.now(),
      sessionId: null,
      resumedFrom,
    };
  }

  /**
   * Start a new run in `cwd` and make it active. `over` lets a caller supply
   * its own driver — that is how a recording loaded from disk becomes a run
   * without the server, or the agent, being involved at all.
   */
  const startRun = useCallback(
    (
      prompt: string,
      cwd: string,
      over: { driver?: AgentDriver; source?: RunSource } = {},
    ) => {
      const round = newRound(prompt, null);
      const run: Run = {
        id: nextId("r"),
        source: over.source ?? { kind: "agent" },
        title: titleFrom(prompt),
        cwd,
        sessionId: null,
        rounds: [round],
        startedAt: Date.now(),
      };

      if (over.driver) drivers.current.set(run.id, over.driver);

      setRuns((prev) => [run, ...prev]);
      setActiveId(run.id);
      drive(run, round);
      return run.id;
    },
    [drive],
  );

  /**
   * Continue the conversation: a new round that resumes the run's session, so
   * the agent keeps its context from the previous turn.
   */
  const sendFollowUp = useCallback(
    (id: string, prompt: string) => {
      const run = runsRef.current.find((r) => r.id === id);
      if (!run || isRunning(run)) return;
      // A recording has no session behind it; there is nothing to continue.
      if (run.source.kind === "recording") return;

      const round = newRound(prompt, run.sessionId);
      patchRun(id, (r) => ({ rounds: [...r.rounds, round] }));
      drive(run, round);
    },
    [drive, patchRun],
  );

  const cancelRun = useCallback(
    (id: string) => {
      inFlight.current.get(id)?.();
      inFlight.current.delete(id);

      const run = runsRef.current.find((r) => r.id === id);
      const round = run?.rounds.at(-1);
      if (!run || !round || round.status !== "running") return;

      patchRound(id, round.id, (r) => ({
        status: "error",
        error: "Stopped.",
        endedAt: Date.now(),
        events: sweepOpenTasks(
          sweepPending(r.events, "Stopped before this call reported back."),
          "error",
        ),
      }));
    },
    [patchRound],
  );

  const deleteRun = useCallback((id: string) => {
    inFlight.current.get(id)?.();
    inFlight.current.delete(id);
    drivers.current.delete(id);
    setRuns((prev) => prev.filter((r) => r.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
  }, []);

  const active = runs.find((r) => r.id === activeId) ?? null;
  const runningCount = runs.filter(isRunning).length;

  return {
    runs,
    active,
    runningCount,
    selectRun: setActiveId,
    newRun: () => setActiveId(null),
    startRun,
    sendFollowUp,
    cancelRun,
    deleteRun,
  };
}
