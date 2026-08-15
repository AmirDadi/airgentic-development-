import { describe, it, expect, vi } from "vitest";
import {
  createBridge,
  type SpawnedTurn,
  type TurnSpawner,
} from "../../src/chat/bridge.js";

/** One recorded call into the spawner. */
interface Call {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const delta = (text: string): string =>
  JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });

const result = (text: string, cost = 0.01): string =>
  JSON.stringify({
    type: "result",
    is_error: false,
    result: text,
    total_cost_usd: cost,
    session_id: "s1",
  });

/** An async iterable over the given chunks, yielding one per microtask tick. */
function chunks(parts: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of parts) {
        await Promise.resolve();
        yield p;
      }
    },
  };
}

/** Never yields and never ends — models a hung child. */
function hangingStdout(): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<string>>(() => {}),
    }),
  };
}

function fakeSpawner(
  make: (call: Call) => Partial<SpawnedTurn>,
): { spawner: TurnSpawner; calls: Call[]; kills: number[] } {
  const calls: Call[] = [];
  const kills: number[] = [];
  const spawner: TurnSpawner = (argv, opts) => {
    const call: Call = { argv, cwd: opts.cwd, env: opts.env };
    calls.push(call);
    const made = make(call);
    const index = calls.length - 1;
    return {
      stdout: made.stdout ?? chunks([]),
      exitCode: made.exitCode ?? Promise.resolve(0),
      kill:
        made.kill ??
        ((): void => {
          kills.push(index);
        }),
    };
  };
  return { spawner, calls, kills };
}

/** The happy path: a couple of deltas then a result line. */
function okSpawner(text = "hello world"): ReturnType<typeof fakeSpawner> {
  return fakeSpawner(() => ({
    stdout: chunks([`${delta("hello ")}\n`, `${delta("world")}\n`, `${result(text)}\n`]),
  }));
}

describe("createBridge — streaming", () => {
  it("delivers deltas in order and returns the final result text", async () => {
    const { spawner } = okSpawner("hello world");
    const bridge = createBridge({ cwd: "/w/web-lead", spawner });

    const seen: string[] = [];
    const res = await bridge.runTurn("hi", (t) => seen.push(t));

    expect(seen).toEqual(["hello ", "world"]);
    expect(res).toEqual({ ok: true, text: "hello world", usage: 0.01 });
  });

  it("parses lines split across chunk boundaries", async () => {
    const whole = `${delta("split")}\n${result("done")}\n`;
    const cut = Math.floor(whole.length / 3);
    const { spawner } = fakeSpawner(() => ({
      stdout: chunks([whole.slice(0, cut), whole.slice(cut, cut + 5), whole.slice(cut + 5)]),
    }));
    const bridge = createBridge({ cwd: "/w", spawner });

    const seen: string[] = [];
    const res = await bridge.runTurn("hi", (t) => seen.push(t));

    expect(seen).toEqual(["split"]);
    expect(res.ok).toBe(true);
    expect(res.text).toBe("done");
  });

  it("parses a final line that arrives without a trailing newline", async () => {
    const { spawner } = fakeSpawner(() => ({
      stdout: chunks([`${delta("a")}\n`, result("no trailing newline")]),
    }));
    const res = await createBridge({ cwd: "/w", spawner }).runTurn("hi", () => {});
    expect(res).toEqual({ ok: true, text: "no trailing newline", usage: 0.01 });
  });

  it("ignores blank and unknown lines without failing the turn", async () => {
    const { spawner } = fakeSpawner(() => ({
      stdout: chunks([
        "\n",
        '{"type":"system","subtype":"init"}\n',
        "not json\n",
        `${delta("x")}\n`,
        '{"type":"rate_limit_event"}\n',
        `${result("fine")}\n`,
      ]),
    }));
    const seen: string[] = [];
    const res = await createBridge({ cwd: "/w", spawner }).runTurn("hi", (t) => seen.push(t));
    expect(seen).toEqual(["x"]);
    expect(res.ok).toBe(true);
    expect(res.text).toBe("fine");
  });

  it("survives an onDelta callback that throws", async () => {
    const { spawner } = okSpawner("still fine");
    const res = await createBridge({ cwd: "/w", spawner }).runTurn("hi", () => {
      throw new Error("subscriber blew up");
    });
    expect(res.ok).toBe(true);
    expect(res.text).toBe("still fine");
  });
});

describe("createBridge — argv", () => {
  it("omits --continue on the first turn and includes it afterwards", async () => {
    const { spawner, calls } = okSpawner();
    const bridge = createBridge({ cwd: "/w", spawner });

    await bridge.runTurn("one", () => {});
    expect(calls[0]?.argv).not.toContain("--continue");

    await bridge.runTurn("two", () => {});
    expect(calls[1]).toBeDefined();
    expect(calls[1]?.argv).toContain("--continue");

    await bridge.runTurn("three", () => {});
    expect(calls[2]?.argv).toContain("--continue");
  });

  it("honours an injected isFirstTurn predicate", async () => {
    const { spawner, calls } = okSpawner();
    let first = true;
    const bridge = createBridge({ cwd: "/w", spawner, isFirstTurn: () => first });

    await bridge.runTurn("one", () => {});
    expect(calls[0]?.argv).not.toContain("--continue");

    first = false;
    await bridge.runTurn("two", () => {});
    expect(calls[1]?.argv).toContain("--continue");
  });

  it("does not claim continuity after a first turn that failed", async () => {
    const { spawner, calls } = fakeSpawner((call) =>
      call.argv.includes("dead")
        ? { stdout: chunks([]), exitCode: Promise.resolve(1) }
        : { stdout: chunks([`${result("ok")}\n`]) },
    );
    const bridge = createBridge({ cwd: "/w", spawner });

    const failed = await bridge.runTurn("dead", () => {});
    expect(failed.ok).toBe(false);
    // Nothing was recorded in the session dir, so there is nothing to continue.
    expect(calls[1]).toBeUndefined();

    await bridge.runTurn("live", () => {});
    expect(calls[1]?.argv).not.toContain("--continue");

    await bridge.runTurn("again", () => {});
    expect(calls[2]?.argv).toContain("--continue");
  });

  it("passes the verified streaming flags and runs in the configured cwd", async () => {
    const { spawner, calls } = okSpawner();
    await createBridge({ cwd: "/w/web-lead", spawner }).runTurn("hi", () => {});

    const argv = calls[0]?.argv ?? [];
    expect(argv[0]).toBe("claude");
    expect(argv).toContain("-p");
    expect(argv).toContain("--output-format");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(argv).toContain("--include-partial-messages");
    expect(argv).toContain("--verbose");
    expect(calls[0]?.cwd).toBe("/w/web-lead");
  });
});

describe("createBridge — no shell, ever", () => {
  it("passes a shell-metacharacter prompt through as one verbatim argv element", async () => {
    const { spawner, calls } = okSpawner();
    const nasty = [
      "$(whoami) `id` ${HOME}",
      "; rm -rf / && echo pwned | cat",
      "second line with 'quotes' and \"double quotes\"",
      "back\\slash and $VAR",
    ].join("\n");

    await createBridge({ cwd: "/w", spawner }).runTurn(nasty, () => {});

    const argv = calls[0]?.argv ?? [];
    // Exactly one element equals the prompt, byte for byte: nothing was
    // expanded, split on whitespace, or re-quoted on the way through.
    const matches = argv.filter((a) => a === nasty);
    expect(matches).toHaveLength(1);
    // And no element is a shell invocation that could interpret it.
    expect(argv.some((a) => /^(?:.*\/)?(?:sh|bash|zsh|cmd(?:\.exe)?)$/.test(a))).toBe(false);
    expect(argv).not.toContain("-c");
    // The metacharacters survive intact inside that single element.
    const prompt = matches[0] as string;
    expect(prompt).toContain("$(whoami)");
    expect(prompt).toContain("`id`");
    expect(prompt).toContain("; rm -rf /");
    expect(prompt.split("\n")).toHaveLength(4);
  });

  it("does not let a prompt masquerade as extra flags by being split", async () => {
    const { spawner, calls } = okSpawner();
    await createBridge({ cwd: "/w", spawner }).runTurn(
      "--dangerously-skip-permissions --add-dir /",
      () => {},
    );
    const argv = calls[0]?.argv ?? [];
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv.at(-1)).toBe("--dangerously-skip-permissions --add-dir /");
  });
});

describe("createBridge — environment", () => {
  it("removes the three CLAUDE_CODE_* session vars while inheriting the rest", async () => {
    const { spawner, calls } = okSpawner();
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "parent-session");
    vi.stubEnv("CLAUDE_CODE_MESSAGING_SOCKET", "/tmp/cc-socks/1.sock");
    vi.stubEnv("CLAUDE_CODE_MESSAGING_TOKEN", "parent-token");
    vi.stubEnv("SOME_UNRELATED_VAR", "kept");

    try {
      await createBridge({ cwd: "/w", spawner }).runTurn("hi", () => {});
    } finally {
      vi.unstubAllEnvs();
    }

    const env = calls[0]?.env ?? {};
    // Absent, not merely empty: an empty string still reads as "set" to the CLI.
    expect("CLAUDE_CODE_SESSION_ID" in env).toBe(false);
    expect("CLAUDE_CODE_MESSAGING_SOCKET" in env).toBe(false);
    expect("CLAUDE_CODE_MESSAGING_TOKEN" in env).toBe(false);
    expect(env.SOME_UNRELATED_VAR).toBe("kept");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("does not mutate the parent process env", async () => {
    const { spawner } = okSpawner();
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "parent-session");
    try {
      await createBridge({ cwd: "/w", spawner }).runTurn("hi", () => {});
      expect(process.env.CLAUDE_CODE_SESSION_ID).toBe("parent-session");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("createBridge — failure modes", () => {
  it("reports a non-zero exit as an error rather than throwing", async () => {
    const { spawner } = fakeSpawner(() => ({
      stdout: chunks([]),
      exitCode: Promise.resolve(2),
    }));
    const res = await createBridge({ cwd: "/w", spawner }).runTurn("hi", () => {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/2/);
    expect(res.usage).toBeNull();
  });

  it("reports an is_error result line as an error", async () => {
    const { spawner } = fakeSpawner(() => ({
      stdout: chunks([
        `${delta("partial")}\n`,
        `${JSON.stringify({ type: "result", is_error: true, result: "model refused" })}\n`,
      ]),
    }));
    const seen: string[] = [];
    const res = await createBridge({ cwd: "/w", spawner }).runTurn("hi", (t) => seen.push(t));
    // Deltas already delivered stay delivered; the turn still fails.
    expect(seen).toEqual(["partial"]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("model refused");
  });

  it("reports stdout closing with no result line as an error", async () => {
    const { spawner } = fakeSpawner(() => ({
      stdout: chunks([`${delta("half a thought")}\n`]),
      exitCode: Promise.resolve(0),
    }));
    const res = await createBridge({ cwd: "/w", spawner }).runTurn("hi", () => {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/result/i);
  });

  it("reports a stdout stream that errors mid-turn", async () => {
    const { spawner } = fakeSpawner(() => ({
      stdout: {
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          throw new Error("EPIPE");
        },
      },
    }));
    const res = await createBridge({ cwd: "/w", spawner }).runTurn("hi", () => {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/EPIPE/);
  });

  it("reports a spawner that throws outright", async () => {
    const spawner = (): never => {
      throw new Error("ENOENT: claude not found");
    };
    const res = await createBridge({ cwd: "/w", spawner }).runTurn("hi", () => {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ENOENT/);
  });

  it("times out a hung turn, kills the process, and never hangs itself", async () => {
    const killed: string[] = [];
    const spawner: TurnSpawner = () => ({
      stdout: hangingStdout(),
      exitCode: new Promise<number>(() => {}),
      kill: () => killed.push("kill"),
    });

    const res = await createBridge({ cwd: "/w", spawner, timeoutMs: 20 }).runTurn(
      "hi",
      () => {},
    );

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/time/i);
    expect(killed).toEqual(["kill"]);
  });

  it("times out a child that streams but never finishes", async () => {
    const killed: string[] = [];
    const spawner: TurnSpawner = () => ({
      stdout: {
        async *[Symbol.asyncIterator]() {
          yield `${delta("thinking…")}\n`;
          await new Promise<void>(() => {});
        },
      },
      exitCode: new Promise<number>(() => {}),
      kill: () => killed.push("kill"),
    });

    const seen: string[] = [];
    const res = await createBridge({ cwd: "/w", spawner, timeoutMs: 20 }).runTurn(
      "hi",
      (t) => seen.push(t),
    );

    expect(seen).toEqual(["thinking…"]);
    expect(res.ok).toBe(false);
    expect(killed).toEqual(["kill"]);
  });

  it("does not kill a turn that finished before the timeout", async () => {
    const killed: string[] = [];
    const spawner: TurnSpawner = () => ({
      stdout: chunks([`${result("quick")}\n`]),
      exitCode: Promise.resolve(0),
      kill: () => killed.push("kill"),
    });
    const res = await createBridge({ cwd: "/w", spawner, timeoutMs: 5_000 }).runTurn(
      "hi",
      () => {},
    );
    expect(res.ok).toBe(true);
    expect(killed).toEqual([]);
  });

  it("times out a child whose stdout ends but whose exit never resolves", async () => {
    const killed: string[] = [];
    const spawner: TurnSpawner = () => ({
      stdout: chunks([`${result("done streaming")}\n`]),
      exitCode: new Promise<number>(() => {}),
      kill: () => killed.push("kill"),
    });
    const res = await createBridge({ cwd: "/w", spawner, timeoutMs: 20 }).runTurn(
      "hi",
      () => {},
    );
    expect(res.ok).toBe(false);
    expect(killed).toEqual(["kill"]);
  });
});
