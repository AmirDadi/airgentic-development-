import type { Agent } from "../types";
import { StopButton } from "./StopButton";

const DEFAULT_STALLED_AFTER_MS = 10 * 60 * 1000;

export type AgentHealth = "healthy" | "stalled" | "dead";

/**
 * Pure health derivation. `now` and `last_seen` are epoch milliseconds.
 * A live agent with no `last_seen` at all is never treated as freshly active.
 */
export function deriveHealth(
  agent: Agent,
  now: number,
  stalledAfterMs: number = DEFAULT_STALLED_AFTER_MS,
): AgentHealth {
  if (!agent.alive) return "dead";
  if (agent.last_seen === null) return "stalled";
  return now - agent.last_seen > stalledAfterMs ? "stalled" : "healthy";
}

const HEALTH_STYLES: Record<AgentHealth, string> = {
  healthy: "bg-emerald-100 text-emerald-800 border-emerald-300",
  stalled: "bg-amber-100 text-amber-900 border-amber-400",
  dead: "bg-red-100 text-red-800 border-red-300",
};

const DOT_STYLES: Record<AgentHealth, string> = {
  healthy: "bg-emerald-500",
  stalled: "bg-amber-500",
  dead: "bg-red-500",
};

const CARD_STYLES: Record<AgentHealth, string> = {
  healthy: "border-slate-200",
  stalled: "border-amber-400 bg-amber-50",
  dead: "border-red-300 bg-red-50",
};

export function TeamBoard(props: {
  agents: Agent[];
  now: number;
  stalledAfterMs?: number;
  /** Optional: when given, each agent name becomes a button that opens its detail view. */
  onSelectAgent?: (name: string) => void;
  /** Optional: when given, each card gets a confirm-guarded Stop control. */
  onStopAgent?: (name: string) => void;
  /** Names of agents whose Stop is currently in flight. */
  stoppingAgents?: ReadonlySet<string>;
  /** A standing reason Stop is unavailable for all agents (e.g. a 503 seen once). */
  stopDisabledReason?: string;
}): JSX.Element {
  const {
    agents,
    now,
    stalledAfterMs = DEFAULT_STALLED_AFTER_MS,
    onSelectAgent,
    onStopAgent,
    stoppingAgents,
    stopDisabledReason,
  } = props;

  return (
    <section aria-label="Team board" className="w-full p-3 sm:p-4">
      <h2 className="mb-3 text-lg font-semibold text-slate-900">Team</h2>

      {agents.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          No agents registered yet.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => {
            const health = deriveHealth(agent, now, stalledAfterMs);
            const label = `${agent.name} is ${health}`;
            return (
              <li
                key={agent.name}
                className={`rounded-lg border p-3 shadow-sm ${CARD_STYLES[health]}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 break-words text-base font-semibold text-slate-900">
                    {onSelectAgent ? (
                      <button
                        type="button"
                        onClick={() => onSelectAgent(agent.name)}
                        className="break-words text-left underline decoration-slate-300 underline-offset-2 hover:decoration-slate-600"
                      >
                        {agent.name}
                      </button>
                    ) : (
                      agent.name
                    )}
                  </h3>
                  <span
                    data-testid={`agent-health-${agent.name}`}
                    role="status"
                    aria-label={label}
                    title={label}
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${HEALTH_STYLES[health]}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`h-2 w-2 rounded-full ${DOT_STYLES[health]}`}
                    />
                    {health}
                  </span>
                </div>
                <p className="mt-2 break-words text-sm text-slate-600">
                  {agent.current_activity ?? "activity unknown"}
                </p>
                <div className="mt-1 flex items-end justify-between gap-2">
                  <p className="text-xs text-slate-400">{agent.kind}</p>
                  {onStopAgent && (
                    <div className="text-right">
                      <StopButton
                        agent={agent.name}
                        alive={agent.alive}
                        onStop={onStopAgent}
                        busy={stoppingAgents?.has(agent.name) ?? false}
                        disabledReason={stopDisabledReason}
                      />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default TeamBoard;
