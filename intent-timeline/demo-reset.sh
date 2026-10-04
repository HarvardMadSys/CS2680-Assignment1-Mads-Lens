#!/usr/bin/env bash
# Put demo-repo back to its committed state (test_parse failing again) and prove it.
# Run from this folder (needs a git checkout of it, and pytest for the check):   bash demo-reset.sh
# PYTHON picks the interpreter that has pytest (default: python3).
set -e
cd "$(dirname "$0")"
git checkout -- demo-repo
git clean -fdq demo-repo
PY="${PYTHON:-python3}"
cd demo-repo
echo "demo-repo reset. pytest says:"
"$PY" -m pytest -q -p no:cacheprovider --color=no 2>&1 | tail -1
