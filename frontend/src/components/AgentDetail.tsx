import type { Agent, StoredEntry, TranscriptEntry } from "../types";

/**
 * Every string below is rendered as a React child — React escapes it. Nothing
 * in this file may use dangerouslySetInnerHTML: transcript bodies are agent
 * output and must never be trusted as markup. Bodies also arrive already
 * redacted by the backend, so markers like `[REDACTED:github-token]` are
 * rendered verbatim rather than hidden or restored.
 */

/** Long unbroken tokens (paths, hashes, base64) must not widen the 390px page. */
const TEXT = "whitespace-pre-wrap break-words text-sm";

const CHIP = "inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide";

const CHIP_STYLES: Record<string, string> = {
  assistant_text: "border-slate-300 bg-slate-100 text-slate-700",
  user_text: "border-sky-300 bg-sky-100 text-sky-800",
  thinking: "border-slate-200 bg-slate-50 text-slate-400",
  tool_call: "border-violet-300 bg-violet-100 text-violet-800",
  tool_result: "border-slate-300 bg-slate-100 text-slate-700",
  send_message: "border-indigo-300 bg-indigo-100 text-indigo-800",
  system_event: "border-slate-200 bg-slate-50 text-slate-500",
  turn_end: "border-slate-300 bg-white text-slate-500",
  unknown: "border-amber-400 bg-amber-100 text-amber-900",
};

const ROW_STYLES: Record<string, string> = {
  assistant_text: "border-slate-200 bg-white",
  user_text: "border-sky-200 bg-sky-50",
  thinking: "border-slate-100 bg-slate-50",
  tool_call: "border-violet-200 bg-violet-50",
  tool_result: "border-slate-200 bg-white",
  send_message: "border-indigo-200 bg-indigo-50",
  system_event: "border-slate-100 bg-slate-50",
  turn_end: "border-dashed border-slate-300 bg-transparent",
  unknown: "border-amber-300 bg-amber-50",
};

const CHIP_LABELS: Record<TranscriptEntry["kind"], string> = {
  assistant_text: "assistant",
  user_text: "user",
  thinking: "thinking",
  tool_call: "tool call",
  tool_result: "tool result",
  send_message: "message",
  system_event: "system",
  turn_end: "boundary",
  unknown: "unknown",
};

function Chip({ kind }: { kind: TranscriptEntry["kind"] }): JSX.Element {
  return <span className={`${CHIP} ${CHIP_STYLES[kind]}`}>{CHIP_LABELS[kind]}</span>;
}

function Stamp({ ts }: { ts: number | null }): JSX.Element | null {
  if (ts === null) return null;
  // Formatting a supplied timestamp only — this component never reads a clock.
  return (
    <time className="shrink-0 font-mono text-[11px] text-slate-400">
      {new Date(ts).toISOString().slice(11, 19)}
    </time>
  );
}

/** The body of one entry — the part that differs per kind. */
function EntryBody({ entry }: { entry: TranscriptEntry }): JSX.Element {
  switch (entry.kind) {
    case "assistant_text":
      return <p className={`${TEXT} text-slate-800`}>{entry.text}</p>;

    case "user_text":
      return <p className={`${TEXT} text-sky-900`}>{entry.text}</p>;

    case "thinking":
      // De-emphasised, but never aria-hidden: it stays readable and reachable.
      return <p className={`${TEXT} italic text-slate-400`}>{entry.text}</p>;

    case "tool_call":
      return (
        <div className="min-w-0">
          <span className="break-all font-mono text-sm font-semibold text-violet-900">
            {entry.tool}
          </span>
          <p className={`${TEXT} mt-0.5 break-all font-mono text-slate-600`}>
            {entry.summary}
          </p>
        </div>
      );

    case "tool_result": {
      // Outcome is carried by an aria-label and by words, not colour alone.
      const label = entry.ok ? "tool result: succeeded" : "tool result: failed";
      return (
        <div className="min-w-0">
          <span
            role="status"
            aria-label={label}
            title={label}
            className={`${CHIP} ${
              entry.ok
                ? "border-emerald-300 bg-emerald-100 text-emerald-800"
                : "border-red-300 bg-red-100 text-red-800"
            }`}
          >
            {entry.ok ? "ok" : "failed"}
          </span>
          <p className={`${TEXT} mt-0.5 break-all font-mono text-slate-600`}>
            {entry.summary}
          </p>
        </div>
      );
    }

    case "send_message":
      return (
        <div className="min-w-0">
          <span className="text-xs text-indigo-800">
            {entry.direction === "sent" ? "sent to" : "received from"}
          </span>{" "}
          <span className="break-words text-xs font-semibold text-indigo-900">
            {entry.peer}
          </span>
          <p className={`${TEXT} mt-0.5 text-slate-800`}>{entry.body}</p>
        </div>
      );

    case "system_event":
      return (
        <div className="min-w-0">
          <span className="break-words text-xs font-semibold text-slate-500">
            {entry.event}
          </span>
          <p className={`${TEXT} mt-0.5 text-xs text-slate-500`}>{entry.detail}</p>
        </div>
      );

    case "turn_end":
      return (
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          turn ended
        </span>
      );

    case "unknown":
      return (
        <div className="min-w-0">
          <span className="text-xs font-semibold text-amber-900">
            unrecognised entry
          </span>
          <p className={`${TEXT} mt-0.5 break-all font-mono text-amber-800`}>
            {entry.raw}
          </p>
        </div>
      );
  }
}

export function AgentDetail(props: {
  agent: Agent;
  entries: StoredEntry[];
  onBack?: () => void;
}): JSX.Element {
  const { agent, entries, onBack } = props;

  // Mid-turn iff the stream has entries and the newest is not a turn boundary.
  // Order is the backend's (oldest first); never re-sorted here.
  const last = entries[entries.length - 1];
  const working = last !== undefined && last.entry.kind !== "turn_end";
  const statusLabel = `${agent.name} is ${working ? "working" : "idle"}`;

  return (
    <section
      aria-label={`Agent detail for ${agent.name}`}
      className="w-full p-3 sm:p-4"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onBack?.()}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 hover:bg-slate-100"
        >
          ← Back to team
        </button>
        <h2 className="min-w-0 break-words text-lg font-semibold text-slate-900">
          {agent.name}
        </h2>
        <span
          data-testid={`agent-turn-state-${agent.name}`}
          role="status"
          aria-label={statusLabel}
          title={statusLabel}
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
            working
              ? "border-blue-300 bg-blue-100 text-blue-800"
              : "border-slate-300 bg-slate-100 text-slate-600"
          }`}
        >
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${working ? "bg-blue-500" : "bg-slate-400"}`}
          />
          {working ? "working" : "idle"}
        </span>
      </div>

      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          {`No output recorded for ${agent.name} yet.`}
        </p>
      ) : (
        <ol
          aria-label={`Transcript for ${agent.name}`}
          className="flex flex-col gap-2"
        >
          {entries.map((stored) => (
            <li
              key={stored.id}
              data-kind={stored.entry.kind}
              data-testid={`entry-${stored.id}`}
              className={`flex min-w-0 items-start gap-2 rounded-lg border p-2 ${
                ROW_STYLES[stored.entry.kind] ?? "border-slate-200 bg-white"
              }`}
            >
              <Chip kind={stored.entry.kind} />
              <div className="min-w-0 flex-1">
                <EntryBody entry={stored.entry} />
              </div>
              <Stamp ts={stored.entry.ts} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default AgentDetail;
