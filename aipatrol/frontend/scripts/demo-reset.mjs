/**
 * Put the demo workspace back to its starting state.
 *
 * A demo is only repeatable if the bug can be put back: "find why the test
 * fails and fix it" works once, and then the test passes forever. The agent
 * works in `workspace/`, which is disposable and gitignored; `pristine/` is
 * the committed original and is never worked in.
 */

import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.join(here, "..", "..", "demo");
const pristine = path.join(demo, "pristine");
const workspace = path.join(demo, "workspace");

try {
  await stat(pristine);
} catch {
  console.error(`No demo project at ${pristine}`);
  process.exit(1);
}

await rm(workspace, { recursive: true, force: true });
await cp(pristine, workspace, {
  recursive: true,
  // Leave behind whatever the last run generated.
  filter: (src) =>
    !/(^|[\\/])(__pycache__|\.pytest_cache|\.git)([\\/]|$)/.test(src),
});

console.log(`demo workspace reset\n  ${workspace}`);
