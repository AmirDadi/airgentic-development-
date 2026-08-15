import { useId, useState } from "react";

/**
 * Pure and props-driven: no fetching, no effects, no clock. The interrupt it
 * guards is hard to reverse (PRD R5), so the confirmation IS the safety
 * mechanism — a single click never fires `onStop`; it opens a dialog that
 * names the target agent and demands an explicit Confirm.
 *
 * The agent name is rendered as a React child, so React escapes it. Nothing
 * here uses dangerouslySetInnerHTML — a name is untrusted and must never be
 * treated as markup.
 */
export function StopButton(props: {
  agent: string;
  alive: boolean;
  /** Called only after the user confirms, exactly once, with the agent name. */
  onStop: (agent: string) => void;
  /** A stop is in flight for this agent. */
  busy?: boolean;
  /** e.g. "Stop is not configured on this server." (a 503 seen once). */
  disabledReason?: string;
}): JSX.Element {
  const { agent, alive, onStop, busy = false, disabledReason } = props;
  const [confirming, setConfirming] = useState(false);
  const titleId = useId();

  // A dead agent has nothing to interrupt; a standing 503 disables every stop.
  // Either way the reason is shown in words, never left implicit.
  const reason =
    disabledReason ?? (!alive ? "agent is not running — nothing to interrupt" : undefined);
  const disabled = reason !== undefined;

  // While a stop is running there is no trigger at all, so it cannot be
  // double-fired; the in-flight state is announced via role="status".
  if (busy) {
    return (
      <span
        role="status"
        aria-label={`Stopping ${agent}…`}
        title={`Stopping ${agent}…`}
        className="inline-flex items-center gap-1 rounded-full border border-red-300 bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800"
      >
        <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
        stopping…
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-label={reason ? `Stop ${agent} — ${reason}` : `Stop ${agent}`}
        title={reason ? `Stop ${agent} — ${reason}` : `Stop ${agent}`}
        onClick={() => setConfirming(true)}
        className="shrink-0 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
      >
        Stop
      </button>

      {disabled && reason !== undefined && (
        <p className="mt-1 text-[11px] text-slate-500">{reason}</p>
      )}

      {confirming && (
        // Named by its heading so a screen-reader user hears which agent they
        // are about to interrupt before they reach the Confirm button.
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-3"
        >
          <div className="w-[min(24rem,calc(100vw-1.5rem))] rounded-lg border border-slate-300 bg-white p-4 shadow-xl">
            <h2 id={titleId} className="break-words text-sm font-semibold text-slate-900">
              Stop {agent}?
            </h2>
            <p className="mt-1 break-words text-sm text-slate-600">
              This interrupts {agent}&rsquo;s current turn. It cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded border border-slate-300 bg-white px-3 py-1 text-sm text-slate-700 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  onStop(agent);
                  setConfirming(false);
                }}
                className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700"
              >
                Confirm stop
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default StopButton;
