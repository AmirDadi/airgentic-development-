import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, createApi, type ApiClient } from "./api";
import { useLive, type EventSourceFactory } from "./useLive";
import { TeamBoard } from "./components/TeamBoard";
import { PipelineBoard } from "./components/PipelineBoard";
import { Conversations } from "./components/Conversations";
import { AgentDetail } from "./components/AgentDetail";
import { ChatDrawer, type ChatTurn } from "./components/ChatDrawer";
import type { Agent, Feature, Message, StoredEntry, Thread } from "./types";

/** Shown when the backend reports it has no web lead to talk to. */
const NO_LEAD = "No lead agent is configured — chat is unavailable.";

/** The turn id a stored chat message belongs to (its id is `<turnId>:in|out`). */
function turnIdOf(m: Message): string {
  return m.id.replace(/:(in|out)$/, "");
}

/**
 * Stored `human_web` messages are a flat oldest-first list; the drawer wants
 * prompt/reply pairs. Pairing is by TURN ID (the `<turnId>:in` / `:out` in the
 * message id), not by position: several people share one lead, so a failed
 * turn (prompt with no reply) or any interleaving would otherwise attribute one
 * person's message to another. First-seen turn order is preserved.
 */
function turnsFromHistory(messages: Message[]): ChatTurn[] {
  const byTurn = new Map<string, ChatTurn>();
  const order: string[] = [];
  for (const m of messages) {
    const id = turnIdOf(m);
    const isReply = m.id.endsWith(":out");
    let turn = byTurn.get(id);
    if (turn === undefined) {
      turn = { id, user: m.from_agent, text: "", reply: "", status: "done" };
      byTurn.set(id, turn);
      order.push(id);
    }
    if (isReply) {
      turn.reply = m.body;
    } else {
      // The prompt carries the human's name; the reply is from the lead.
      turn.user = m.from_agent;
      turn.text = m.body;
    }
  }
  return order.map((id) => byTurn.get(id)!);
}

const TABS = [
  { id: "team", label: "Team" },
  { id: "pipeline", label: "Pipeline" },
  { id: "conversations", label: "Conversations" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export interface AppProps {
  /** Injected in tests; defaults to the real HTTP client. */
  api?: ApiClient;
  /** Injected in tests; defaults to a real EventSource. */
  liveFactory?: EventSourceFactory;
  /** Injected so stalled-agent rendering is deterministic under test. */
  now?: number;
}

export default function App({ api, liveFactory, now }: AppProps = {}) {
  const client = useMemo(() => api ?? createApi(), [api]);

  const [tab, setTab] = useState<TabId>("team");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [selectedAgent, setSelectedAgent] = useState<string>();
  const [entries, setEntries] = useState<StoredEntry[]>([]);
  const [error, setError] = useState<string>();

  const [chatOpen, setChatOpen] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [chatDisabled, setChatDisabled] = useState<string>();

  // Ids for turns the backend never accepted, so they cannot collide with
  // server-issued turn ids or with each other.
  const localTurnId = useRef(0);

  // Read by the SSE handler, which must not be re-created (and re-subscribed)
  // every time the open agent changes.
  const selectedAgentRef = useRef(selectedAgent);
  selectedAgentRef.current = selectedAgent;

  // Initial snapshot over REST. The SSE channel only carries deltas, so
  // without this the board would stay empty until something changed.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [a, f, t] = await Promise.all([
          client.agents(),
          client.features(),
          client.threads() as Promise<Thread[]>,
        ]);
        if (cancelled) return;
        setAgents(a);
        setFeatures(f);
        setThreads(t);
        setError(undefined);
      } catch {
        if (!cancelled) setError("Backend unreachable — showing no data.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client]);

  // Chat history is loaded separately from the dashboard snapshot: the chat
  // bridge is optional, and its absence must leave the rest of the page intact.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const history = await client.chatHistory();
        if (!cancelled) setTurns(turnsFromHistory(history));
      } catch {
        // The drawer still opens, just empty — a missing transcript is not a
        // reason to blank the dashboard or block sending.
        if (!cancelled) setTurns([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client]);

  // Snapshot of the open agent's transcript. Live `entries` frames then keep
  // it current without a refetch.
  useEffect(() => {
    if (selectedAgent === undefined) {
      setEntries([]);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const snapshot = await client.agentEntries(selectedAgent);
        if (cancelled) return;
        // MERGE for the same reason live frames do. This request was issued
        // before it resolved, so a frame may have landed meanwhile and the
        // snapshot is already stale — replacing would make output the user
        // just watched arrive disappear again. The snapshot is the older,
        // authoritative history; anything live we hold beyond it is newer.
        setEntries((prev) => {
          const snapshotIds = new Set(snapshot.map((e) => e.id));
          const newer = prev.filter((e) => !snapshotIds.has(e.id));
          return [...snapshot, ...newer];
        });
      } catch {
        if (!cancelled) setEntries([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, selectedAgent]);

  const onEvent = useCallback((type: string, data: unknown) => {
    if (type === "agents") setAgents(data as Agent[]);
    else if (type === "features") setFeatures(data as Feature[]);
    else if (type === "messages") setThreads(data as Thread[]);
    else if (type === "chat") {
      const frame = data as {
        turnId?: string;
        kind?: string;
        text?: string;
        message?: string;
      };
      if (typeof frame.turnId !== "string") return;
      const id = frame.turnId;

      setTurns((prev) => {
        // A frame for a turn we do not know about (another browser's turn, or
        // one from before this page loaded) is ignored, never crashes.
        if (!prev.some((t) => t.id === id)) return prev;

        return prev.map((t) => {
          if (t.id !== id) return t;
          switch (frame.kind) {
            case "delta":
              // APPEND: deltas are fragments and arrive in order.
              return { ...t, reply: t.reply + (frame.text ?? ""), status: "streaming" };
            case "final":
              // The final frame is the whole reply, so it replaces the
              // accumulated fragments rather than extending them.
              return { ...t, reply: frame.text ?? t.reply, status: "done" };
            case "error":
              return {
                ...t,
                status: "error",
                error: frame.message ?? "The lead could not answer.",
              };
            default:
              // An unrecognised kind is dropped, not applied.
              return t;
          }
        });
      });
    } else if (type === "entries") {
      const frame = data as { agent?: string; entries?: StoredEntry[] };
      // Only the open agent's stream is applied; other agents' frames are noise
      // for this view.
      if (frame.agent === selectedAgentRef.current && Array.isArray(frame.entries)) {
        const incoming = frame.entries;
        setEntries((prev) => {
          // MERGE, never replace. The server caps each frame at its newest N
          // entries while the initial REST snapshot returns everything it
          // retains, so replacing would make history the user is currently
          // reading disappear the moment the agent says anything.
          //
          // The frame is the newest contiguous run, so anything of ours not in
          // it is strictly older: keep those in place and append the frame,
          // preserving the server's ordering within it.
          const incomingIds = new Set(incoming.map((e) => e.id));
          const older = prev.filter((e) => !incomingIds.has(e.id));
          return [...older, ...incoming];
        });
      }
    }
  }, []);

  const { connected } = useLive({ onEvent, factory: liveFactory });

  const onSendChat = useCallback(
    (text: string) => {
      void (async () => {
        try {
          const { turnId } = await client.sendChat(text);
          // The turn appears only once the backend has accepted it, so its id
          // is the real one and later `chat` frames can find it.
          setTurns((prev) => [
            ...prev,
            { id: turnId, user: "You", text, reply: "", status: "streaming" },
          ]);
        } catch (e) {
          // 503 is "no lead configured" — a standing condition, so the
          // composer closes rather than letting the next message vanish too.
          if (e instanceof ApiError && e.status === 503) {
            setChatDisabled(NO_LEAD);
            return;
          }
          setTurns((prev) => [
            ...prev,
            {
              id: `local-${(localTurnId.current += 1)}`,
              user: "You",
              text,
              reply: "",
              status: "error",
              error: "Could not reach the chat bridge.",
            },
          ]);
        }
      })();
    },
    [client],
  );

  const selected = selectedThreadId ?? threads[0]?.id;
  const openAgent = agents.find((a) => a.name === selectedAgent);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-lg font-semibold">Agent Team Dashboard</h1>
          <span
            className="text-xs text-slate-500"
            role="status"
            aria-label={connected ? "live updates connected" : "live updates disconnected"}
          >
            {connected ? "● live" : "○ offline"}
          </span>
        </div>

        <div role="tablist" aria-label="Views" className="mt-3 flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`rounded px-3 py-1.5 text-sm ${
                tab === t.id
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <p role="alert" className="m-4 rounded bg-amber-100 px-3 py-2 text-sm text-amber-900">
          {error}
        </p>
      )}

      <main className="p-4">
        {tab === "team" &&
          (openAgent ? (
            <AgentDetail
              agent={openAgent}
              entries={entries}
              onBack={() => setSelectedAgent(undefined)}
            />
          ) : (
            <TeamBoard
              agents={agents}
              now={now ?? Date.now()}
              onSelectAgent={setSelectedAgent}
            />
          ))}
        {tab === "pipeline" && <PipelineBoard features={features} />}
        {tab === "conversations" && (
          <Conversations
            threads={threads}
            selectedThreadId={selected}
            onSelectThread={setSelectedThreadId}
          />
        )}
      </main>

      {/* Outside the tab switch and the detail branch: PRD §3 requires the
          drawer from every view. */}
      <ChatDrawer
        open={chatOpen}
        turns={turns}
        onSend={onSendChat}
        onToggle={() => setChatOpen((o) => !o)}
        disabled={chatDisabled !== undefined}
        disabledReason={chatDisabled}
      />
    </div>
  );
}
