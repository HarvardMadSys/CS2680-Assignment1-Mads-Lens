/**
 * The seam between the UI and the agent.
 *
 * A real driver POSTs the prompt to a local server, which spawns
 *   claude -p "<prompt>" --output-format stream-json --verbose \
 *          --dangerously-skip-permissions
 * with cwd set to `cwd` (or --resume <sessionId> for a follow-up), then
 * streams the JSONL events back. Each assistant message's content blocks
 * become onText / onToolUse; each user message's tool_result becomes
 * onToolResult; the final result event becomes onDone.
 *
 * `mockDriver` below fakes that shape, on a timer, so the UI is testable
 * before the server exists.
 */

export interface StartOptions {
  prompt: string;
  cwd: string;
  /** Present for a follow-up: resume this session instead of starting fresh. */
  sessionId: string | null;
}

export interface RunHandlers {
  /**
   * The session id, as soon as it is known (the init event). Captured
   * separately from onDone because a failed run still needs to be resumable.
   */
  onSession: (sessionId: string) => void;
  /**
   * An assistant text block — markdown. `parentToolUseId` is null for the
   * main agent, or the id of the call that spawned the subagent that said it.
   */
  onText: (text: string, parentToolUseId: string | null) => void;
  /**
   * The agent announced the start of a logical task. Tasks nest by order —
   * this opens one; the matching onTaskEnd closes it.
   */
  onTaskStart: (title: string, parentToolUseId: string | null) => void;
  /** The agent announced that its innermost open task is finished. */
  onTaskEnd: (parentToolUseId: string | null) => void;
  /** A tool_use block. `id` is the tool_use_id the result will match on. */
  onToolUse: (call: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    parentToolUseId: string | null;
    /**
     * Shared by calls issued in one message — they ran in parallel. Omitted
     * means the call went out on its own.
     */
    batchId?: string | null;
  }) => void;
  /** The matching tool_result, which may arrive much later. */
  onToolResult: (result: {
    id: string;
    ok: boolean;
    content: string;
  }) => void;
  /** Terminal success — the fields of the final result event. */
  onDone: (summary: {
    sessionId: string;
    costUsd: number;
    durationMs: number;
    numTurns: number;
  }) => void;
  /** Terminal failure. */
  onError: (message: string) => void;
}

/** Returns a cancel function that aborts the run. */
export type AgentDriver = (
  options: StartOptions,
  handlers: RunHandlers,
) => () => void;

/** One beat of the fake trajectory: wait `after` ms, then do `run`. */
interface Beat {
  after: number;
  run: (h: RunHandlers, ctx: { id: (n: number) => string }) => void;
}

/** Long on purpose: a real test log is what the fold has to survive. */
const PYTEST_OUTPUT = [
  "============================= test session starts ==============================",
  "platform linux -- Python 3.12.3, pytest-8.3.2, pluggy-1.5.0",
  "rootdir: /home/you/scratch",
  "collected 312 items",
  "",
  ...Array.from(
    { length: 24 },
    (_, i) =>
      `tests/test_block_${String(i).padStart(2, "0")}.py ${".".repeat(12)}` +
      `                       [${String(Math.round(((i + 1) / 25) * 100)).padStart(3)}%]`,
  ),
  "tests/test_parse.py ...........F                                         [100%]",
  "",
  "=================================== FAILURES ===================================",
  "______________________________ test_trailing_nl ________________________________",
  "",
  "    def test_trailing_nl():",
  '        out = parse("a\\nb")',
  '>       assert out[-1].text == "\\n"',
  "E       AssertionError: assert '' == '\\n'",
  "",
  "tests/test_parse.py:41: AssertionError",
  "=========================== short test summary info ============================",
  "======================== 1 failed, 311 passed in 4.12s =========================",
].join("\n");

const SAMPLE_DIFF = `@@ -18,7 +18,7 @@ def parse(text: str) -> list[Token]:
     for line in text.splitlines():
         tokens.append(Token(line))
-    return tokens
+    return tokens + [Token("")]`;

/**
 * A scripted trajectory exercising every state the UI renders: markdown text,
 * a call that succeeds, one that fails, one still pending when the next event
 * lands, and a delegation whose subagent events nest under it.
 */
const SCRIPT: Beat[] = [
  {
    after: 500,
    run: (h) =>
      h.onText(
        "The test expects a trailing newline. I\u2019ll read the test first, " +
          "then check the parser.",
        null,
      ),
  },
  {
    after: 400,
    run: (h, c) =>
      h.onToolUse({
        id: c.id(1),
        name: "Read",
        input: { file_path: "tests/test_parse.py" },
        parentToolUseId: null,
      }),
  },
  {
    after: 800,
    run: (h, c) =>
      h.onToolResult({
        id: c.id(1),
        ok: true,
        content: [
          "import pytest",
          "",
          "from src.parser import Token, parse",
          "",
          "",
          "def test_trailing_nl():",
          '    out = parse("a\\nb")',
          '    assert out[-1].text == "\\n"',
        ].join("\n"),
      }),
  },
  {
    after: 300,
    run: (h, c) =>
      h.onToolUse({
        id: c.id(2),
        name: "Bash",
        input: { command: "pytest -x", description: "Run the test suite" },
        parentToolUseId: null,
      }),
  },
  {
    after: 1500,
    run: (h, c) =>
      h.onToolResult({ id: c.id(2), ok: false, content: PYTEST_OUTPUT }),
  },

  // --- a delegation, and the subagent's events beneath it ------------
  {
    after: 500,
    run: (h, c) =>
      h.onToolUse({
        id: c.id(3),
        name: "Agent",
        input: {
          subagent_type: "Explore",
          description: "survey this directory",
          prompt: "Survey the package and report what it contains.",
        },
        parentToolUseId: null,
      }),
  },
  {
    after: 500,
    run: (h, c) =>
      h.onToolUse({
        id: c.id(4),
        name: "Read",
        input: { file_path: "src/parser.py" },
        parentToolUseId: c.id(3),
        // Issued with the Grep below in one message — they ran at once.
        batchId: "batch_survey",
      }),
  },
  {
    after: 700,
    run: (h, c) =>
      h.onToolResult({
        id: c.id(4),
        ok: true,
        content: "def parse(text: str) -> list[Token]:\n    ...",
      }),
  },
  {
    after: 400,
    run: (h, c) =>
      h.onToolUse({
        id: c.id(5),
        name: "Grep",
        input: { pattern: "TODO", output_mode: "content" },
        parentToolUseId: c.id(3),
        batchId: "batch_survey",
      }),
  },
  {
    after: 600,
    run: (h, c) =>
      h.onToolResult({
        id: c.id(5),
        ok: true,
        content: "src/parser.py:1:# TODO: handle trailing newline",
      }),
  },
  {
    after: 500,
    run: (h, c) =>
      h.onText(
        "A small parser package with one failing test and a `TODO` about " +
          "the trailing newline.",
        c.id(3),
      ),
  },
  {
    after: 400,
    run: (h, c) =>
      h.onToolResult({
        id: c.id(3),
        ok: true,
        content: "A small parser package with one failing test.",
      }),
  },

  // --- back on the main agent ----------------------------------------
  {
    after: 500,
    run: (h) =>
      h.onText(
        "Confirmed \u2014 `test_trailing_nl` is the only failure:\n\n" +
          "- `parse()` drops the final newline\n" +
          "- every other case already passes\n\n" +
          "The fix is one line in `src/parser.py`.",
        null,
      ),
  },
  {
    after: 400,
    run: (h, c) =>
      h.onToolUse({
        id: c.id(6),
        name: "Edit",
        input: {
          file_path: "src/parser.py",
          old_string: "    return tokens",
          new_string: '    return tokens + [Token("")]',
        },
        parentToolUseId: null,
      }),
  },
  {
    after: 900,
    run: (h, c) =>
      h.onToolResult({ id: c.id(6), ok: true, content: SAMPLE_DIFF }),
  },
  {
    after: 400,
    run: (h, c) =>
      h.onToolUse({
        id: c.id(7),
        name: "Bash",
        input: { command: "pytest -x" },
        parentToolUseId: null,
      }),
  },
  {
    after: 1300,
    run: (h, c) =>
      h.onToolResult({ id: c.id(7), ok: true, content: "312 passed in 4.08s" }),
  },
  {
    after: 400,
    run: (h) =>
      h.onText(
        "All 312 tests pass. `parse()` now emits the trailing newline the " +
          "suite expects.",
        null,
      ),
  },
];

export const mockDriver: AgentDriver = ({ sessionId }, handlers) => {
  const timers: number[] = [];
  let cancelled = false;
  const startedAt = Date.now();

  // Unique per invocation, so a follow-up's tool ids never collide.
  const nonce = Math.random().toString(36).slice(2, 8);
  const ctx = { id: (n: number) => `toolu_${nonce}_${n}` };

  // Jitter each beat a little so two runs started together drift apart.
  const scale = 0.7 + Math.random() * 0.8;

  let elapsed = 0;
  for (const beat of SCRIPT) {
    elapsed += beat.after * scale;
    timers.push(
      window.setTimeout(() => {
        if (!cancelled) beat.run(handlers, ctx);
      }, elapsed),
    );
  }

  timers.push(
    window.setTimeout(() => {
      if (cancelled) return;
      handlers.onDone({
        sessionId: sessionId ?? crypto.randomUUID(),
        costUsd: 0.04 + Math.random() * 0.25,
        durationMs: Date.now() - startedAt,
        numTurns: 4 + Math.floor(Math.random() * 4),
      });
    }, elapsed + 400),
  );

  return () => {
    cancelled = true;
    timers.forEach(window.clearTimeout);
  };
};
