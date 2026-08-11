import type { TranscriptEntry } from "./types.js";

/**
 * Tolerant parser for Claude Code session transcript JSONL (PRD R1).
 *
 * The on-disk schema is internal and undocumented, and it WILL change under
 * us. Every function here is written defensively: nothing throws, every
 * unrecognised shape degrades to `{ kind: "unknown", raw }` and parsing of the
 * rest of the file continues. Recognition is *additive* — we look for the
 * fields we know, and the absence of any of them is a normal outcome, never
 * an error. This module is pure: no filesystem, no clock, no globals.
 */

/** Longest summary we will ever emit for a tool call. */
export const SUMMARY_MAX_LENGTH = 80;

const ELLIPSIS = "…";

/** Tool names that mean "I sent a message to another agent". */
const SEND_MESSAGE_TOOLS = new Set(["sendmessage", "send_message", "sendmessagetoagent"]);

/** Input keys, most-informative first, used to summarise a tool call. */
const SUMMARY_KEYS = [
  "command",
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "pattern",
  "query",
  "url",
  "prompt",
  "description",
  "message",
  "text",
  "content",
];

const PEER_KEYS = ["recipient", "to", "to_agent", "toAgent", "agent", "target", "peer"];
const BODY_KEYS = ["message", "body", "text", "content", "prompt"];
const FROM_KEYS = ["from", "from_agent", "fromAgent", "sender", "peer", "agent"];

/** Root-level markers for "the agent finished its turn". */
const TURN_END_TYPES = new Set(["result", "turn_end", "turn_complete", "turn-end"]);
const TURN_END_SUBTYPES = new Set(["turn_end", "turn_complete", "turn-end", "end_turn"]);

const MESSAGE_PREFIX_RE =
  /^\s*\[?\s*(?:new\s+)?(?:message|msg)\s+from\s+([^\]\s:,]+)\s*\]?\s*[:\-]?\s*([\s\S]*)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty trimmed string, or null for anything else. */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + ELLIPSIS;
}

/** Epoch ms from an ISO string or a numeric epoch; null when absent/unparseable. */
function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function timestampOf(root: Record<string, unknown>): number | null {
  return parseTimestamp(root["timestamp"]) ?? parseTimestamp(root["ts"]);
}

function unknownEntry(raw: string, ts: number | null): TranscriptEntry {
  return { kind: "unknown", ts, raw };
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const found = text(source[key]);
    if (found !== null) return found;
  }
  return null;
}

/** Flatten a block's `content` (string, or array of text blocks) into plain text. */
function flattenContent(value: unknown): string | null {
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (isRecord(item)) {
        const inner = text(item["text"]);
        if (inner !== null) parts.push(inner);
      }
    }
    return text(parts.join("\n"));
  }
  if (isRecord(value)) return text(value["text"]);
  return null;
}

function summariseToolInput(input: unknown): string {
  let raw: string | null = null;
  if (typeof input === "string") {
    raw = text(input);
  } else if (isRecord(input)) {
    raw = firstString(input, SUMMARY_KEYS);
    if (raw === null) {
      try {
        const serialised = JSON.stringify(input);
        raw = typeof serialised === "string" ? text(serialised) : null;
      } catch {
        raw = null;
      }
    }
  }
  return truncate(oneLine(raw ?? ""), SUMMARY_MAX_LENGTH);
}

/** A `tool_use` block whose name is SendMessage — an outbound agent message. */
function outboundMessage(
  input: unknown,
  ts: number | null,
): Extract<TranscriptEntry, { kind: "send_message" }> | null {
  if (!isRecord(input)) return null;
  const peer = firstString(input, PEER_KEYS);
  const body = firstString(input, BODY_KEYS);
  if (peer === null && body === null) return null;
  return { kind: "send_message", ts, direction: "sent", peer: peer ?? "", body: body ?? "" };
}

/**
 * A `tool_result` block that carries an inbound message from a peer agent.
 * Two shapes are recognised: a JSON payload with from/message fields, and a
 * "[message from X] body" text envelope. Anything else is not a message and
 * degrades to unknown.
 */
function inboundMessage(
  block: Record<string, unknown>,
  ts: number | null,
): Extract<TranscriptEntry, { kind: "send_message" }> | null {
  const flat = flattenContent(block["content"]);
  if (flat === null) return null;

  if (flat.startsWith("{")) {
    try {
      const payload: unknown = JSON.parse(flat);
      if (isRecord(payload)) {
        const peer = firstString(payload, FROM_KEYS);
        const body = firstString(payload, BODY_KEYS);
        if (peer !== null && body !== null) {
          return { kind: "send_message", ts, direction: "received", peer, body };
        }
      }
    } catch {
      /* not JSON — fall through to the text envelope */
    }
  }

  const match = MESSAGE_PREFIX_RE.exec(flat);
  if (match) {
    const peer = text(match[1]);
    const body = text(match[2]);
    if (peer !== null) {
      return { kind: "send_message", ts, direction: "received", peer, body: body ?? "" };
    }
  }
  return null;
}

function classifyBlock(
  block: unknown,
  ts: number | null,
  isAssistant: boolean,
  raw: string,
): TranscriptEntry {
  if (!isRecord(block)) return unknownEntry(raw, ts);
  const blockType = text(block["type"]);

  if (blockType === "text") {
    const body = text(block["text"]);
    if (body !== null && isAssistant) return { kind: "assistant_text", ts, text: body };
    return unknownEntry(raw, ts);
  }

  if (blockType === "tool_use") {
    const tool = text(block["name"]);
    if (tool === null) return unknownEntry(raw, ts);
    if (SEND_MESSAGE_TOOLS.has(tool.toLowerCase())) {
      return outboundMessage(block["input"], ts) ?? unknownEntry(raw, ts);
    }
    return { kind: "tool_call", ts, tool, summary: summariseToolInput(block["input"]) };
  }

  if (blockType === "tool_result") {
    return inboundMessage(block, ts) ?? unknownEntry(raw, ts);
  }

  return unknownEntry(raw, ts);
}

function isTurnEnd(root: Record<string, unknown>): boolean {
  const type = text(root["type"])?.toLowerCase() ?? "";
  const subtype = text(root["subtype"])?.toLowerCase() ?? "";
  const event = text(root["event"])?.toLowerCase() ?? "";
  if (TURN_END_TYPES.has(type) || TURN_END_TYPES.has(event)) return true;
  if (type === "system" && TURN_END_SUBTYPES.has(subtype)) return true;
  return false;
}

/**
 * Classify one JSONL line into zero-or-more entries. A single assistant
 * message may hold several content blocks (text + tool_use), so this is the
 * multi-valued form; `parseEntry` collapses it to one. Never throws.
 */
export function parseEntries(line: string): TranscriptEntry[] {
  const raw = typeof line === "string" ? line : "";
  try {
    if (raw.trim().length === 0) return [unknownEntry(raw, null)];

    let root: unknown;
    try {
      root = JSON.parse(raw);
    } catch {
      return [unknownEntry(raw, null)];
    }
    if (!isRecord(root)) return [unknownEntry(raw, null)];

    const ts = timestampOf(root);
    if (isTurnEnd(root)) return [{ kind: "turn_end", ts }];

    const message = root["message"];
    if (isRecord(message)) {
      const role = text(message["role"])?.toLowerCase() ?? "";
      const rootType = text(root["type"])?.toLowerCase() ?? "";
      const isAssistant = role === "assistant" || rootType === "assistant";
      const content = message["content"];

      if (typeof content === "string") {
        const body = text(content);
        if (body !== null && isAssistant) return [{ kind: "assistant_text", ts, text: body }];
        return [unknownEntry(raw, ts)];
      }

      if (Array.isArray(content) && content.length > 0) {
        return content.map((block) => classifyBlock(block, ts, isAssistant, raw));
      }
    }

    return [unknownEntry(raw, ts)];
  } catch {
    // Belt and braces: an unforeseen shape must never take the collector down.
    return [unknownEntry(raw, null)];
  }
}

/**
 * Parse ONE JSONL line into a single entry. When a line expands to several
 * entries (a multi-block assistant message) the most recent recognised one
 * wins, because that is what the agent is doing now. Never throws — malformed
 * JSON, blank lines and unfamiliar schemas all yield kind:"unknown".
 */
export function parseEntry(line: string): TranscriptEntry {
  const entries = parseEntries(line);
  if (entries.length === 0) return unknownEntry(typeof line === "string" ? line : "", null);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind !== "unknown") return entry;
  }
  return entries[entries.length - 1];
}

/**
 * Parse a whole transcript. Blank lines are skipped; every other line yields
 * at least one entry, `unknown` when we cannot make sense of it. Never throws.
 */
export function parseTranscript(contents: string): TranscriptEntry[] {
  try {
    if (typeof contents !== "string" || contents.length === 0) return [];
    const out: TranscriptEntry[] = [];
    for (const line of contents.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      for (const entry of parseEntries(line)) out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}
