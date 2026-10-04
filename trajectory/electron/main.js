// Desktop shell: owns the Python API and the Next server, and dies with them.
const { app, BrowserWindow, shell, Menu, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const net = require("node:net");
const path = require("node:path");

// Our stdout may be a pipe someone closed (`trajectory | head`, a closed terminal). Writing to it
// then raises EPIPE, which must never take the window down with it.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});

const ROOT = path.join(__dirname, "..");
const PY = path.join(ROOT, "server", ".venv", "bin", "python");
const WEB = path.join(ROOT, "client", "server.mjs");
const kids = [];
let win = null;

const freePort = () =>
  new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

const waitFor = async (url, tries = 200) => {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} never came up`);
};

const log = (s) => {
  if (!process.stdout.writable) return;
  try { process.stdout.write(s); } catch { /* the pipe went away; the app keeps running */ }
};

// `next start` forks a `next-server` child, which survives a signal sent to its parent alone.
// Each child gets its own process group so quitting can take the whole tree down.
function run(name, cmd, args, cwd, env) {
  const p = spawn(cmd, args, {
    cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  const tag = (d) => log(String(d).replace(/^/gm, `${name} `));
  p.stdout.on("data", tag);
  p.stderr.on("data", tag);
  p.on("exit", (c) => c && log(`${name} exited ${c}\n`));
  kids.push(p);
  return p;
}

async function boot() {
  if (!existsSync(PY)) throw new Error("server/.venv is missing — run `npm install` first");
  if (!existsSync(path.join(ROOT, "client", ".next", "BUILD_ID")))
    throw new Error("the client is not built — run `npm run build` first");

  const [api, web] = [await freePort(), await freePort()];
  run("api", PY, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(api)],
      path.join(ROOT, "server"));
  // the web server forwards /api/* to the API, so the window only ever loads one origin
  run("web", process.execPath, [WEB], path.join(ROOT, "client"),
      { ELECTRON_RUN_AS_NODE: "1", HOST: "127.0.0.1", PORT: String(web), API_PORT: String(api) });
  await Promise.all([waitFor(`http://127.0.0.1:${api}/api/health`), waitFor(`http://127.0.0.1:${web}/`)]);
  return { api, web };
}

async function start() {
  let ports;
  try {
    ports = await boot();
  } catch (e) {
    dialog.showErrorBox("Trajectory could not start", String(e.message ?? e));
    app.quit();
    return;
  }

  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 760, backgroundColor: "#000000",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });
  win.loadURL(`http://127.0.0.1:${ports.web}/`);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.on("closed", () => { win = null; });
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
  { role: "editMenu" },
  { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" },
                             { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
                             { type: "separator" }, { role: "togglefullscreen" }] },
  { role: "windowMenu" },
]));

// a broken pipe is never a reason to crash; anything else still surfaces
process.on("uncaughtException", (e) => {
  if (e && e.code === "EPIPE") return;
  dialog.showErrorBox("Trajectory hit an error", String(e?.stack ?? e));
  app.quit();
});

app.whenReady().then(start);
app.on("activate", () => { if (!win) start(); });
app.on("window-all-closed", () => app.quit());
const stop = (sig) => {
  for (const p of kids) {
    if (p.exitCode !== null || p.signalCode !== null) continue;
    try { process.kill(-p.pid, sig); } catch { try { p.kill(sig); } catch {} }
  }
};
app.on("before-quit", () => stop("SIGTERM"));
process.on("exit", () => stop("SIGKILL"));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { stop("SIGTERM"); app.quit(); });
