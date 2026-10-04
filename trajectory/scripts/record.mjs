// Record a headless run to server/fixtures/<name>.jsonl for replay-mode development.
//   npm run record -- <name> <cwd> "<prompt>"
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [name, cwd, prompt] = process.argv.slice(2);
if (!name || !cwd || !prompt) {
  console.error('usage: npm run record -- <name> <cwd> "<prompt>"');
  process.exit(1);
}
const out = join(root, "server/fixtures", `${name}.jsonl`);
const p = spawn(process.env.CLAUDE_BIN || "claude", [
  "-p", prompt, "--output-format", "stream-json", "--verbose",
  "--forward-subagent-text", "--dangerously-skip-permissions",
], { cwd });
p.stdout.pipe(createWriteStream(out));
p.stderr.pipe(process.stderr);
p.on("exit", (c) => console.log(`\n${out} (exit ${c})`));
