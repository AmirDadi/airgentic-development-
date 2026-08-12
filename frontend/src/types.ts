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
