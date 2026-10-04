#!/usr/bin/env bash
# Starts Fork View with `npm run dev` (Vite UI + loopback API server), running `npm ci` first if needed.
# PORT/HOST change the address (default http://localhost:8000); API_PORT moves the internal API (default 8001).
# Takes no arguments.
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "fork-view: $*" >&2; exit 1; }
command -v node >/dev/null || die "needs Node.js 22.12+, but node is not installed"
node -e 'var v = process.versions.node.split(".").map(Number); process.exit(v[0] > 22 || (v[0] === 22 && v[1] >= 12) ? 0 : 1)' ||
  die "needs Node.js 22.12+, found $(node -v)"
command -v npm >/dev/null || die "needs npm (bundled with Node.js 22.12+), but npm is not installed"

# npm rewrites node_modules/.package-lock.json on every install, so an older copy means the lockfile changed.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci
fi

exec npm run dev
