/**
 * Production entry point: serve the built page and the API from one port.
 *
 * In development you do not need this — `npm run dev` mounts the same API
 * handler inside Vite (see vite.config.ts), so there is one process and no
 * proxy. This exists for `npm run start`, after `npm run build`.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiHandler, describeMode } from "./api.mjs";
import {
  checkReplayFiles,
  createReplayRotation,
  parseReplayEnv,
  parseReplayFlag,
} from "./replay.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";

/** --replay=[a.jsonl, b.jsonl] or REPLAY=a.jsonl,b.jsonl: stream recordings instead of spawning. */
const REPLAY_FILES = [
  ...parseReplayFlag(process.argv.slice(2)),
  ...parseReplayEnv(process.env.REPLAY),
];

const missing = checkReplayFiles(REPLAY_FILES);
if (missing.length > 0) {
  console.error(`No such recording:\n${missing.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}

const replay = createReplayRotation(REPLAY_FILES);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const api = createApiHandler({ replay });

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let file = path.join(DIST, decodeURIComponent(url.pathname));

  // Anything outside dist/, or any unknown path, falls back to index.html.
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
    file = path.join(DIST, "index.html");
  }

  if (!existsSync(file)) {
    const body = JSON.stringify({
      error: "No build found. Run `npm run build`, or use `npm run dev`.",
    });
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    return res.end(body);
  }

  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
  });
  createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  api(req, res, () => serveStatic(req, res));
});

// All interfaces by default. This endpoint runs an agent with tool access, so
// use HOST=127.0.0.1 on a network you do not trust.
server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  console.log(`\n  AIPatrol  http://${shown}:${PORT}  (listening on ${HOST})`);
  console.log(describeMode(replay));
  console.log("");
});
