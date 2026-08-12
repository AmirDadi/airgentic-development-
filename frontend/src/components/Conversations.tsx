import type { Message, MessageChannel, Thread } from "../types";

export const CHANNEL_LABELS: Record<MessageChannel, string> = {
  inter_agent: "Agent to agent",
  human_web: "Human via web",
};

const CHANNEL_STYLES: Record<MessageChannel, string> = {
  inter_agent: "bg-slate-100 text-slate-700 border-slate-300",
  human_web: "bg-sky-100 text-sky-800 border-sky-300",
};

const BUBBLE_STYLES: Record<MessageChannel, string> = {
  inter_agent: "border-slate-200 bg-white",
  human_web: "border-sky-200 bg-sky-50",
};

function MessageBubble({ message }: { message: Message }): JSX.Element {
  const channelLabel = `${CHANNEL_LABELS[message.channel]} message`;
  return (
    <li
      className={`rounded-lg border p-3 shadow-sm ${BUBBLE_STYLES[message.channel]}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="min-w-0 break-words text-sm font-semibold text-slate-900">
          {message.from_agent}
        </h4>
        <span
          data-testid={`message-channel-${message.id}`}
          aria-label={channelLabel}
          title={channelLabel}
          className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${CHANNEL_STYLES[message.channel]}`}
        >
          {CHANNEL_LABELS[message.channel]}
        </span>
      </div>
      {/* Plain text only — React escapes this; never dangerouslySetInnerHTML. */}
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-700">
        {message.body}
      </p>
      <p className="mt-1 text-xs text-slate-400">to {message.to_agent}</p>
    </li>
  );
}

export function Conversations(props: {
  threads: Thread[];
  selectedThreadId?: string;
  onSelectThread?: (id: string) => void;
}): JSX.Element {
  const { threads, selectedThreadId, onSelectThread } = props;

  // Order is the backend's; never re-sorted here.
  const selected = threads.find((t) => t.id === selectedThreadId);

  return (
    <section aria-label="Conversations" className="w-full p-3 sm:p-4">
      <h2 className="mb-3 text-lg font-semibold text-slate-900">Conversations</h2>

      {/* 390px: the two panes stack vertically; from md up they sit side by side. */}
      <div className="flex flex-col gap-3 md:flex-row md:gap-4">
        <div className="w-full shrink-0 md:w-72">
          {threads.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
              No conversations yet.
            </p>
          ) : (
            <ul
              aria-label="Conversations list"
              className="flex flex-col gap-2"
            >
              {threads.map((thread) => {
                const isSelected = thread.id === selectedThreadId;
                const [a, b] = thread.participants;
                return (
                  <li key={thread.id}>
                    <button
                      type="button"
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => onSelectThread?.(thread.id)}
                      className={`w-full rounded-lg border p-3 text-left shadow-sm ${
                        isSelected
                          ? "border-blue-500 bg-blue-50"
                          : "border-slate-200 bg-white"
                      }`}
                    >
                      <span className="block break-words text-sm font-semibold text-slate-900">
                        {a} ↔ {b}
                      </span>
                      <span className="mt-1 block break-words text-xs text-slate-500">
                        {thread.last_body || "no preview available"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {selected === undefined ? (
            <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
              Select a conversation to read it.
            </p>
          ) : selected.messages.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
              No messages in this conversation yet.
            </p>
          ) : (
            <ul
              aria-label={`Messages between ${selected.participants[0]} and ${selected.participants[1]}`}
              className="flex flex-col gap-3"
            >
              {selected.messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

export default Conversations;
