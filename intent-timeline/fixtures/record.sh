#!/usr/bin/env bash
# Record REAL Claude Code headless runs into fixtures/<name>.jsonl (+ .stderr, .meta).
#
#   bash fixtures/record.sh 02 03          # record the named scenarios
#   bash fixtures/record.sh all            # everything (07 runs a then b; 09 is best-effort)
#
# Every run happens inside scratch/demo-repo (a throwaway copy of demo-repo, so the failing
# test is still failing there), never inside the real demo-repo. Make it first:
#   mkdir -p scratch && cp -R demo-repo scratch/demo-repo
# Each recording costs real usage ($0.3-1.7) and overwrites the bundled fixture of that name.
#
# Permissions: headless has nobody to answer a permission prompt, and ~/.claude/settings.json
# may default to plan mode, which refuses every edit. So each run gets
# an explicit, narrow allowlist: file edits are auto-accepted (acceptEdits) and only the
# named tools / commands may run. Anything outside the list is refused and shows up in the
# stream as system/permission_denied + a tool_result with is_error=true (see 01-fix-test).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$HERE/../scratch/demo-repo"
[ -d "$REPO" ] || { echo "missing $REPO; make it with: mkdir -p scratch && cp -R demo-repo scratch/demo-repo" >&2; exit 1; }
ALLOW="Read,Glob,Grep,Task,Bash(python3 -m pytest:*),Bash(python3 -m logparse.cli:*),Bash(ls:*),Bash(cat:*)"
COMMON=(--output-format stream-json --verbose --permission-mode acceptEdits --allowedTools "$ALLOW")

run() { # run <name> <budget_usd> <prompt> [extra claude flags...]
  local name="$1" budget="$2" prompt="$3"; shift 3
  local out="$HERE/$name.jsonl" err="$HERE/$name.stderr" meta="$HERE/$name.meta"
  local start; start=$(date +%s)
  ( cd "$REPO" && claude -p "$prompt" "${COMMON[@]}" --max-budget-usd "$budget" "$@" </dev/null ) >"$out" 2>"$err"
  local code=$?
  local secs=$(( $(date +%s) - start ))
  {
    echo "scenario=$name"; echo "exit=$code"; echo "seconds=$secs"; echo "cwd=$REPO"
    echo "flags=${COMMON[*]} --max-budget-usd $budget $*"; echo "prompt=$prompt"
  } >"$meta"
  echo "[$name] exit=$code lines=$(wc -l <"$out" | tr -d ' ') secs=$secs"
}

session_id_of() { # last event's session_id in a jsonl file
  python3 -c 'import json,sys
L=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
print(L[-1]["session_id"])' "$1"
}

scenario() {
  case "$1" in
    02) run 02-parallel-reads 2 \
      "Read these three files in parallel, issuing all three Read calls in a single step: src/logparse/parser.py, src/logparse/cli.py, tests/test_parse.py. Then give me a one-sentence summary of each file. Do not modify anything." ;;
    03) run 03-subagents-parallel 4 \
      "Spawn two subagents in parallel using the Task tool. Subagent A surveys the src/ directory; subagent B surveys the tests/ directory. Each subagent must list the files it finds and explain in two or three sentences what the code there does. After both report back, write one combined paragraph summarizing the project. Do not modify any files." ;;
    04) run 04-image-result 2 \
      "Read the image file assets/banner.png and describe what you see in one sentence. Do not modify anything." ;;
    05) run 05-partial-messages 2 \
      "Read src/logparse/parser.py and explain in two sentences what parse_line does. Do not modify anything." \
      --include-partial-messages ;;
    06) run 06-max-turns-error 2 \
      "Run the test suite with python3 -m pytest -q, then fix whatever fails, then run the tests again." \
      --max-turns 1 ;;
    06b) run 06b-bad-resume 1 "Continue where we left off." \
      --resume 00000000-0000-0000-0000-000000000000 ;;
    07) run 07-resume-a 2 \
      "Which file defines this project's command-line entry point, and which flags does it currently accept? Answer in two sentences and do not modify anything."
        local sid; sid=$(session_id_of "$HERE/07-resume-a.jsonl") || { echo "[07] no session id, skipping b"; return; }
        echo "[07] resuming session $sid"
        run 07-resume-b 3 \
      "Add a second flag to the CLI you just described: --json, which prints the level counts as a JSON object instead of the tab-separated table. Implement it, add a test for it, run the tests, and update the README usage section." \
      --resume "$sid" ;;
    09) CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=5 run 09-compact 2 \
      "Read every file under src/ and tests/ one at a time, then read README.md and sample.log, and finally summarize the project in three sentences. Do not modify anything." \
      --max-turns 14 ;;
    09b) # second attempt at a compaction: resume the long 07-resume-b session with a low threshold
        local sid; sid=$(session_id_of "$HERE/07-resume-b.jsonl") || { echo "[09b] need 07-resume-b first"; return; }
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=3 CLAUDE_CODE_AUTO_COMPACT_WINDOW=30000 run 09b-compact-resumed 2 \
      "Summarize everything we did in this session in three sentences, then read README.md once more and confirm the usage section mentions --json. Do not modify anything." \
      --resume "$sid" --max-turns 8 ;;
    *) echo "unknown scenario $1"; return 1 ;;
  esac
}

if [ $# -eq 0 ] || [ "$1" = all ]; then set -- 02 03 04 05 06 06b 07 09; fi
for s in "$@"; do scenario "$s"; done
