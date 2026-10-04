#!/usr/bin/env bash
# Starts Swimlanes (python3 website.py). It uses only the standard library, so installs nothing.
# PORT/HOST change the address (default http://localhost:8000). Arguments go to website.py:
# --port N, --host ADDR, --dir PATH (relative to this folder), --model NAME.
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "swimlanes: $*" >&2; exit 1; }
command -v python3 >/dev/null || die "needs Python 3.7+, but python3 is not installed"
python3 -c 'import sys; sys.exit(sys.version_info < (3, 7))' || die "needs Python 3.7+, found $(python3 -V 2>&1)"

exec python3 website.py "$@"
