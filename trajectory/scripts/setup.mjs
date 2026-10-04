import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sh = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: "inherit" });
const has = (bin) => { try { execSync(`command -v ${bin}`, { stdio: "ignore" }); return true; } catch { return false; } };

mkdirSync(join(root, "data"), { recursive: true });

const venv = join(root, "server", ".venv");
if (!existsSync(venv)) {
  if (has("uv")) sh("uv venv .venv", join(root, "server"));
  else sh(`${process.env.PYTHON || "python3"} -m venv .venv`, join(root, "server"));
}
const pip = has("uv") ? "uv pip install --python .venv/bin/python -q" : ".venv/bin/pip install -q";
sh(`${pip} -r requirements.txt`, join(root, "server"));

// `npm ci` installs exactly what client/package-lock.json pins (Next, React, TypeScript)
if (!existsSync(join(root, "client", "node_modules"))) sh("npm ci --silent", join(root, "client"));
console.log("\nsetup complete — `./trajectory dev` (or `npm run dev`), then open http://localhost:8000");
