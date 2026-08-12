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
  websearch: "searching the web with",
  webfetch: "fetching with",
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

/** One-line description of a single entry, or null when it says nothing. */
function describe(entry: TranscriptEntry): string | null {
  switch (entry.kind) {
    case "assistant_text":
      return nonEmpty(entry.text);
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
      const described = describe(entry);
      if (described !== null) return clamp(described);
    }
    return UNKNOWN_ACTIVITY;
  } catch {
    return UNKNOWN_ACTIVITY;
  }
}
