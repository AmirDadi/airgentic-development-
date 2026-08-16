import { describe, it, expect } from "vitest";
import {
  createGithubArtifactSource,
  createGithubBranchSource,
} from "../src/github";

/**
 * Fake-fetch tests for the artifact + branch sources, same conventions as
 * github.test.ts: nothing here may ever touch the network.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** One contents-API entry, shaped like the real endpoint's directory listing. */
function file(name: string, over: Record<string, unknown> = {}): unknown {
  return {
    name,
    path: `specs/${name}`,
    sha: "abc123",
    size: 42,
    type: "file",
    ...over,
  };
}

function recordingFetch(respond: (url: string) => Promise<Response>): {
  fn: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("createGithubArtifactSource", () => {
  it("parses a realistic contents listing into the artifact map", async () => {
    const { fn } = recordingFetch(async () =>
      json([
        file("checkout.spec.md"),
        file("checkout.interfaces.md"),
        file("payments.plan.md"),
        // dotted/dashed feature names, exactly like the local scanner accepts
        file("web-lead.v2.spec.md"),
        file("web-lead.v2.plan.md"),
        // noise the local scanner would ignore too
        file("README.md"),
        file("notes.txt"),
        file("checkout.spec.md.bak"),
        // a directory named like an artifact is not an artifact
        file("dir.spec.md", { type: "dir" }),
      ]),
    );
    const list = createGithubArtifactSource({ repo: "acme/app", fetch: fn });
    expect(await list()).toEqual({
      checkout: { spec: true, interfaces: true, plan: false },
      payments: { spec: false, interfaces: false, plan: true },
      "web-lead.v2": { spec: true, interfaces: false, plan: true },
    });
  });

  it("requests the default specs path on the default ref", async () => {
    const { fn, calls } = recordingFetch(async () => json([]));
    await createGithubArtifactSource({ repo: "acme/app", fetch: fn })();
    expect(calls[0]!.url).toBe(
      "https://api.github.com/repos/acme/app/contents/specs?ref=main",
    );
  });

  it("URL-encodes a custom specsPath and ref", async () => {
    const { fn, calls } = recordingFetch(async () => json([]));
    await createGithubArtifactSource({
      repo: "acme/app",
      fetch: fn,
      specsPath: "docs/spec files",
      ref: "release/1.0",
    })();
    expect(calls[0]!.url).toBe(
      "https://api.github.com/repos/acme/app/contents/docs/spec%20files?ref=release%2F1.0",
    );
  });

  it("sends the auth token and standard headers", async () => {
    const { fn, calls } = recordingFetch(async () => json([]));
    await createGithubArtifactSource({
      repo: "acme/app",
      fetch: fn,
      token: "ghp_secret",
    })();
    const headers = new Headers(calls[0]!.init!.headers);
    expect(headers.get("authorization")).toBe("Bearer ghp_secret");
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("user-agent")).toBeTruthy();
  });

  it("treats a 404 as 'no specs yet': resolves {} with NO onError", async () => {
    const errors: unknown[] = [];
    const { fn } = recordingFetch(async () => json({ message: "Not Found" }, 404));
    const list = createGithubArtifactSource({
      repo: "acme/app",
      fetch: fn,
      onError: (e) => errors.push(e),
    });
    await expect(list()).resolves.toEqual({});
    expect(errors).toEqual([]);
  });

  it("a 404 supersedes the last good snapshot (the dir was deleted)", async () => {
    let mode: "ok" | "gone" = "ok";
    const { fn } = recordingFetch(async () =>
      mode === "ok" ? json([file("a.spec.md")]) : json({ message: "Not Found" }, 404),
    );
    const list = createGithubArtifactSource({ repo: "acme/app", fetch: fn });
    expect(Object.keys(await list())).toEqual(["a"]);
    mode = "gone";
    await expect(list()).resolves.toEqual({});
  });

  it("resolves to the last known good on 403/500 and reports each", async () => {
    let status = 200;
    const errors: { status?: number; message: string }[] = [];
    const { fn } = recordingFetch(async () =>
      status === 200 ? json([file("a.spec.md")]) : json({ message: "nope" }, status),
    );
    const list = createGithubArtifactSource({
      repo: "acme/app",
      fetch: fn,
      onError: (e) => errors.push(e),
    });
    const good = await list();
    expect(Object.keys(good)).toEqual(["a"]);

    for (const s of [403, 500]) {
      status = s;
      await expect(list()).resolves.toEqual(good);
    }
    expect(errors.map((e) => e.status)).toEqual([403, 500]);
  });

  it("resolves to {} before any success when the network is down", async () => {
    const errors: unknown[] = [];
    const fn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const list = createGithubArtifactSource({
      repo: "acme/app",
      fetch: fn,
      onError: (e) => errors.push(e),
    });
    await expect(list()).resolves.toEqual({});
    expect(errors).toHaveLength(1);
  });

  it("resolves to the last known good on malformed JSON", async () => {
    let mode: "ok" | "garbage" = "ok";
    const { fn } = recordingFetch(async () =>
      mode === "ok"
        ? json([file("a.spec.md")])
        : new Response("<html>oops", { status: 200 }),
    );
    const list = createGithubArtifactSource({ repo: "acme/app", fetch: fn });
    const good = await list();
    mode = "garbage";
    await expect(list()).resolves.toEqual(good);
  });

  it("resolves to the last known good when the payload is not an array (a file path)", async () => {
    const errors: unknown[] = [];
    const { fn } = recordingFetch(async () =>
      json({ name: "specs", type: "file", content: "…" }),
    );
    const list = createGithubArtifactSource({
      repo: "acme/app",
      fetch: fn,
      onError: (e) => errors.push(e),
    });
    await expect(list()).resolves.toEqual({});
    expect(errors).toHaveLength(1);
  });

  it("a throwing onError cannot break the poll", async () => {
    const { fn } = recordingFetch(async () => json({}, 500));
    const list = createGithubArtifactSource({
      repo: "acme/app",
      fetch: fn,
      onError: () => {
        throw new Error("bad sink");
      },
    });
    await expect(list()).resolves.toEqual({});
  });
});

describe("createGithubBranchSource", () => {
  it("parses branch names from the branches API", async () => {
    const { fn, calls } = recordingFetch(async () =>
      json([
        { name: "main", commit: { sha: "a" } },
        { name: "feat/checkout", commit: { sha: "b" } },
        { name: "feat/web-lead.v2", commit: { sha: "c" } },
      ]),
    );
    const list = createGithubBranchSource({ repo: "acme/app", fetch: fn });
    expect(await list()).toEqual(["main", "feat/checkout", "feat/web-lead.v2"]);
    expect(calls[0]!.url).toBe(
      "https://api.github.com/repos/acme/app/branches?per_page=100",
    );
  });

  it("skips malformed entries instead of failing the poll", async () => {
    const { fn } = recordingFetch(async () =>
      json([{ name: "main" }, null, { name: 42 }, "junk", { name: "feat/a" }]),
    );
    const list = createGithubBranchSource({ repo: "acme/app", fetch: fn });
    expect(await list()).toEqual(["main", "feat/a"]);
  });

  it("resolves to [] before any success on failure, and reports it", async () => {
    const errors: { status?: number; message: string }[] = [];
    const { fn } = recordingFetch(async () => json({ message: "nope" }, 500));
    const list = createGithubBranchSource({
      repo: "acme/app",
      fetch: fn,
      onError: (e) => errors.push(e),
    });
    await expect(list()).resolves.toEqual([]);
    expect(errors[0]!.status).toBe(500);
  });

  it("returns the last known good after a later failure", async () => {
    let mode: "ok" | "fail" = "ok";
    const { fn } = recordingFetch(async () => {
      if (mode === "fail") throw new Error("network down");
      return json([{ name: "main" }, { name: "feat/a" }]);
    });
    const list = createGithubBranchSource({ repo: "acme/app", fetch: fn });
    const good = await list();
    mode = "fail";
    await expect(list()).resolves.toEqual(good);
  });

  it("sends the auth token only when present", async () => {
    const authed = recordingFetch(async () => json([]));
    await createGithubBranchSource({
      repo: "acme/app",
      fetch: authed.fn,
      token: "ghp_secret",
    })();
    expect(new Headers(authed.calls[0]!.init!.headers).get("authorization")).toBe(
      "Bearer ghp_secret",
    );

    const anon = recordingFetch(async () => json([]));
    await createGithubBranchSource({ repo: "acme/app", fetch: anon.fn })();
    expect(new Headers(anon.calls[0]!.init!.headers).get("authorization")).toBeNull();
  });
});
