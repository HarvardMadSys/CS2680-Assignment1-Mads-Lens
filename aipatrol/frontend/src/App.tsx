import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Composer } from "./components/Composer";
import { Outline } from "./components/Outline";
import { CwdField } from "./components/CwdField";
import { EmptyState } from "./components/EmptyState";
import { LoadRecording } from "./components/LoadRecording";
import { Logo } from "./components/Logo";
import { SchemePicker } from "./components/SchemePicker";
import { Trajectory } from "./components/Trajectory";
import { RunHeader } from "./components/RunHeader";
import { Sidebar } from "./components/Sidebar";
import { ThemeToggle } from "./components/ThemeToggle";
import { useRuns } from "./hooks/useRuns";
import { isRunning } from "./lib/runs";
import {
  ancestorsOf,
  buildTree,
  countCalls,
  countFailures,
  flowFor,
  toolOnly,
} from "./lib/tree";
import { useOutline } from "./hooks/useOutline";
import { EMPTY_REVEAL, RevealContext, type RevealState } from "./hooks/useReveal";
import { createFileDriver } from "./agent/fileDriver";
import { TEST_PROMPT } from "./lib/testPrompt";
import { useScheme } from "./hooks/useScheme";
import { useTheme } from "./hooks/useTheme";
import "./App.css";

/** Replaced by the server's real cwd once /api/config answers. */
const FALLBACK_CWD = "~";

export default function App() {
  const { resolved, toggle } = useTheme();
  const { scheme, setScheme } = useScheme();
  const outline = useOutline();
  const {
    runs,
    active,
    runningCount,
    selectRun,
    newRun,
    startRun,
    sendFollowUp,
    cancelRun,
    deleteRun,
  } = useRuns();

  /** Directory for the *next* run. A started run keeps the one it got. */
  const [cwd, setCwd] = useState(FALLBACK_CWD);
  const [serverDown, setServerDown] = useState(false);

  // Ask the server where it is running, so the directory shown is a real one.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
      .then((config: { defaultCwd?: string }) => {
        if (!cancelled && config.defaultCwd) setCwd(config.defaultCwd);
      })
      .catch(() => {
        if (!cancelled) setServerDown(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [navOpen, setNavOpen] = useState(false);

  /** Run-level "expand all". Resets when you switch runs. */
  const [expandAll, setExpandAll] = useState(false);
  useEffect(() => setExpandAll(false), [active?.id]);

  /**
   * Jumping from the outline: open every section above the target, then let
   * the dialogue scroll to it once it has rendered.
   */
  const [reveal, setReveal] = useState<RevealState>(EMPTY_REVEAL);

  const revealEvent = useCallback(
    (eventId: string, domId: string) => {
      const round = active?.rounds.find(
        (r) => r.id === eventId || r.events.some((e) => e.id === eventId),
      );

      const open = new Set<string>([eventId]);
      if (round) {
        open.add(round.id);
        for (const id of ancestorsOf(round.events, eventId)) open.add(id);
      }

      setReveal({ open, target: domId, nonce: Date.now() });
    },
    [active],
  );

  /** Ctrl+B drops a canned prompt that exercises every feature into the box. */
  const [preset, setPreset] = useState<{ text: string; at: number }>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "b" || !(e.ctrlKey || e.metaKey)) return;
      if (e.altKey || e.shiftKey) return;
      e.preventDefault();
      setPreset({ text: TEST_PROMPT, at: Date.now() });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Only relevant on a narrow window, where the outline is a top strip. */
  const [outlineFolded, setOutlineFolded] = useState(false);

  // The outline covers the whole run, round by round, so a conversation can
  // be surveyed end to end rather than only its newest round.
  const flow = active ? flowFor(active.rounds) : [];
  const allCalls = active
    ? active.rounds.flatMap((r) => toolOnly(buildTree(r.events)))
    : [];
  const callCount = countCalls(allCalls);
  const failureCount = countFailures(allCalls);

  const busy = active ? isRunning(active) : false;

  function handleSubmit(text: string) {
    if (active && active.source.kind === "agent") sendFollowUp(active.id, text);
    else startRun(text, cwd);
  }

  /** A recording opened from disk becomes a run like any other. */
  function handleRecording(file: File) {
    startRun(file.name, cwd, {
      driver: createFileDriver(file),
      source: { kind: "recording", name: file.name },
    });
  }

  return (
    <div className={`app${navOpen ? " app--nav-open" : ""}`}>
      <Sidebar
        runs={runs}
        activeId={active?.id ?? null}
        onSelect={(id) => {
          selectRun(id);
          setNavOpen(false);
        }}
        onNew={() => {
          newRun();
          setNavOpen(false);
        }}
        onDelete={deleteRun}
      />

      {/* Click-away for the overlay sidebar on narrow screens. */}
      <div
        className="scrim"
        onClick={() => setNavOpen(false)}
        aria-hidden="true"
      />

      <div className="pane">
        <header className="topbar">
          <div className="topbar__left">
            <button
              type="button"
              className="icon-button nav-toggle"
              onClick={() => setNavOpen((v) => !v)}
              aria-label="Toggle run history"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
                fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <span className="brand">
              <Logo size={18} />
              AIPatrol
            </span>
            {runningCount > 0 && (
              <span className="pill" title={`${runningCount} in flight`}>
                {runningCount} running
              </span>
            )}
            {serverDown && (
              <span
                className="pill pill--warn"
                title="Start it with: npm run server"
              >
                server unreachable
              </span>
            )}
          </div>

          <div className="topbar__actions">
            <LoadRecording onLoad={handleRecording} />
            <SchemePicker
              scheme={scheme}
              onChange={setScheme}
              resolved={resolved}
            />
            <ThemeToggle resolved={resolved} onToggle={toggle} />
          </div>
        </header>

        <main className="main">
          {active ? (
            <>
              <RunHeader
                run={active}
                onCancel={cancelRun}
                expandAll={expandAll}
                onToggleExpandAll={() => setExpandAll((v) => !v)}
                outlineHidden={outline.hidden}
                onToggleOutline={outline.toggleHidden}
                hasOutline={callCount > 0}
              />
              <div
                className={`stage${
                  callCount > 0 && !outline.hidden ? " stage--outlined" : ""
                }`}
                style={{ "--outline-w": `${outline.width}px` } as CSSProperties}
              >
                <RevealContext.Provider value={reveal}>
                <Trajectory run={active} expandAll={expandAll} />
              </RevealContext.Provider>
                {callCount > 0 && !outline.hidden && (
                  <Outline
                    items={flow}
                    callCount={callCount}
                    failureCount={failureCount}
                    folded={outlineFolded}
                    onToggleFold={() => setOutlineFolded((v) => !v)}
                    onResize={outline.setWidth}
                    onResetWidth={outline.resetWidth}
                    onHide={outline.toggleHidden}
                    onReveal={revealEvent}
                    expandAll={expandAll}
                    showNames={outline.showNames}
                    onToggleNames={outline.toggleNames}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="transcript transcript--empty">
              <EmptyState cwd={cwd} hasHistory={runs.length > 0} />
            </div>
          )}
        </main>

        <footer className="footer">
          <Composer
            onSubmit={handleSubmit}
            // Type freely while a run is going; only the send waits for it.
            locked={busy}
            lockedReason="This run is still going — send when it finishes."
            placeholder={
              active && active.source.kind === "agent"
                ? "Send a follow-up…"
                : "Ask the agent to do something…"
            }
            preset={preset}
            accessory={
              active?.source.kind === "recording" ? (
                <span className="composer__note">
                  Replaying <code>{active.source.name}</code> — type above to
                  start a live run
                </span>
              ) : active ? (
                <span className="composer__note">
                  {active.sessionId ? (
                    <>
                      Resumes session{" "}
                      <code title={active.sessionId}>
                        {active.sessionId.slice(0, 8)}…
                      </code>{" "}
                      in <code title={active.cwd}>{active.cwd}</code>
                    </>
                  ) : (
                    <>
                      Continues this run in{" "}
                      <code title={active.cwd}>{active.cwd}</code>
                    </>
                  )}
                </span>
              ) : (
                <CwdField cwd={cwd} onChange={setCwd} />
              )
            }
          />
        </footer>
      </div>
    </div>
  );
}
