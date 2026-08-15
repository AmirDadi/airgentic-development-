import { useState } from "react";

/**
 * Pure and props-driven: no fetching, no effects, no clock. Everything it
 * shows is handed to it, which is what makes streaming testable without a
 * network.
 *
 * Every string below is rendered as a React child, so React escapes it.
 * Nothing here may use dangerouslySetInnerHTML — a reply is agent output and
 * must never be trusted as markup. Bodies arrive already redacted, so markers
 * like `[REDACTED:github-token]` render verbatim rather than being hidden.
 */

export interface ChatTurn {
  id: string;
  user: string;
  text: string;
  reply: string;
  status: "streaming" | "done" | "error";
  error?: string;
}

/** Long unbroken tokens (paths, hashes, base64) must not widen the 390px page. */
const TEXT = "whitespace-pre-wrap break-words text-sm";

function Turn({ turn }: { turn: ChatTurn }): JSX.Element {
  const hasReply = turn.reply.length > 0;

  return (
    <li
      data-testid={`chat-turn-${turn.id}`}
      data-status={turn.status}
      className="min-w-0 rounded-lg border border-slate-200 bg-white p-2 shadow-sm"
    >
      {/* Several people share one lead, so every turn names its sender. */}
      <p className="break-words text-xs font-semibold text-sky-800">{turn.user}</p>
      <p className={`${TEXT} mt-0.5 text-slate-800`}>{turn.text}</p>

      {hasReply && (
        <p className={`${TEXT} mt-2 border-t border-slate-100 pt-2 text-slate-700`}>
          {turn.reply}
        </p>
      )}

      {turn.status === "streaming" && (
        <span
          role="status"
          aria-label="reply in progress"
          title="reply in progress"
          className="mt-2 inline-flex items-center gap-1 rounded-full border border-blue-300 bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800"
        >
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-blue-500" />
          replying
        </span>
      )}

      {turn.status === "error" && (
        <p
          role="alert"
          className={`${TEXT} mt-2 rounded border border-red-300 bg-red-50 px-2 py-1 text-red-800`}
        >
          {turn.error ?? "The lead could not answer."}
        </p>
      )}
    </li>
  );
}

export function ChatDrawer(props: {
  open: boolean;
  turns: ChatTurn[];
  onSend: (text: string) => void;
  onToggle: () => void;
  /** No lead configured (the backend answered 503). */
  disabled?: boolean;
  disabledReason?: string;
}): JSX.Element {
  const { open, turns, onSend, onToggle, disabled = false, disabledReason } = props;

  const [draft, setDraft] = useState("");

  function submit(e: React.FormEvent) {
    // A real form submit, so Enter in the input works and not only the button.
    e.preventDefault();
    if (disabled) return;
    const text = draft.trim();
    // Whitespace is not a message; sending it would burn a lead turn.
    if (text === "") return;
    onSend(text);
    setDraft("");
  }

  return (
    // Fixed to the corner so it is reachable from every view, and capped at the
    // viewport width minus a gutter so at 390px it never covers the whole page.
    <div className="fixed bottom-0 right-0 z-30 flex max-w-[calc(100vw-1rem)] flex-col items-end p-2 sm:p-4">
      {open && (
        <section
          id="chat-drawer-panel"
          aria-label="Chat with the lead"
          className="mb-2 flex h-[60vh] w-[min(22rem,calc(100vw-1.5rem))] flex-col rounded-lg border border-slate-300 bg-white shadow-lg sm:h-[28rem]"
        >
          <h2 className="border-b border-slate-200 px-3 py-2 text-sm font-semibold text-slate-900">
            Chat with the lead
          </h2>

          {/* role="log" so a reply arriving mid-stream is announced. */}
          <ol
            role="log"
            aria-label="Chat transcript"
            aria-live="polite"
            className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2"
          >
            {turns.length === 0 ? (
              <li className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
                No messages yet. Ask the lead something.
              </li>
            ) : (
              turns.map((t) => <Turn key={t.id} turn={t} />)
            )}
          </ol>

          {disabled && disabledReason !== undefined && (
            <p className="mx-2 mb-2 rounded bg-amber-100 px-2 py-1 text-xs text-amber-900">
              {disabledReason}
            </p>
          )}

          <form
            onSubmit={submit}
            className="flex items-center gap-2 border-t border-slate-200 p-2"
          >
            <label htmlFor="chat-draft" className="sr-only">
              Message to the lead
            </label>
            <input
              id="chat-draft"
              type="text"
              value={draft}
              disabled={disabled}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Message the lead…"
              className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-100 disabled:text-slate-400"
            />
            <button
              type="submit"
              disabled={disabled}
              className="shrink-0 rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:bg-slate-300"
            >
              Send
            </button>
          </form>
        </section>
      )}

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="chat-drawer-panel"
        className="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-lg hover:bg-slate-700"
      >
        Chat
      </button>
    </div>
  );
}

export default ChatDrawer;
