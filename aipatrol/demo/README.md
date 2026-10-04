# The demo project

Something for the agent to work on. A page that drives Claude Code against an
empty directory shows nothing worth watching, so this is a small real
codebase — `logtool`, a command-line summariser for web-server access logs.
Four modules, three test files, thirteen tests.

```
demo/
  pristine/    the starting state, committed — never worked in
  workspace/   the copy the agent edits, gitignored
```

Reset the workspace to the starting state before a demo, and again after:

```
npm run demo:reset          # run from frontend/
```

**One test fails on purpose.** `--top` is accepted by the CLI and then
quietly ignored by `build_report`, so `test_top_limits_how_many_paths_come_back`
fails. Finding it means reading `cli.py`, following the argument into
`report.py`, and noticing the parameter is never used — a two-file trace whose
fix is one word. That is the point: the agent has to read, run and edit.

## Tasks that demo well

| Prompt | What it exercises |
| ------ | ----------------- |
| `pytest` fails — find out why and fix it | read, run, edit, re-run; red turns green inside one run |
| Add a `--json` flag and update the README | multi-file edit, and the README has no `--json` in it |
| Use two subagents to survey the code and the docs, then reconcile them | the tree view, with something for the summary to disagree about |

Run `pytest` inside `workspace/` to see where it stands. The agent has tool
access there and the directory is disposable, which is why runs should point
at `workspace/` and never at `pristine/` or the frontend's own source.
