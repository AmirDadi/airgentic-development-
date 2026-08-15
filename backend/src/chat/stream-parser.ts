/**
 * Classifier for one line of `claude -p --output-format stream-json` output.
 *
 * Same contract as `transcript-parser.ts`, and for the same reason: the
 * stream-json schema is internal, undocumented and WILL change under us
 * (PRD R1). Recognition is additive — we look for the shapes we verified in
 * SPIKE-R2, and anything else is `ignored`, never an error. Pure: no I/O, no
 * module state, never throws.
 *
 * Shapes recognised (observed on this machine, one object per line):
 *   {"type":"stream_event","event":{"type":"content_block_delta",
 *     "delta":{"type":"text_delta","text":"…"}}}   → delta
 *   {"type":"result","is_error":false,"result":"…","total_cost_usd":0.01} → final
 *   {"type":"result","is_error":true,…}                                   → error
 * Everything else — `assistant`, `message_stop`, `system`, `active_goal`,
 * `autocompact_state`, `rate_limit_event`, blank lines, half-written JSON —
 * is ignored.
 */

export type ChatStreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "final"; text: string; usage: number | null }
  | { kind: "error"; message: string }
  | { kind: "ignored" };

const IGNORED: ChatStreamEvent = { kind: "ignored" };

/** Fallback text for a failed turn that carried no message of its own. */
const DEFAULT_ERROR = "agent turn failed";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseStreamLine(line: string): ChatStreamEvent {
  if (typeof line !== "string") return IGNORED;
  const trimmed = line.trim();
  if (trimmed.length === 0) return IGNORED;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // A truncated or non-JSON line is normal (the CLI also writes prose to
    // stdout in some modes); it must never fail the turn.
    return IGNORED;
  }

  if (!isRecord(parsed)) return IGNORED;

  switch (parsed.type) {
    case "stream_event":
      return classifyStreamEvent(parsed.event);
    case "result":
      return classifyResult(parsed);
    default:
      return IGNORED;
  }
}

function classifyStreamEvent(event: unknown): ChatStreamEvent {
  if (!isRecord(event)) return IGNORED;
  if (event.type !== "content_block_delta") return IGNORED;

  const delta = event.delta;
  if (!isRecord(delta)) return IGNORED;
  // Only text deltas are ours: `input_json_delta` and friends are tool-call
  // plumbing the chat drawer must not render.
  if (delta.type !== "text_delta") return IGNORED;
  if (typeof delta.text !== "string") return IGNORED;

  return { kind: "delta", text: delta.text };
}

function classifyResult(obj: Record<string, unknown>): ChatStreamEvent {
  const text = typeof obj.result === "string" ? obj.result : "";

  // `is_error === true` is the only failure signal; a missing field means the
  // turn succeeded (a truthiness test here would misread `is_error: "no"`).
  if (obj.is_error === true) {
    return { kind: "error", message: text.length > 0 ? text : DEFAULT_ERROR };
  }

  // A result whose text is not a string is a shape we do not understand; it is
  // safer to ignore it than to report an empty reply as the agent's answer.
  if (typeof obj.result !== "string") return IGNORED;

  const cost = obj.total_cost_usd;
  return {
    kind: "final",
    text,
    // Usage is a list-price valuation, not billing (SPIKE-R2). Absent or
    // non-numeric = unknown, never 0, which would read as "this turn was free".
    usage: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
  };
}
