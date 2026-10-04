import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Two projects, because the code under test wants two environments:
 *
 *   unit  — pure logic (lib/, parseEvent) and the server handler, in node.
 *   dom   — the hook and the fetch-driven client, in jsdom.
 *
 * A separate file from vite.config.ts on purpose: the dev config mounts the
 * run API into Vite's middleware, and a test run has no business spawning
 * agents.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts", "tests/server/**/*.test.mjs"],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["tests/dom/**/*.test.{ts,tsx}"],
          setupFiles: ["./tests/setup.dom.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "server/*.mjs"],
      // Presentation-only: rendered by the components, covered by the eye.
      exclude: ["src/main.tsx", "src/**/*.css"],
      reporter: ["text", "html"],
    },
  },
});
