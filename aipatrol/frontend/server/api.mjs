/**
 * The API: spawn `claude -p`, stream its events.
 *
 * Written as a plain (req, res, next) handler so the same code runs two ways:
 *   - mounted into Vite's dev server (npm run dev)
 *   - mounted into a bare node:http server (npm run start)
 * There is no proxy between the page and this code in either mode.
 *
 * Note on the /api prefix: it is only a URL namespace for this local server.
 * Nothing here talks to the Anthropic API. The CLI is a subprocess and uses
 * whatever credential you logged in with.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

/**
 * In a headless run nobody can answer a permission prompt, so requests that
 * need approval are refused instead. Either auto-approve everything (right
 * for a scratch directory) or name the tools that may run unattended:
 *   ALLOWED_TOOLS="Edit Bash(pytest:*)" npm run dev
 */
const ALLOWED_TOOLS = process.env.ALLOWED_TOOLS?.trim();

/**
 * Conventions appended to every run: announce tasks with markers (the client
 * reconstructs their structure from those, since tasks are not part of the
 * stream-json protocol), and batch independent tool calls. Set TASKS=off to
 * run without it; the trajectory then renders flat, as it did before.
 */
const TASKS_ON = (process.env.TASKS ?? "on").toLowerCase() !== "off";

const TASK_PROMPT = (() => {
  if (!TASKS_ON) return null;
  const file = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "agent-prompt.md",
  );
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    console.warn(`  ! could not read ${file} — running without task markers`);
    return null;
  }
})();

/* ------------------------------------------------------------------ */

export function permissionMode() {
  return ALLOWED_TOOLS ? `allowedTools: ${ALLOWED_TOOLS}` : "skip-all";
}

/**
 * Where a run lands unless told otherwise.
 *
 * The demo workspace, if it is there: runs carry `--dangerously-skip-permissions`,
 * so the default must be a directory that is disposable by design rather than
 * whatever the server happens to have been started in.
 */
function defaultCwd() {
  if (process.env.DEFAULT_CWD) return process.env.DEFAULT_CWD;

  const workspace = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "demo",
    "workspace",
  );
  return existsSync(workspace) ? workspace : process.cwd();
}

/** `~/scratch` → `/home/you/scratch`. The UI lets you type a path. */
function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Any web page the user has open could POST here too (a text/plain body needs
 * no CORS preflight), and that would start an agent. Browsers send Origin on
 * such a request; refuse one that does not match the host it was sent to.
 */
function isCrossOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function buildArgs({ prompt, sessionId }) {
  const args = ["-p"];

  // Resuming continues an existing session; the prompt stays positional.
  if (sessionId) args.push("--resume", sessionId);
  args.push(prompt);

  args.push("--output-format", "stream-json", "--verbose");

  if (TASK_PROMPT) args.push("--append-system-prompt", TASK_PROMPT);

  if (ALLOWED_TOOLS) {
    args.push("--allowedTools", ...ALLOWED_TOOLS.split(/\s+/));
  } else {
    args.push("--dangerously-skip-permissions");
  }

  return args;
}

/* --- POST /api/run -------------------------------------------------- */

async function handleRun(req, res, { replay }) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "Body must be JSON." });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return json(res, 400, { error: "A prompt is required." });

  const cwd = expandHome(String(body.cwd ?? "").trim() || process.cwd());
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return json(res, 400, { error: `Not a directory: ${cwd}` });
  }

  const sessionId =
    typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null;

  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Nothing downstream should sit on this — the whole point is liveness.
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();

  const send = (event) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };

  // Each run takes the next recording, so a list of them gives a different
  // trajectory per run rather than the same one repeatedly.
  const recording = replay?.take();
  if (recording) return streamRecording(res, send, recording);

  const args = buildArgs({ prompt, sessionId });
  // The system prompt is long; log the shape of the command, not its text.
  const shown = args.map((a) => (a === TASK_PROMPT ? "<task-prompt>" : a));
  console.log(`▶ ${CLAUDE_BIN} ${shown.join(" ")}\n  cwd: ${cwd}`);

  let child;
  try {
    child = spawn(CLAUDE_BIN, args, {
      cwd,
      // Inherit the login credential; never pass an API key through.
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    send({ type: "_error", message: `Could not start ${CLAUDE_BIN}: ${err.message}` });
    return res.end();
  }

  child.on("error", (err) => {
    send({
      type: "_error",
      message:
        err.code === "ENOENT"
          ? `${CLAUDE_BIN} not found on PATH. Is Claude Code installed?`
          : err.message,
    });
    res.end();
  });

  // stdout is newline-delimited JSON — forward each complete line.
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawResult = false;

  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = JSON.parse(trimmed);
      if (event.type === "result") sawResult = true;
      send(event);
    } catch {
      // Not JSON — surface it rather than dropping it silently.
      send({ type: "_stderr", text: trimmed });
    }
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    send({ type: "_stderr", text });
  });

  child.on("close", (code) => {
    // A clean run ends with a result event; anything else needs explaining.
    if (!sawResult) {
      send({
        type: "_error",
        message:
          stderr.trim() ||
          `${CLAUDE_BIN} exited with code ${code} before reporting a result.`,
      });
    }
    res.end();
  });

  // The browser went away (tab closed, run cancelled) — don't leave it
  // running. It has to be `res`: `req` closes as soon as its body has been
  // read, which is before the child is even spawned.
  res.on("close", () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  });
}

/** Stream a saved events.jsonl back, paced so the UI can be watched. */
async function streamRecording(res, send, file) {
  console.log(`↻ replaying ${file}`);
  const text = await readFile(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      send(JSON.parse(line));
    } catch {
      send({ type: "_stderr", text: line });
    }
    await new Promise((r) => setTimeout(r, 260));
    if (res.writableEnded) return;
  }
  res.end();
}

/* --- the handler ---------------------------------------------------- */

/**
 * Returns a (req, res, next) middleware. Requests outside /api/ fall through
 * to `next` — Vite's own middleware in dev, static files in production.
 */
export function createApiHandler({ replay = null } = {}) {
  return function apiHandler(req, res, next) {
    const { pathname } = new URL(req.url, "http://localhost");

    if (!pathname.startsWith("/api/")) return next();

    if (pathname === "/api/config") {
      return json(res, 200, {
        home: os.homedir(),
        defaultCwd: defaultCwd(),
        replaying: Boolean(replay?.active),
        recordings: replay?.files ?? [],
        permissions: permissionMode(),
        tasks: Boolean(TASK_PROMPT),
      });
    }

    if (pathname === "/api/run") {
      if (req.method !== "POST") return json(res, 405, { error: "Use POST." });
      if (isCrossOrigin(req)) {
        return json(res, 403, { error: "Cross-origin request refused." });
      }
      return handleRun(req, res, { replay }).catch((err) => {
        if (!res.headersSent) json(res, 500, { error: err.message });
        else res.end();
      });
    }

    return json(res, 404, { error: "No such route." });
  };
}

/** Shared startup banner, so both entry points say the same thing. */
export function describeMode(replay) {
  if (replay?.active) {
    const list = replay.files.map((f) => `      ${f}`).join("\n");
    return (
      `  ↻ replaying, no agent will be spawned —` +
      ` each run takes the next of:\n${list}`
    );
  }
  if (!TASK_PROMPT) {
    return (
      `  tasks off — the trajectory will render flat\n` +
      (ALLOWED_TOOLS
        ? `  tools auto-approved: ${ALLOWED_TOOLS}`
        : `  ⚠ --dangerously-skip-permissions: every tool call is auto-approved.`)
    );
  }
  if (ALLOWED_TOOLS) return `  tools auto-approved: ${ALLOWED_TOOLS}`;
  return (
    `  ⚠ --dangerously-skip-permissions: every tool call is auto-approved.\n` +
    `    Point runs at a scratch directory, or set ALLOWED_TOOLS.`
  );
}
