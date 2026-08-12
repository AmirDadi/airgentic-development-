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
  last_seen: number | null;
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
  body: string;
  session_id: string | null;
}

export interface Thread {
  id: string;
  participants: [string, string];
  messages: Message[];
  last_ts: number;
  last_body: string;
}

/**
 * One parsed line of an agent's transcript. Mirrors the backend's
 * `TranscriptEntry` exactly — the discriminant is `kind`.
 */
export type TranscriptEntry =
  | { kind: "assistant_text"; ts: number | null; text: string }
  | { kind: "user_text"; ts: number | null; text: string }
  | { kind: "thinking"; ts: number | null; text: string }
  | { kind: "tool_call"; ts: number | null; tool: string; summary: string; id: string | null }
  | { kind: "tool_result"; ts: number | null; tool_use_id: string | null; ok: boolean; summary: string }
  | { kind: "send_message"; ts: number | null; direction: "sent" | "received"; peer: string; body: string }
  | { kind: "system_event"; ts: number | null; event: string; detail: string }
  | { kind: "turn_end"; ts: number | null }
  | { kind: "unknown"; ts: number | null; raw: string };

/** A `TranscriptEntry` as persisted and served by the backend. */
export interface StoredEntry {
  id: string;
  agent: string;
  ts: number;
  kind: string;
  entry: TranscriptEntry;
  session_id: string | null;
}
