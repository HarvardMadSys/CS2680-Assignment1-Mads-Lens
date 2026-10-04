// One origin for the browser: serves the Next app and forwards /api/* (including the SSE run
// streams) to the Python API, so the page only ever talks to this port.
//
//   node server.mjs          production (after `next build`)
//   node server.mjs --dev    development, with hot reload
//
// PORT (8000) and HOST (0.0.0.0) are where this listens; API_PORT (8001, alias PORT_API) is
// where the Python API listens on 127.0.0.1.
//
// The proxy is done here rather than with Next rewrites: rewrites are fixed at build time and
// their responses get gzip-buffered, which holds back a live event stream until the run ends.
import { createServer, request } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dev = process.argv.includes("--dev");
process.env.NODE_ENV ??= dev ? "development" : "production";

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8000);
const apiHost = "127.0.0.1";
const apiPort = Number(process.env.API_PORT || process.env.PORT_API || 8001);

const { default: next } = await import("next");
const app = next({ dev, dir: dirname(fileURLToPath(import.meta.url)), hostname: host, port });
const handle = app.getRequestHandler();
await app.prepare();

function proxy(req, res) {
  const up = request(
    { host: apiHost, port: apiPort, method: req.method, path: req.url,
      headers: { ...req.headers, host: `${apiHost}:${apiPort}` } },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      res.flushHeaders();
      r.pipe(res);
    },
  );
  up.on("error", (e) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: `API not reachable at ${apiHost}:${apiPort} (${e.code || e.message})` }));
  });
  // a closed EventSource must end the upstream stream too, or the API keeps a dead subscriber
  res.on("close", () => { if (!res.writableFinished) up.destroy(); });
  req.pipe(up);
}

createServer((req, res) => {
  if (req.url === "/api" || req.url.startsWith("/api/")) proxy(req, res);
  else handle(req, res);
}).listen(port, host, () => {
  const shown = host === "0.0.0.0" ? "localhost" : host;
  console.log(`> Trajectory on http://${shown}:${port} (listening on ${host}, API at ${apiHost}:${apiPort})`);
});
