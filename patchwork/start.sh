#!/usr/bin/env bash
# Starts Patchwork with `npm run dev` (Vite web app + loopback API server), running `npm ci` first if needed.
# PORT/HOST change the address (default http://localhost:8000); API_PORT moves the internal API (default 8001).
# Takes no arguments.
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "patchwork: $*" >&2; exit 1; }
command -v node >/dev/null || die "needs Node.js 20.19+ or 22.12+, but node is not installed"
node -e 'var v = process.versions.node.split(".").map(Number); process.exit(v[0] > 22 || (v[0] === 22 && v[1] >= 12) || (v[0] === 20 && v[1] >= 19) ? 0 : 1)' ||
  die "needs Node.js 20.19+ or 22.12+, found $(node -v)"
command -v npm >/dev/null || die "needs npm 10+, but npm is not installed"
npm_version=$(npm -v)
[ "${npm_version%%.*}" -ge 10 ] 2>/dev/null || die "needs npm 10+, found $npm_version"

# npm rewrites node_modules/.package-lock.json on every install, so an older copy means the lockfile changed.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci
fi

exec npm run dev
