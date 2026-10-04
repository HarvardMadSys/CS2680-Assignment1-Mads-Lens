// One command: make sure everything is installed and built, then open the desktop app.
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sh = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: "inherit" });

if (!existsSync(join(root, "server", ".venv")) || !existsSync(join(root, "client", "node_modules"))) {
  sh("node scripts/setup.mjs");
}
if (!existsSync(join(root, "client", ".next", "BUILD_ID")) || process.argv.includes("--rebuild")) {
  console.log("building the client…");
  sh("npx next build", join(root, "client"));
}

const electron = join(root, "node_modules", ".bin", "electron");
if (!existsSync(electron)) {
  console.error("electron is missing — run `npm install`");
  process.exit(1);
}
spawn(electron, ["."], { cwd: root, stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 0));
