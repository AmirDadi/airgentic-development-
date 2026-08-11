/**
 * Pure tmux helpers: build the read-only command, parse its output.
 *
 * This module performs NO I/O. It never imports `child_process` — the
 * executor is injected by the collector that uses these functions. That is
 * what makes liveness testable without a live agent team (PRD: pure core,
 * thin shell).
 */

/** One window in a tmux session. A window == an agent, by convention. */
export interface TmuxWindow {
  /** Window index, e.g. 3 */
  index: number;
  /** Window name — this is the agent name, e.g. "payments" */
  name: string;
  /** Whether the window is currently active. */
  active: boolean;
  /** Panes' current command if available, e.g. "node"; null when absent. */
  command: string | null;
}

/**
 * The output shape is OURS, not tmux's human-readable default: an explicit
 * tab-delimited format keeps parsing stable across tmux versions.
 */
export const TMUX_WINDOW_FORMAT =
  "#{window_index}\t#{window_name}\t#{window_active}\t#{pane_current_command}";

/**
 * Builds the read-only tmux command we shell out to.
 *
 * Returns an argv array (never a shell string) so the session name is passed
 * as a single argument and cannot be interpreted by a shell.
 */
export function buildListWindowsCommand(session: string): string[] {
  return ["tmux", "list-windows", "-t", session, "-F", TMUX_WINDOW_FORMAT];
}

/**
 * Tolerantly parses `tmux list-windows` stdout produced with
 * {@link TMUX_WINDOW_FORMAT}.
 *
 * Never throws. Unparseable lines are skipped so a single odd line cannot
 * take down liveness reporting; empty/absent output yields `[]`.
 */
export function parseTmuxWindows(stdout: string): TmuxWindow[] {
  if (typeof stdout !== "string" || stdout.trim() === "") return [];

  const windows: TmuxWindow[] = [];

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;

    const fields = line.split("\t");
    // A usable record needs at least an index and a name.
    if (fields.length < 2) continue;

    const indexText = (fields[0] ?? "").trim();
    if (!/^\d+$/.test(indexText)) continue;
    const index = Number.parseInt(indexText, 10);
    if (!Number.isSafeInteger(index)) continue;

    const name = (fields[1] ?? "").trim();
    if (name === "") continue;

    const activeText = (fields[2] ?? "").trim();
    const active = activeText === "1";

    const commandText = (fields[3] ?? "").trim();
    const command = commandText === "" ? null : commandText;

    windows.push({ index, name, active, command });
  }

  return windows;
}
