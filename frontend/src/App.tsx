import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createApi, type ApiClient } from "./api";
import { useLive, type EventSourceFactory } from "./useLive";
import { TeamBoard } from "./components/TeamBoard";
import { PipelineBoard } from "./components/PipelineBoard";
import { Conversations } from "./components/Conversations";
import { AgentDetail } from "./components/AgentDetail";
import type { Agent, Feature, StoredEntry, Thread } from "./types";

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
        const e = await client.agentEntries(selectedAgent);
        if (!cancelled) setEntries(e);
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
    else if (type === "entries") {
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
    </div>
  );
}
