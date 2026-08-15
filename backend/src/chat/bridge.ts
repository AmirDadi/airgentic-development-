import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseStreamLine } from "./stream-parser.js";

/**
 * Runs ONE turn of the web-lead agent and streams its reply.
 *
 * Everything verified in SPIKE-R2 is encoded here:
 *   - the command is `claude -p [--continue] --output-format stream-json
 *     --include-partial-messages --verbose <prompt>`;
 *   - it runs in the bridge's OWN directory, because `--continue` scope is
 *     per-directory and that is what keeps context (and usage) small;
 *   - the first turn in a fresh directory MUST omit `--continue` — there is
 *     nothing to continue and the CLI errors;
 *   - the three `CLAUDE_CODE_*` session variables are REMOVED from the child's
 *     environment, or it attaches to the calling session instead of binding
 *     its own inbox socket.
 *
 * The prompt is user input that becomes a process argument, so it is passed as
 * a single argv element to a spawn with no shell. There is no code path here
 * that builds a command string, which is what makes shell injection
 * impossible rather than merely escaped.
 *
 * Lifecycle is ours (P4 design): every turn is a fresh process resuming stored
 * history, so a crashed turn is the normal path, not a special case. Every
 * failure — non-zero exit, `is_error`, a stream that ends with no result, a
 * hang — resolves to `{ok: false, error}`. `runTurn` never rejects and never
 * hangs.
 */

/** A running turn, as the bridge needs to see it. */
export interface SpawnedTurn {
  /** stdout as decoded text chunks; chunk boundaries need not align to lines. */
  stdout: AsyncIterable<string>;
  exitCode: Promise<number>;
  kill(): void;
}

export type TurnSpawner = (
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => SpawnedTurn;

export interface BridgeOptions {
  /** The bridge's own working directory — the `--continue` scope. */
  cwd: string;
  /** Injected in tests so no real process is ever spawned. */
  spawner?: TurnSpawner;
  /** Wall-clock budget for one turn. Default 2 minutes. */
  timeoutMs?: number;
  /** Overrides the internal "have we established continuity yet" flag. */
  isFirstTurn?: () => boolean;
}

export interface TurnResult {
  ok: boolean;
  /** The agent's reply. Empty when the turn failed. */
  text: string;
  error?: string;
  /** List-price valuation of the turn's usage, or null when unknown. */
  usage: number | null;
}

export interface Bridge {
  runTurn(prompt: string, onDelta: (text: string) => void): Promise<TurnResult>;
}

export const DEFAULT_TURN_TIMEOUT_MS = 120_000;

/** The command. `claude` is resolved from PATH by the OS, never by a shell. */
const CLAUDE_BIN = "claude";

/**
 * Session variables that must NOT be inherited. With any of these set the
 * child attaches to the calling session instead of starting an independent
 * one — the exact confound that made the first R2 probe look like a failure.
 */
const STRIPPED_ENV_VARS = [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
] as const;

/** A copy of the parent env with the session variables deleted, not blanked. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STRIPPED_ENV_VARS) {
    // Deleted rather than set to "": an empty string still reads as "set".
    delete env[key];
  }
  return env;
}

function buildArgv(prompt: string, includeContinue: boolean): string[] {
  return [
    CLAUDE_BIN,
    "-p",
    ...(includeContinue ? ["--continue"] : []),
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    // LAST and single: the prompt is data, never flags and never a command
    // line. Anything it contains — `$(…)`, backticks, `;`, newlines — is one
    // literal argv element.
    prompt,
  ];
}

/** The production spawner: a real child process, `shell` off by construction. */
export const nodeSpawner: TurnSpawner = (argv, opts) => {
  const [command, ...args] = argv;
  const child = spawn(command as string, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    // Explicit, though it is also the default: with `shell: true` every
    // metacharacter in the prompt would become executable.
    shell: false,
  });

  child.stdout.setEncoding("utf8");

  const exitCode = new Promise<number>((resolve) => {
    child.once("close", (code) => resolve(code ?? 1));
    // A spawn failure (no `claude` on PATH) emits 'error' and sometimes no
    // 'close' at all; it must still settle.
    child.once("error", () => resolve(1));
  });

  return {
    stdout: child.stdout as AsyncIterable<string>,
    exitCode,
    kill: () => {
      // SIGTERM first, but a `claude` that traps or ignores it would otherwise
      // live forever — and a live session holds its inbox socket (SPIKE-R2),
      // so an abandoned turn leaks both a process and an address. Escalate to
      // SIGKILL if it has not exited within the grace period.
      child.kill("SIGTERM");
      const grace = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, SIGKILL_GRACE_MS);
      grace.unref?.();
      // Don't hold the timer past a clean exit.
      child.once("close", () => clearTimeout(grace));
    },
  };
};

/** How long a killed turn may ignore SIGTERM before we SIGKILL it. */
export const SIGKILL_GRACE_MS = 2_000;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createBridge(opts: BridgeOptions): Bridge {
  const spawner = opts.spawner ?? nodeSpawner;
  const timeoutMs =
    opts.timeoutMs !== undefined && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_TURN_TIMEOUT_MS;

  // Continuity is only claimed once a turn has actually produced a result: if
  // the very first turn dies on launch, nothing was written to the session
  // directory and `--continue` would fail every subsequent turn too.
  //
  // It is tracked on DISK, not just in memory: the `--continue` history lives
  // in the (non-ephemeral) working directory and survives a server restart, so
  // an in-memory flag would make the first turn after any restart wrongly omit
  // `--continue` and silently lose the whole conversation. The marker file ties
  // "have we ever completed a turn here" to the same directory that holds the
  // history it gates.
  const markerPath = join(opts.cwd, ".web-lead-established");
  let established = false; // within this process
  const isFirstTurn =
    opts.isFirstTurn ??
    ((): boolean => !established && !existsSync(markerPath));

  async function runTurn(
    prompt: string,
    onDelta: (text: string) => void,
  ): Promise<TurnResult> {
    const argv = buildArgv(prompt, !isFirstTurn());

    let turn: SpawnedTurn;
    try {
      turn = spawner(argv, { cwd: opts.cwd, env: childEnv() });
    } catch (err) {
      return { ok: false, text: "", error: describe(err), usage: null };
    }

    let finalText: string | null = null;
    let usage: number | null = null;
    let streamError: string | null = null;

    const consume = async (): Promise<void> => {
      let buffer = "";
      const handle = (line: string): void => {
        const event = parseStreamLine(line);
        switch (event.kind) {
          case "delta":
            try {
              onDelta(event.text);
            } catch {
              // A broken subscriber cannot fail the turn (same rule as the
              // SSE hub's fan-out).
            }
            return;
          case "final":
            finalText = event.text;
            usage = event.usage;
            return;
          case "error":
            streamError = event.message;
            return;
          default:
            return;
        }
      };

      for await (const chunk of turn.stdout) {
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          handle(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
        }
      }
      // A last line with no trailing newline is still a line.
      if (buffer.length > 0) handle(buffer);
    };

    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve("timeout");
      }, timeoutMs);
      timer.unref?.();
    });

    try {
      const outcome = await Promise.race([
        (async (): Promise<"done"> => {
          try {
            await consume();
          } catch (err) {
            streamError ??= describe(err);
          }
          // Waiting for the exit code too: a non-zero exit after clean-looking
          // output still means the turn failed.
          const code = await turn.exitCode;
          if (code !== 0 && streamError === null) {
            streamError = `claude exited with code ${code}`;
          }
          return "done";
        })(),
        deadline,
      ]);

      if (outcome === "timeout" || timedOut) {
        // The process owns a session socket for as long as it lives, so a hung
        // turn must be killed rather than abandoned.
        try {
          turn.kill();
        } catch {
          // Already gone; nothing to clean up.
        }
        return {
          ok: false,
          text: "",
          error: `turn timed out after ${timeoutMs}ms`,
          usage: null,
        };
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (streamError !== null) {
      return { ok: false, text: "", error: streamError, usage: null };
    }
    if (finalText === null) {
      return {
        ok: false,
        text: "",
        error: "agent produced no result line",
        usage: null,
      };
    }

    established = true;
    // Persist the marker so a restart still knows this directory has history.
    // Best-effort: a write failure must not fail a turn that already succeeded
    // (worst case, the next turn after a restart omits --continue once).
    try {
      writeFileSync(markerPath, "");
    } catch {
      /* ignore */
    }
    return { ok: true, text: finalText, usage };
  }

  return { runTurn };
}
