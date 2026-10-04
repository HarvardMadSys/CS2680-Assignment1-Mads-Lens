#!/usr/bin/env bash
# Starts Controller (node src/server.ts; Node runs the TypeScript itself). Installs nothing: there are no
# runtime dependencies, and `npm install` only fetches the tools for `npm run typecheck`.
# PORT/HOST change the address (default http://localhost:8000). Takes no arguments.
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "controller: $*" >&2; exit 1; }
command -v node >/dev/null || die "needs Node.js 22.18+, but node is not installed"
version=$(node --version)
IFS=. read -r major minor _ <<< "${version#v}"
(( major > 22 || (major == 22 && minor >= 6) )) || die "needs Node.js 22.18+, found $version"

# Node strips TypeScript types by default from 22.18 (and 23.6); 22.6-22.17 and 23.0-23.5 need the flag.
if (( (major == 22 && minor < 18) || (major == 23 && minor < 6) )); then
  exec node --experimental-strip-types src/server.ts
fi
exec node src/server.ts
