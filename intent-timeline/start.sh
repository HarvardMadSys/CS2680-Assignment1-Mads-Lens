#!/usr/bin/env bash
# Starts Intent Timeline (python3 proto/server.py). It uses only the standard library, so installs nothing.
# PORT/HOST change the address (default http://localhost:8000). Arguments go to the server: --port N, --host ADDR.
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "intent-timeline: $*" >&2; exit 1; }
command -v python3 >/dev/null || die "needs Python 3.9+, but python3 is not installed"
python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' || die "needs Python 3.9+, found $(python3 -V 2>&1)"

exec python3 proto/server.py "$@"
