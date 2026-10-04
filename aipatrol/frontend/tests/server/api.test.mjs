import { createServer } from "node:http";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = path.join(here, "..", "fixtures", "fake-claude.mjs");

/**
 * CLAUDE_BIN and ALLOWED_TOOLS are read when the module loads, so each test
 * sets its environment and then imports a fresh copy.
 */
async function serve(env = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);

  const { createApiHandler } = await import("../../server/api.mjs");
  const { createReplayRotation } = await import("../../server/replay.mjs");
  const handler = createApiHandler({
    replay: createReplayRotation(env.recordings ?? []),
  });

  const server = createServer((req, res) =>
    handler(req, res, () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("fell through");
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);

  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    get: (p) => fetch(base + p),
    run: (body, init) =>
      fetch(`${base}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
        ...init,
      }),
  };
}

/** Every NDJSON event the server sent, parsed. */
async function events(response) {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const servers = [];

beforeEach(() => {
  vi.stubEnv("CLAUDE_BIN", FAKE_CLI);
  vi.stubEnv("ALLOWED_TOOLS", "");
  vi.stubEnv("FAKE_CLI_MODE", "success");
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  vi.unstubAllEnvs();
});

describe("routing", () => {
  it("answers /api/config with what the UI needs to start", async () => {
    const api = await serve({ DEFAULT_CWD: "/tmp/scratch" });
    const res = await api.get("/api/config");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      home: os.homedir(),
      defaultCwd: "/tmp/scratch",
      replaying: false,
      recordings: [],
      permissions: "skip-all",
      tasks: true,
    });
  });

  it("names the auto-approved tools when they are limited", async () => {
    const api = await serve({ ALLOWED_TOOLS: "Edit Bash(pytest:*)" });
    const config = await (await api.get("/api/config")).json();
    expect(config.permissions).toBe("allowedTools: Edit Bash(pytest:*)");
  });

  it("says so when it is replaying rather than spawning", async () => {
    const api = await serve({ recordings: ["/tmp/events.jsonl"] });
    expect((await (await api.get("/api/config")).json()).replaying).toBe(true);
  });

  // Everything outside /api/ belongs to Vite in dev and to dist/ in production.
  it("passes anything outside /api/ to the next handler", async () => {
    const api = await serve();
    expect(await (await api.get("/index.html")).text()).toBe("fell through");
  });

  it("404s an unknown /api/ route and 405s a GET to /api/run", async () => {
    const api = await serve();
    expect((await api.get("/api/nope")).status).toBe(404);

    const res = await api.get("/api/run");
    expect(res.status).toBe(405);
    expect((await res.json()).error).toBe("Use POST.");
  });
});

describe("rejecting a run", () => {
  it("needs a JSON body", async () => {
    const api = await serve();
    const res = await api.run("not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Body must be JSON.");
  });

  it("needs a prompt with something in it", async () => {
    const api = await serve();
    for (const body of [{}, { prompt: "   " }, { prompt: 42 }]) {
      const res = await api.run(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("A prompt is required.");
    }
  });

  it("needs a directory that exists", async () => {
    const api = await serve();
    const res = await api.run({ prompt: "go", cwd: "/bad/path" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Not a directory: /bad/path");
  });

  it("will not run in a file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agent-console-"));
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "hello");

    const api = await serve();
    const res = await api.run({ prompt: "go", cwd: file });
    expect((await res.json()).error).toBe(`Not a directory: ${file}`);
  });
});

describe("spawning the CLI", () => {
  it("streams the CLI's own events back, untouched", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agent-console-"));
    const api = await serve();
    const res = await api.run({ prompt: "go", cwd: dir });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const sent = await events(res);
    expect(sent.map((e) => e.type)).toEqual([
      "_fake",
      "system",
      "assistant",
      "result",
    ]);
    expect(sent.at(-1)).toMatchObject({ total_cost_usd: 0.06, num_turns: 2 });
  });

  it("runs in the requested directory and passes the prompt positionally", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agent-console-"));
    const api = await serve({ TASKS: "off" });
    const [invocation] = await events(await api.run({ prompt: "go", cwd: dir }));

    expect(invocation.cwd).toBe(dir);
    expect(invocation.argv).toEqual([
      "-p",
      "go",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ]);
  });

  // Tasks are not in the protocol — they exist only because the agent is
  // asked to announce them.
  it("appends the task prompt by default", async () => {
    const api = await serve();
    const [invocation] = await events(
      await api.run({ prompt: "go", cwd: os.tmpdir() }),
    );

    const at = invocation.argv.indexOf("--append-system-prompt");
    expect(at).toBeGreaterThan(-1);
    expect(invocation.argv[at + 1]).toContain("[[task-start");
    expect(invocation.argv[at + 1]).toContain("[[task-end]]");
  });

  it("leaves the agent alone when TASKS=off", async () => {
    const api = await serve({ TASKS: "off" });
    const [invocation] = await events(
      await api.run({ prompt: "go", cwd: os.tmpdir() }),
    );
    expect(invocation.argv).not.toContain("--append-system-prompt");
  });

  it("resumes a session when one is given", async () => {
    const api = await serve();
    const [invocation] = await events(
      await api.run({ prompt: "and again", cwd: os.tmpdir(), sessionId: "s1" }),
    );
    expect(invocation.argv.slice(0, 4)).toEqual(["-p", "--resume", "s1", "and again"]);
  });

  // Naming the tools is the alternative to skipping permissions entirely.
  it("passes ALLOWED_TOOLS instead of skipping permissions", async () => {
    const api = await serve({ ALLOWED_TOOLS: "Edit Bash(pytest:*)" });
    const [invocation] = await events(
      await api.run({ prompt: "go", cwd: os.tmpdir() }),
    );

    expect(invocation.argv).toContain("--allowedTools");
    expect(invocation.argv.slice(-2)).toEqual(["Edit", "Bash(pytest:*)"]);
    expect(invocation.argv).not.toContain("--dangerously-skip-permissions");
  });

  it("expands ~ to the home directory", async () => {
    const api = await serve();
    const [invocation] = await events(await api.run({ prompt: "go", cwd: "~" }));
    expect(invocation.cwd).toBe(os.homedir());
  });

  it("forwards a line that is not JSON rather than dropping it", async () => {
    const api = await serve({ FAKE_CLI_MODE: "not-json" });
    const sent = await events(await api.run({ prompt: "go", cwd: os.tmpdir() }));
    expect(sent).toContainEqual({ type: "_stderr", text: "Loading plugins…" });
  });
});

describe("when the CLI does not report a result", () => {
  it("explains an exit that produced no result event", async () => {
    const api = await serve({ FAKE_CLI_MODE: "no-result" });
    const sent = await events(await api.run({ prompt: "go", cwd: os.tmpdir() }));

    const error = sent.find((e) => e.type === "_error");
    expect(error.message).toContain("fatal: something broke");
  });

  it("says the CLI is missing rather than hanging", async () => {
    const api = await serve({ CLAUDE_BIN: "/nonexistent/claude" });
    const sent = await events(await api.run({ prompt: "go", cwd: os.tmpdir() }));

    const error = sent.find((e) => e.type === "_error");
    expect(error.message).toContain("not found on PATH");
  });
});

// The browser going away is what stops the agent: no response, no subprocess.
describe("cancelling", () => {
  it("kills the subprocess when the client disconnects", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agent-console-"));
    const marker = path.join(dir, "signalled");

    const api = await serve({
      FAKE_CLI_MODE: "hang",
      FAKE_CLI_SIGNAL_FILE: marker,
    });

    const controller = new AbortController();
    const res = await api.run(
      { prompt: "go", cwd: dir },
      { signal: controller.signal },
    );

    // Wait until the child is definitely up: it says so on its first line.
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();

    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), {
      timeout: 5_000,
    });
  });
});

describe("replaying a saved run", () => {
  it("streams the file back instead of spawning anything", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agent-console-"));
    const file = path.join(dir, "events.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
        "not json at all",
        "",
      ].join("\n"),
    );

    const api = await serve({ recordings: [file], CLAUDE_BIN: "/nonexistent" });
    const sent = await events(await api.run({ prompt: "go", cwd: dir }));

    expect(sent).toEqual([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "_stderr", text: "not json at all" },
    ]);
  });

  /**
   * Several recordings means each run takes the next one, so a conversation
   * can replay a different trajectory per round rather than the same stream.
   */
  it("hands out the next recording on each run, then cycles", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agent-console-"));
    const files = ["a", "b"].map((name) => {
      const file = path.join(dir, `${name}.jsonl`);
      writeFileSync(file, JSON.stringify({ type: "system", subtype: name }));
      return file;
    });

    const api = await serve({ recordings: files });
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const [first] = await events(await api.run({ prompt: "go", cwd: dir }));
      seen.push(first.subtype);
    }

    expect(seen).toEqual(["a", "b", "a"]);
  });

  it("reports the recordings it was given", async () => {
    const api = await serve({ recordings: ["one.jsonl", "two.jsonl"] });
    const config = await (await api.get("/api/config")).json();
    expect(config.recordings).toEqual(["one.jsonl", "two.jsonl"]);
  });

  it("fails the request rather than the process when the file is missing", async () => {
    const api = await serve({ recordings: ["/nonexistent/events.jsonl"] });
    const res = await api.run({ prompt: "go", cwd: os.tmpdir() });
    // Headers are already out by then, so the stream just ends.
    expect(await res.text()).toBe("");
  });
});

describe("describeMode", () => {
  it("warns loudly when every tool is auto-approved", async () => {
    vi.resetModules();
    const { describeMode } = await import("../../server/api.mjs");
    expect(describeMode(null)).toContain("--dangerously-skip-permissions");
    const { createReplayRotation } = await import("../../server/replay.mjs");
    const banner = describeMode(createReplayRotation(["a.jsonl", "b.jsonl"]));
    expect(banner).toContain("replaying");
    expect(banner).toContain("a.jsonl");
    expect(banner).toContain("b.jsonl");
  });

  it("names the allowed tools instead when they are set", async () => {
    vi.resetModules();
    vi.stubEnv("ALLOWED_TOOLS", "Edit");
    const { describeMode, permissionMode } = await import("../../server/api.mjs");
    expect(describeMode(null)).toContain("tools auto-approved: Edit");
    expect(permissionMode()).toBe("allowedTools: Edit");
  });
});
