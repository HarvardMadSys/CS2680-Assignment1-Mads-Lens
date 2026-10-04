#!/usr/bin/env bash
# Starts Sankey Flow (Flask, app.py), creating .venv and installing requirements.txt into it when needed.
# PORT/HOST change the address (default http://localhost:8000). Arguments go to app.py:
# --demo (open the bundled demo session instead of ~/.claude/projects), --port N, --host ADDR.
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "sankey-flow: $*" >&2; exit 1; }
command -v python3 >/dev/null || die "needs Python 3.9+, but python3 is not installed"
python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' || die "needs Python 3.9+, found $(python3 -V 2>&1)"

# Create the venv if it's missing, or if an interrupted or failed attempt left it without pip.
[ -x .venv/bin/pip ] || python3 -m venv .venv
# Install only when requirements.txt is newer than the last successful install.
if [ requirements.txt -nt .venv/.requirements-installed ]; then
  .venv/bin/pip install -r requirements.txt
  touch .venv/.requirements-installed
fi

exec .venv/bin/python app.py "$@"
