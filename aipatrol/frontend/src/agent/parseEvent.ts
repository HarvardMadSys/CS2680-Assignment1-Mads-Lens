import { hasTaskMarkers, splitTaskMarkers } from "../lib/tasks";
import type { RunHandlers } from "./driver";

/**
 * One line of `--output-format stream-json`, dispatched to the handlers.
 *
 * The shapes, trimmed to what the UI uses:
 *   {"type":"system","subtype":"init","session_id":…,"cwd":…,"tools":[…]}
 *   {"type":"assistant","message":{"content":[
 *      {"type":"text","text":…} | {"type":"tool_use","id":…,"name":…,"input":…}]}}
 *   {"type":"user","message":{"content":[
 *      {"type":"tool_result","tool_use_id":…,"content":…,"is_error":…}]}}
 *   {"type":"result","subtype":"success","session_id":…,
 *    "total_cost_usd":…,"duration_ms":…,"num_turns":…}
 *
 * Plus two the server adds: `_error` and `_stderr`.
 */
export function dispatchEvent(event: unknown, handlers: RunHandlers): void {
  if (!isRecord(event)) return;

  // Top-level on every event: null for the main agent, otherwise the id of
  // the tool call whose subagent emitted it.
  const parent =
    typeof event.parent_tool_use_id === "string"
      ? event.parent_tool_use_id
      : null;

  switch (event.type) {
    case "system":
      // Only `init` announces a session. The other subtypes (task_started,
      // task_progress, …) repeat the same id and are not session events.
      if (event.subtype === "init" && typeof event.session_id === "string") {
        handlers.onSession(event.session_id);
      }
      return;

    case "assistant": {
      const blocks = contentBlocks(event.message);

      // Several tool_use blocks in one message went out together. That is the
      // only evidence the stream gives that calls ran in parallel.
      const calls = blocks.filter((b) => b.type === "tool_use").length;
      const batchId =
        calls > 1
          ? `batch_${typeof event.uuid === "string" ? event.uuid : Math.random()}`
          : null;

      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          emitText(block.text, parent, handlers);
        } else if (
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          handlers.onToolUse({
            id: block.id,
            name: block.name,
            input: isRecord(block.input) ? block.input : {},
            parentToolUseId: parent,
            batchId,
          });
        }
      }
      return;
    }

    case "user":
      for (const block of contentBlocks(event.message)) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          handlers.onToolResult({
            id: block.tool_use_id,
            ok: block.is_error !== true,
            content: resultText(block.content),
          });
        }
      }
      return;

    case "result": {
      const failed =
        typeof event.subtype === "string" && event.subtype !== "success";
      if (failed || event.is_error === true) {
        handlers.onError(
          text(event.result) ||
            `Run ended with subtype "${String(event.subtype)}".`,
        );
        return;
      }
      handlers.onDone({
        sessionId: typeof event.session_id === "string" ? event.session_id : "",
        costUsd: num(event.total_cost_usd),
        durationMs: num(event.duration_ms),
        numTurns: num(event.num_turns),
      });
      return;
    }

    // --- events the server adds -------------------------------------
    case "_error":
      handlers.onError(text(event.message) || "The run failed.");
      return;

    case "_stderr":
      // Kept off the trajectory: stderr is usually progress noise, and it is
      // reported through onError anyway when the run dies without a result.
      return;

    default:
      return;
  }
}

/**
 * Assistant text may carry task markers. Split them out so the structure is
 * captured and the markers themselves never reach the page as literal text.
 */
function emitText(
  block: string,
  parent: string | null,
  handlers: RunHandlers,
): void {
  if (!hasTaskMarkers(block)) {
    if (block.trim()) handlers.onText(block, parent);
    return;
  }

  for (const segment of splitTaskMarkers(block)) {
    if (segment.kind === "text") handlers.onText(segment.text, parent);
    else if (segment.kind === "start") handlers.onTaskStart(segment.title, parent);
    else handlers.onTaskEnd(parent);
  }
}

/* --- narrowing helpers --------------------------------------------- */

interface Block {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  content?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function contentBlocks(message: unknown): Block[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord) as Block[];
}

/**
 * A tool_result's content is either a plain string or an array of blocks.
 * Both appear in practice, so handle each.
 */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isRecord(part) && typeof part.text === "string"
          ? part.text
          : typeof part === "string"
            ? part
            : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content, null, 2);
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
