/**
 * The --replay flag.
 *
 * A recorded run is the fast way to work on the rendering: instant, free, and
 * the same every time. Several files can be given, and successive runs take
 * the next one — so a conversation can replay a *different* trajectory each
 * round, and two runs started together do not show the identical stream.
 *
 * Accepted forms:
 *   REPLAY=fixtures/a.jsonl,fixtures/b.jsonl   (environment variable)
 *   --replay=fixtures/a.jsonl
 *   --replay=[fixtures/a.jsonl, fixtures/b.jsonl]
 *   --replay fixtures/a.jsonl fixtures/b.jsonl
 */

import { existsSync } from "node:fs";

/** Pull the files out of an argv array. Returns [] when the flag is absent. */
export function parseReplayFlag(argv) {
  const files = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith("--replay=")) {
      files.push(...splitList(arg.slice("--replay=".length)));
      continue;
    }

    if (arg !== "--replay") continue;

    // Bare `--replay` takes every following argument that is not a flag, so
    // a shell-expanded glob works as well as a written-out list.
    for (let j = i + 1; j < argv.length && !argv[j].startsWith("-"); j++) {
      files.push(...splitList(argv[j]));
      i = j;
    }
  }

  return files;
}

/**
 * The same list from an environment variable, which survives `npm run`
 * without the extra `--`:  REPLAY=fixtures/a.jsonl,fixtures/b.jsonl
 */
export function parseReplayEnv(value) {
  return value ? splitList(value) : [];
}

/** `[a.jsonl, b.jsonl]` or `a.jsonl,b.jsonl` or a bare path. */
function splitList(value) {
  return value
    .trim()
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * Hands out the next file on each call, cycling once the list runs out.
 * Returns null when nothing is being replayed, which is the live case.
 */
export function createReplayRotation(files) {
  let next = 0;

  return {
    files,
    get active() {
      return files.length > 0;
    },
    take() {
      if (files.length === 0) return null;
      const file = files[next % files.length];
      next += 1;
      return file;
    },
  };
}

/** Complain early about a path that is not there, rather than mid-run. */
export function checkReplayFiles(files) {
  return files.filter((file) => !existsSync(file));
}
