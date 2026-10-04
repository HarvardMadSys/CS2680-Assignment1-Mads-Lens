# Linecount — disposable agent demo

A tiny Node CLI with no dependencies. Run `npm test` or `node cli.mjs sample.txt`.
The trailing-newline test **intentionally fails** in this template. A newline terminates
a line; an empty input should contain zero lines. Do not fix this template as part of the
frontend's test suite: copy it to a new temporary workspace and let Claude fix the copy.

Useful tasks: repair the line-counting bug without weakening tests; add a `--json` output
flag with tests and documentation; ask subagents to independently review code and tests.

From the Patchwork folder, `npm run demo:prepare` creates a fresh copy and prints its path.
Select that path with **Change** in the web app. Re-running preparation creates another
copy; it does not reset or delete a previous experiment.
