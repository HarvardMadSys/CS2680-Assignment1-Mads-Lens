#!/usr/bin/env node
/**
 * Stands in for the `claude` CLI so the server can be tested without spending
 * tokens. It reports how it was invoked as its first event — argv and cwd —
 * and then behaves as FAKE_CLI_MODE asks:
 *
 *   success    (default) a couple of events and a result
 *   not-json   a line that is not JSON at all
 *   no-result  stderr, then a nonzero exit with no result event
 *   hang       runs until signalled; writes FAKE_CLI_SIGNAL_FILE on SIGTERM
 */

const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

say({ type: "_fake", argv: process.argv.slice(2), cwd: process.cwd() });

switch (process.env.FAKE_CLI_MODE ?? "success") {
  case "not-json":
    process.stdout.write("Loading plugins…\n");
    say({ type: "result", subtype: "success", session_id: "s1", num_turns: 1 });
    break;

  case "no-result":
    process.stderr.write("fatal: something broke\n");
    process.exitCode = 3;
    break;

  case "hang":
    process.on("SIGTERM", async () => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.FAKE_CLI_SIGNAL_FILE, "SIGTERM");
      process.exit(0);
    });
    setInterval(() => {}, 1000);
    break;

  default:
    say({ type: "system", subtype: "init", session_id: "s1" });
    say({
      type: "assistant",
      message: { content: [{ type: "text", text: "on it" }] },
    });
    say({
      type: "result",
      subtype: "success",
      session_id: "s1",
      total_cost_usd: 0.06,
      duration_ms: 2800,
      num_turns: 2,
    });
}
