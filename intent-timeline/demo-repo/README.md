# demo-cli

A tiny log-parsing CLI used as the default scratch codebase for the trajectory viewer.
Give Claude Code concrete tasks here ("find the bug that makes test_parse fail and fix it",
"add a --json flag and update the README") and watch the trajectory in the web UI.

## Usage

    python3 -m logparse.cli sample.log
    python3 -m logparse.cli --level ERROR sample.log

## Tests

    python3 -m pytest -q

## Reset after a demo

    bash demo-reset.sh        # from the viewer's folder; same as:
    git checkout -- demo-repo && git clean -fd demo-repo
