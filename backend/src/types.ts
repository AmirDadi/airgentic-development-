/** Pipeline stages, in order. A feature advances left-to-right. */
export const STAGES = [
  "not_started",
  "spec",
  "interfaces",
  "plan",
  "implementing",
  "in_review",
  "merge_ready",
  "merged",
] as const;

export type Stage = (typeof STAGES)[number];

export interface Agent {
  name: string;
  kind: string;
  workdir: string;
  alive: boolean;
  /** Epoch ms of the last signal we saw from this agent. */
  last_seen: number | null;
  /** One-line "what it's doing now", or null when we can't tell. */
  current_activity: string | null;
}

export interface Feature {
  name: string;
  owner: string | null;
  stage: Stage;
  branch: string | null;
  pr_url: string | null;
  updated_at: number;
}

export type MessageChannel = "inter_agent" | "human_web";

export interface Message {
  id: string;
  ts: number;
  from_agent: string;
  to_agent: string;
  channel: MessageChannel;
  /** Always redacted before it reaches the store (PRD R4). */
  body: string;
  session_id: string | null;
}

export interface Event {
  id: string;
  ts: number;
  agent: string | null;
  type: string;
  /** Arbitrary JSON payload, stored serialised. */
  payload: unknown;
}

/**
 * A classified transcript entry. `unknown` is a first-class outcome, not an
 * error: the JSONL schema is internal and may change under us (PRD R1).
 */
export type TranscriptEntry =
  /** A `text` block on an assistant message — what the agent said. */
  | { kind: "assistant_text"; ts: number | null; text: string }
  /** A `text` block (or bare string content) on a user message — a prompt in. */
  | { kind: "user_text"; ts: number | null; text: string }
  /** A `thinking` block — the model's own reasoning, bounded to one line. */
  | { kind: "thinking"; ts: number | null; text: string }
  | {
      kind: "tool_call";
      ts: number | null;
      tool: string;
      summary: string;
      /** The block's `id`, so a later tool_result can be paired back to it. */
      id: string | null;
    }
  | {
      kind: "tool_result";
      ts: number | null;
      /** Matches the `id` of the tool_call it answers; null when absent. */
      tool_use_id: string | null;
      /** False when the block carried `is_error: true`. */
      ok: boolean;
      /** Bounded, single-line rendering of the result payload. */
      summary: string;
    }
  | {
      kind: "send_message";
      ts: number | null;
      direction: "sent" | "received";
      peer: string;
      body: string;
    }
  /**
   * A non-message bookkeeping entry (`attachment`, `last-prompt`,
   * `queue-operation`, `system`, `mode`). Recognised so it does not pollute the
   * unknown rate, but deliberately NOT treated as agent activity.
   */
  | { kind: "system_event"; ts: number | null; event: string; detail: string }
  | { kind: "turn_end"; ts: number | null }
  | { kind: "unknown"; ts: number | null; raw: string };
