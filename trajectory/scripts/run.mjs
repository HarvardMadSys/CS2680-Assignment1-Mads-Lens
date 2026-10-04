import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2] || "dev";
const procs = [];

const start = (name, cmd, args, cwd, color) => {
  const p = spawn(cmd, args, { cwd, env: process.env, detached: true });
  const tag = `\x1b[${color}m${name}\x1b[0m `;
  const pipe = (s) => s.on("data", (d) => process.stdout.write(String(d).replace(/^/gm, tag).replace(/\n$/, "\n")));
  pipe(p.stdout); pipe(p.stderr);
  procs.push(p);
};

// The API stays on loopback; the web server (PORT, default 8000) proxies /api/* to it.
const apiPort = process.env.API_PORT || process.env.PORT_API || "8001";
process.env.API_PORT = apiPort;
start("api", join(root, "server/.venv/bin/python"), ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", apiPort, ...(mode === "dev" ? ["--reload"] : [])], join(root, "server"), "35");
if (mode !== "server") start("web", "npm", ["run", mode === "dev" ? "dev" : "start"], join(root, "client"), "35;1");

// kill the process group: `next dev` forks a server that outlives its parent otherwise
const bye = () => {
  for (const p of procs) {
    try { process.kill(-p.pid, "SIGTERM"); } catch { try { p.kill("SIGTERM"); } catch {} }
  }
  process.exit(0);
};
process.on("SIGINT", bye); process.on("SIGTERM", bye);
