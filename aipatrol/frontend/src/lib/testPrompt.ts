/**
 * The Ctrl+B prompt: one run that exercises every shape this page renders,
 * so a change can be checked against the real thing rather than a fixture.
 *
 * It is loaded into the composer rather than sent, because it spawns an agent
 * with tool access — you should see where it will run before it runs.
 */
export const TEST_PROMPT = `Exercise this interface so I can check it renders everything correctly.
Work only inside the current directory. Do not modify or delete any file.

1. Start a task "Survey the directory". Inside it:
   - list the directory with Bash
   - read one source file with Read
   - start a nested task "Look for loose ends", and inside that grep for TODO
   - close the nested task, then close the outer one

2. Start a task "Delegate the summaries". Inside it, launch two subagents at
   the same time: one to summarise the code, one to summarise the docs. Tell
   the code subagent to itself use a subagent for the test files, so there is
   a subagent nested inside a subagent. Close the task when both report back.

3. Start a task "Provoke a failure". Inside it, call Read on the path
   /nonexistent/definitely-not-here.txt so a tool error appears. Report the
   error; do not work around it. Close the task.

4. Finish with a short paragraph summarising what you found.

Every [[task-start]] must have its matching [[task-end]], including the last.`;
