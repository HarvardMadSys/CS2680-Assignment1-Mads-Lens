import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";
// @ts-expect-error -- plain JS module, no types
import { createApiHandler, describeMode } from "./server/api.mjs";
// @ts-expect-error -- plain JS module, no types
import { checkReplayFiles, createReplayRotation, parseReplayEnv, parseReplayFlag } from "./server/replay.mjs";

/**
 * Mount the run API inside Vite's own dev server. One process, no proxy —
 * and so no 502 when a second process is not running.
 *
 * Recordings stand in for the agent:
 *   REPLAY=fixtures/a.jsonl,fixtures/b.jsonl npm run dev
 *   npm run dev -- -- --replay=[fixtures/a.jsonl, fixtures/b.jsonl]
 */
function agentApi(): PluginOption {
  // Vite passes anything after `--` straight through in argv.
  const files: string[] = [
    ...parseReplayFlag(process.argv.slice(2)),
    ...parseReplayEnv(process.env.REPLAY),
  ];
  const missing: string[] = checkReplayFiles(files);
  if (missing.length > 0) {
    throw new Error(`No such recording: ${missing.join(", ")}`);
  }
  const replay = createReplayRotation(files);

  return {
    name: "agent-api",
    configureServer(server) {
      server.middlewares.use(createApiHandler({ replay }));
      server.httpServer?.once("listening", () => {
        console.log(describeMode(replay));
      });
    },
  };
}

/** Hostnames to accept besides localhost and IP addresses, e.g. ALLOWED_HOSTS=mybox.local */
const allowedHosts = (process.env.ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react(), agentApi()],
  server: {
    // Reachable from other machines by default. The agent runs with tool
    // access, so use HOST=127.0.0.1 on a network you do not trust.
    host: process.env.HOST || "0.0.0.0",
    port: Number(process.env.PORT || 8000),
    strictPort: true,
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
  },
});
