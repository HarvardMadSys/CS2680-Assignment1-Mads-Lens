#!/usr/bin/env bash
# Starts Subagents as a team with `pnpm dev` (live mode, runs the claude CLI), running `pnpm install` first if needed.
# PORT/HOST change the address (default http://localhost:8000).
# Optional argument --demo runs `pnpm demo` instead, which replays recordings and needs no Claude install.
set -euo pipefail
cd "$(dirname "$0")"

case "$#:${1:-}" in
  0:) script=dev ;;
  1:--demo) script=demo ;;
  *) echo "usage: $0 [--demo]  (--demo replays recordings instead of running claude)" >&2; exit 2 ;;
esac

die() { echo "subagents-as-a-team: $*" >&2; exit 1; }
command -v node >/dev/null || die "needs Node.js 22+, but node is not installed"
node -e 'process.exit(parseInt(process.versions.node) >= 22 ? 0 : 1)' || die "needs Node.js 22+, found $(node -v)"
# The README's pnpm 10, fetched with npx when the pnpm on PATH is missing or another major (latest is newer).
pnpm=(npx -y pnpm@10)
if command -v pnpm >/dev/null; then case $(pnpm --version) in 10.*) pnpm=(pnpm) ;; esac; fi
command -v "${pnpm[0]}" >/dev/null || die "needs pnpm 10, or npx to fetch it, but neither is installed"
# Without Claude Code the console still opens (history, replays, imports), so this only warns.
[ "$script" = demo ] || command -v "${SUBAGENTS_AS_A_TEAM_CLAUDE_BIN:-claude}" >/dev/null ||
  echo "subagents-as-a-team: ${SUBAGENTS_AS_A_TEAM_CLAUDE_BIN:-claude} is not installed, so live runs will fail; --demo replays recordings" >&2

# pnpm rewrites node_modules/.modules.yaml on every install, so an older copy means the lockfile changed.
if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
  "${pnpm[@]}" install --frozen-lockfile
fi

exec "${pnpm[@]}" "$script"
