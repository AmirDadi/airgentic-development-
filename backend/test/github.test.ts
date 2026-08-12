import { describe, it, expect, vi } from "vitest";
import { createGithubPrSource } from "../src/github";
import type { GithubOptions } from "../src/github";

/**
 * Every test here injects a fake `fetch`. Nothing in this file may touch the
 * network: a test that reaches api.github.com is flaky, slow, and rate-limited.
 */

interface PullPayload {
  number: number;
  state: string;
  merged_at: string | null;
  html_url: string;
  head: { ref: string };
  title: string;
}

function pull(over: Partial<PullPayload> & { number: number }): PullPayload {
  return {
    state: "open",
    merged_at: null,
    html_url: `https://github.com/acme/app/pull/${over.number}`,
    head: { ref: `feat/f${over.number}` },
    title: `PR ${over.number}`,
    ...over,
  };
}

function review(user: string, state: string): unknown {
  return { user: { login: user }, state, submitted_at: "2026-01-01T00:00:00Z" };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Fake fetch routing on URL shape: the pulls list, then per-PR reviews.
 * `reviews` is keyed by PR number; a missing key yields an empty review list.
 */
function fakeFetch(
  pulls: unknown,
  reviews: Record<number, unknown> = {},
  opts: { reviewFails?: number[] } = {},
): { fn: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const m = /\/pulls\/(\d+)\/reviews/.exec(url);
    if (m !== null) {
      const n = Number(m[1]);
      if (opts.reviewFails?.includes(n)) throw new Error("boom");
      return json(reviews[n] ?? []);
    }
    return json(pulls);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function source(over: Partial<GithubOptions> & { fetch: typeof fetch }) {
  return createGithubPrSource({ repo: "acme/app", ...over });
}

describe("request shape", () => {
  it("queries the repo's pulls with state=all and a page size", async () => {
    const { fn, calls } = fakeFetch([]);
    await source({ fetch: fn })();

    const url = calls[0]!.url;
    expect(url).toContain("https://api.github.com/repos/acme/app/pulls");
    expect(url).toContain("state=all");
    expect(url).toMatch(/per_page=\d+/);
  });

  it("sends an authorization header only when a token is present", async () => {
    const withToken = fakeFetch([]);
    await source({ fetch: withToken.fn, token: "ghp_secret" })();
    const authed = new Headers(withToken.calls[0]!.init!.headers);
    expect(authed.get("authorization")).toBe("Bearer ghp_secret");
    expect(authed.get("accept")).toBe("application/vnd.github+json");
    expect(authed.get("user-agent")).toBeTruthy();

    const anon = fakeFetch([]);
    await source({ fetch: anon.fn })();
    const plain = new Headers(anon.calls[0]!.init!.headers);
    expect(plain.get("authorization")).toBeNull();
    expect(plain.get("accept")).toBe("application/vnd.github+json");
  });
});

describe("state mapping", () => {
  it("maps an open PR to open", async () => {
    const { fn } = fakeFetch([pull({ number: 1, state: "open" })]);
    const prs = await source({ fetch: fn })();
    expect(prs.f1).toEqual({
      url: "https://github.com/acme/app/pull/1",
      state: "open",
      approved: false,
    });
  });

  it("maps a closed PR with a merged_at to MERGED, not closed", async () => {
    // The trap: GitHub reports merged PRs as state:"closed". Reading only
    // `state` would mark every shipped feature as abandoned.
    const { fn } = fakeFetch([
      pull({ number: 2, state: "closed", merged_at: "2026-02-02T10:00:00Z" }),
    ]);
    const prs = await source({ fetch: fn })();
    expect(prs.f2!.state).toBe("merged");
  });

  it("maps a closed PR with a null merged_at to closed", async () => {
    const { fn } = fakeFetch([
      pull({ number: 3, state: "closed", merged_at: null }),
    ]);
    const prs = await source({ fetch: fn })();
    expect(prs.f3!.state).toBe("closed");
  });
});

describe("approval rule", () => {
  const openPr = (n: number) => pull({ number: n, state: "open" });

  it("is approved on a lone APPROVED review", async () => {
    const { fn } = fakeFetch([openPr(1)], { 1: [review("ann", "APPROVED")] });
    expect((await source({ fetch: fn })()).f1!.approved).toBe(true);
  });

  it("is NOT approved when the same reviewer approves then requests changes", async () => {
    const { fn } = fakeFetch([openPr(1)], {
      1: [review("ann", "APPROVED"), review("ann", "CHANGES_REQUESTED")],
    });
    expect((await source({ fetch: fn })()).f1!.approved).toBe(false);
  });

  it("IS approved when the same reviewer requests changes then approves", async () => {
    const { fn } = fakeFetch([openPr(1)], {
      1: [review("ann", "CHANGES_REQUESTED"), review("ann", "APPROVED")],
    });
    expect((await source({ fetch: fn })()).f1!.approved).toBe(true);
  });

  it("ignores COMMENTED reviews entirely", async () => {
    // A comment after an approval must not un-approve...
    const after = fakeFetch([openPr(1)], {
      1: [review("ann", "APPROVED"), review("ann", "COMMENTED")],
    });
    expect((await source({ fetch: after.fn })()).f1!.approved).toBe(true);

    // ...and comments alone are not an approval.
    const only = fakeFetch([openPr(1)], {
      1: [review("ann", "COMMENTED"), review("bob", "COMMENTED")],
    });
    expect((await source({ fetch: only.fn })()).f1!.approved).toBe(false);
  });

  it("is NOT approved when another reviewer's latest is CHANGES_REQUESTED", async () => {
    const { fn } = fakeFetch([openPr(1)], {
      1: [review("ann", "APPROVED"), review("bob", "CHANGES_REQUESTED")],
    });
    expect((await source({ fetch: fn })()).f1!.approved).toBe(false);
  });

  it("is approved when a second reviewer's changes request was superseded", async () => {
    const { fn } = fakeFetch([openPr(1)], {
      1: [
        review("ann", "APPROVED"),
        review("bob", "CHANGES_REQUESTED"),
        review("bob", "APPROVED"),
      ],
    });
    expect((await source({ fetch: fn })()).f1!.approved).toBe(true);
  });

  it("is not approved when the reviews list is empty", async () => {
    const { fn } = fakeFetch([openPr(1)], { 1: [] });
    expect((await source({ fetch: fn })()).f1!.approved).toBe(false);
  });
});

describe("feature-name mapping", () => {
  it("maps feat/<name> to <name>", async () => {
    const { fn } = fakeFetch([
      pull({ number: 1, head: { ref: "feat/checkout" } }),
    ]);
    const prs = await source({ fetch: fn })();
    expect(Object.keys(prs)).toEqual(["checkout"]);
  });

  it("excludes PRs from main and other non-feature refs", async () => {
    const { fn } = fakeFetch([
      pull({ number: 1, head: { ref: "main" } }),
      pull({ number: 2, head: { ref: "dependabot/npm/lodash" } }),
      pull({ number: 3, head: { ref: "feat/" } }),
      pull({ number: 4, head: { ref: "feat/real" } }),
    ]);
    const prs = await source({ fetch: fn })();
    expect(Object.keys(prs)).toEqual(["real"]);
  });

  it("honours an injected featureNameFor and drops its nulls", async () => {
    const { fn } = fakeFetch([
      pull({ number: 1, head: { ref: "checkout" }, title: "Checkout" }),
      pull({ number: 2, head: { ref: "junk" }, title: "Junk" }),
    ]);
    const prs = await source({
      fetch: fn,
      featureNameFor: (pr) => (pr.headRef === "checkout" ? "checkout" : null),
    })();
    expect(Object.keys(prs)).toEqual(["checkout"]);
  });
});

describe("duplicate features", () => {
  it("prefers merged, then open, then closed", async () => {
    const ref = { ref: "feat/dup" };
    const { fn } = fakeFetch([
      pull({ number: 1, head: ref, state: "closed" }),
      pull({ number: 2, head: ref, state: "open" }),
      pull({
        number: 3,
        head: ref,
        state: "closed",
        merged_at: "2026-01-01T00:00:00Z",
      }),
    ]);
    const prs = await source({ fetch: fn })();
    expect(prs.dup!.state).toBe("merged");
    expect(prs.dup!.url).toBe("https://github.com/acme/app/pull/3");
  });

  it("breaks ties on the highest PR number, regardless of list order", async () => {
    const ref = { ref: "feat/dup" };
    const forward = fakeFetch([
      pull({ number: 7, head: ref, state: "open" }),
      pull({ number: 9, head: ref, state: "open" }),
    ]);
    const reverse = fakeFetch([
      pull({ number: 9, head: ref, state: "open" }),
      pull({ number: 7, head: ref, state: "open" }),
    ]);
    const a = await source({ fetch: forward.fn })();
    const b = await source({ fetch: reverse.fn })();
    expect(a.dup!.url).toContain("/pull/9");
    expect(b).toEqual(a);
  });

  it("prefers an open PR over a closed-unmerged one", async () => {
    const ref = { ref: "feat/dup" };
    const { fn } = fakeFetch([
      pull({ number: 12, head: ref, state: "closed" }),
      pull({ number: 4, head: ref, state: "open" }),
    ]);
    const prs = await source({ fetch: fn })();
    expect(prs.dup!.state).toBe("open");
    expect(prs.dup!.url).toContain("/pull/4");
  });
});

describe("resilience", () => {
  it("resolves to {} when fetch rejects", async () => {
    const fn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(source({ fetch: fn })()).resolves.toEqual({});
  });

  it("resolves to {} on a non-200, including rate limits", async () => {
    for (const status of [403, 429, 500, 404]) {
      const fn = (async () => json({ message: "nope" }, status)) as unknown as typeof fetch;
      await expect(source({ fetch: fn })()).resolves.toEqual({});
    }
  });

  it("resolves to {} on malformed JSON", async () => {
    const fn = (async () => new Response("<html>oops", { status: 200 })) as unknown as typeof fetch;
    await expect(source({ fetch: fn })()).resolves.toEqual({});
  });

  it("resolves to {} when the payload is not an array", async () => {
    const fn = (async () => json({ message: "Bad credentials" })) as unknown as typeof fetch;
    await expect(source({ fetch: fn })()).resolves.toEqual({});
  });

  it("skips malformed PR entries instead of failing the poll", async () => {
    const { fn } = fakeFetch([
      null,
      { number: "x" },
      pull({ number: 5, head: { ref: "feat/good" } }),
    ]);
    const prs = await source({ fetch: fn })();
    expect(Object.keys(prs)).toEqual(["good"]);
  });

  it("keeps other PRs when one reviews request fails", async () => {
    const { fn } = fakeFetch(
      [
        pull({ number: 1, head: { ref: "feat/a" }, state: "open" }),
        pull({ number: 2, head: { ref: "feat/b" }, state: "open" }),
      ],
      { 2: [review("ann", "APPROVED")] },
      { reviewFails: [1] },
    );
    const prs = await source({ fetch: fn })();
    expect(prs.a).toEqual({
      url: "https://github.com/acme/app/pull/1",
      state: "open",
      approved: false,
    });
    expect(prs.b!.approved).toBe(true);
  });

  it("returns the last known good result after a later failure", async () => {
    let mode: "ok" | "fail" = "ok";
    const fn = (async (input: unknown) => {
      if (mode === "fail") throw new Error("network down");
      if (/reviews/.test(String(input))) return json([review("ann", "APPROVED")]);
      return json([pull({ number: 1, head: { ref: "feat/a" }, state: "open" })]);
    }) as unknown as typeof fetch;

    const list = source({ fetch: fn });
    const first = await list();
    expect(first.a!.approved).toBe(true);

    mode = "fail";
    expect(await list()).toEqual(first);
  });

  it("never writes to the console", async () => {
    const spies = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
    ];
    const fn = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await source({ fetch: fn })();
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe("concurrency cap", () => {
  it("keeps at most 5 reviews requests in flight for 50 open PRs", async () => {
    const pulls = Array.from({ length: 50 }, (_, i) =>
      pull({ number: i + 1, head: { ref: `feat/f${i + 1}` }, state: "open" }),
    );

    let inFlight = 0;
    let peak = 0;
    let reviewCalls = 0;
    const release: (() => void)[] = [];

    const fn = (async (input: unknown) => {
      const url = String(input);
      if (!/reviews/.test(url)) return json(pulls);
      reviewCalls += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight -= 1;
      return json([review("ann", "APPROVED")]);
    }) as unknown as typeof fetch;

    let done = false;
    const pending = source({ fetch: fn })().then((r) => {
      done = true;
      return r;
    });

    // Drain: each loop lets whatever is in flight finish, then yields so the
    // pool can start the next batch.
    for (let i = 0; i < 500 && !done; i += 1) {
      release.splice(0).forEach((r) => r());
      await new Promise((r) => setTimeout(r, 0));
    }

    const prs = await pending;
    expect(Object.keys(prs)).toHaveLength(50);
    expect(reviewCalls).toBe(50);
    expect(peak).toBeGreaterThan(1); // it does run in parallel...
    expect(peak).toBeLessThanOrEqual(5); // ...but never unbounded.
  });

  it("does not request reviews for merged or closed PRs", async () => {
    const { fn, calls } = fakeFetch([
      pull({ number: 1, head: { ref: "feat/a" }, state: "closed", merged_at: "2026-01-01T00:00:00Z" }),
      pull({ number: 2, head: { ref: "feat/b" }, state: "closed" }),
    ]);
    await source({ fetch: fn })();
    expect(calls.filter((c) => /reviews/.test(c.url))).toHaveLength(0);
  });
});

describe("failure observability", () => {
  // A silently-empty PR source is indistinguishable from "no PRs exist": every
  // feature sits at its artifact stage forever and the operator gets no signal.
  // A bad token or typo'd repo must surface somewhere.
  it("reports the HTTP status when the PR list request fails", async () => {
    const errors: { status?: number; message: string }[] = [];
    const src = createGithubPrSource({
      repo: "o/r",
      onError: (e) => errors.push(e),
      fetch: (async () => ({
        ok: false,
        status: 401,
        json: async () => ({ message: "Bad credentials" }),
      })) as unknown as typeof fetch,
    });

    await expect(src()).resolves.toEqual({});
    expect(errors).toHaveLength(1);
    expect(errors[0]!.status).toBe(401);
  });

  it("reports a network failure too", async () => {
    const errors: { status?: number; message: string }[] = [];
    const src = createGithubPrSource({
      repo: "o/r",
      onError: (e) => errors.push(e),
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });

    await src();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/fetch failed/i);
  });

  it("stays silent on a successful poll", async () => {
    const errors: unknown[] = [];
    const src = createGithubPrSource({
      repo: "o/r",
      onError: (e) => errors.push(e),
      fetch: (async () => ({ ok: true, status: 200, json: async () => [] })) as unknown as typeof fetch,
    });

    await src();
    expect(errors).toEqual([]);
  });

  it("a throwing onError cannot break the poll", async () => {
    const src = createGithubPrSource({
      repo: "o/r",
      onError: () => {
        throw new Error("bad sink");
      },
      fetch: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch,
    });

    await expect(src()).resolves.toEqual({});
  });
});
