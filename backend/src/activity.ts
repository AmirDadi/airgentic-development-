import type { TranscriptEntry } from "./types.js";

/**
 * Turns the tail of an agent's transcript into a one-line "what is it doing
 * now" string for the roster.
 *
 * Same tolerance contract as the parser (PRD R1): entries we could not
 * classify are simply stepped over, and when nothing in the tail is legible
 * the answer is the honest `"activity unknown"` rather than a guess or a
 * throw. Pure: no clock, no I/O.
 */

/** Longest activity line we emit; the UI renders it on one row. */
export const ACTIVITY_MAX_LENGTH = 120;

const UNKNOWN_ACTIVITY = "activity unknown";
const IDLE_ACTIVITY = "idle — waiting for the next turn";
const ELLIPSIS = "…";

/** Verb per known tool. Unknown tools fall back to a generic phrasing. */
const TOOL_VERBS: Record<string, string> = {
  bash: "running",
  bashoutput: "running",
  read: "reading",
  notebookread: "reading",
  edit: "editing",
  multiedit: "editing",
  notebookedit: "editing",
  write: "writing",
  grep: "searching",
  glob: "searching",
  task: "delegating to",
  agent: "delegating to",
  websearch: "searching the web with",
  webfetch: "fetching with",
  toolsearch: "searching for tools with",
};

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clamp(value: string): string {
  const flat = oneLine(value);
  if (flat.length <= ACTIVITY_MAX_LENGTH) return flat;
  return flat.slice(0, ACTIVITY_MAX_LENGTH - 1) + ELLIPSIS;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const flat = oneLine(value);
  return flat.length > 0 ? flat : null;
}

function describeToolCall(tool: string | null, summary: string | null): string | null {
  if (tool === null) return null;
  const verb = TOOL_VERBS[tool.toLowerCase()] ?? "using tool";
  const head = `${verb} (${tool})`;
  return summary === null ? head : `${head}: ${summary}`;
}

/**
 * Name of the tool a result belongs to, found by walking back to the
 * `tool_call` that carried the same id. A tool_result block does not repeat the
 * tool name, so "Bash finished" is only sayable with this pairing; when the
 * call has already scrolled out of the window we fall back to "the tool".
 */
function toolForResult(
  entries: TranscriptEntry[],
  index: number,
  toolUseId: string | null,
): string | null {
  if (toolUseId === null || toolUseId === "") return null;
  for (let i = index - 1; i >= 0; i--) {
    const candidate = entries[i];
    if (candidate === null || typeof candidate !== "object") continue;
    if (candidate.kind === "tool_call" && candidate.id === toolUseId) {
      return nonEmpty(candidate.tool);
    }
  }
  return null;
}

function describeToolResult(
  entry: Extract<TranscriptEntry, { kind: "tool_result" }>,
  entries: TranscriptEntry[],
  index: number,
): string | null {
  const summary = nonEmpty(entry.summary);
  const tool = toolForResult(entries, index, entry.tool_use_id);
  if (entry.ok) {
    // A bare success with nothing to show says less than the call before it.
    if (summary === null && tool === null) return null;
    const head = tool === null ? "tool finished" : `${tool} finished`;
    return summary === null ? head : `${head}: ${summary}`;
  }
  const head = tool === null ? "tool call failed" : `${tool} failed`;
  return summary === null ? head : `${head}: ${summary}`;
}

/** One-line description of a single entry, or null when it says nothing. */
function describe(entry: TranscriptEntry, entries: TranscriptEntry[], index: number): string | null {
  switch (entry.kind) {
    case "assistant_text":
      return nonEmpty(entry.text);
    case "user_text": {
      const body = nonEmpty(entry.text);
      return body === null ? null : `handling request: ${body}`;
    }
    case "thinking": {
      const body = nonEmpty(entry.text);
      return body === null ? null : `thinking: ${body}`;
    }
    case "tool_result":
      return describeToolResult(entry, entries, index);
    case "system_event":
      // Attachments, queue operations, mode switches and hook summaries are
      // session bookkeeping, not something the agent is DOING. Recognised by
      // the parser so they do not count as unknown, but stepped over here so
      // the roster keeps showing the last real action.
      return null;
    case "tool_call":
      return describeToolCall(nonEmpty(entry.tool), nonEmpty(entry.summary));
    case "send_message": {
      const peer = nonEmpty(entry.peer);
      if (peer === null) return null;
      const body = nonEmpty(entry.body);
      const head =
        entry.direction === "sent" ? `messaging ${peer}` : `received a message from ${peer}`;
      return body === null ? head : `${head}: ${body}`;
    }
    case "turn_end":
      return IDLE_ACTIVITY;
    case "unknown":
      // R1 degradation path: step over it and keep looking further back.
      return null;
    default:
      return null;
  }
}

/**
 * One-line human summary of what the agent is doing NOW, from the tail of its
 * entries. Returns "activity unknown" when it cannot tell.
 */
export function deriveActivity(entries: TranscriptEntry[]): string {
  try {
    if (!Array.isArray(entries)) return UNKNOWN_ACTIVITY;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry === null || typeof entry !== "object") continue;
      const described = describe(entry, entries, i);
      if (described !== null) return clamp(described);
    }
    return UNKNOWN_ACTIVITY;
  } catch {
    return UNKNOWN_ACTIVITY;
  }
}
