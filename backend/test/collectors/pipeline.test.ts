import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate, listFeatures } from "../../src/db";
import { collectPipeline } from "../../src/collectors/pipeline";
import type { PipelineOptions, PrInfo } from "../../src/collectors/pipeline";

let db: Database.Database;
let dir: string;

beforeEach(async () => {
  db = new Database(":memory:");
  migrate(db);
  dir = await mkdtemp(join(tmpdir(), "pipeline-test-"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

/** Writes a gate artifact for `feature`; content is irrelevant, existence isn't. */
async function artifact(
  feature: string,
  gate: "spec" | "interfaces" | "plan",
  into: string = dir,
): Promise<void> {
  await writeFile(join(into, `${feature}.${gate}.md`), `# ${feature} ${gate}\n`);
}

function opts(over: Partial<PipelineOptions> = {}): PipelineOptions {
  return {
    specsDir: dir,
    listBranches: async () => [],
    listPrs: async () => ({}),
    now: () => 1_700_000_000_000,
    ...over,
  };
}

function pr(over: Partial<PrInfo> = {}): PrInfo {
  return { url: "https://gh/pr/1", state: "open", approved: false, ...over };
}

describe("discovery from artifacts", () => {
  it("derives the feature name from a gate filename", async () => {
    await artifact("checkout", "spec");
    await collectPipeline(db, opts());
    expect(listFeatures(db).map((f) => f.name)).toEqual(["checkout"]);
  });

  it("discovers a feature from ANY one of the three artifact types", async () => {
    await artifact("alpha", "spec");
    await artifact("beta", "interfaces");
    await artifact("gamma", "plan");
    await collectPipeline(db, opts());
    expect(listFeatures(db).map((f) => f.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("handles feature names containing dots and dashes", async () => {
    await artifact("web-lead.v2", "spec");
    await collectPipeline(db, opts());
    expect(listFeatures(db).map((f) => f.name)).toEqual(["web-lead.v2"]);
  });
});

describe("stage derivation", () => {
  it("spec only → spec", async () => {
    await artifact("a", "spec");
    await collectPipeline(db, opts());
    expect(listFeatures(db)[0].stage).toBe("spec");
  });

  it("spec + interfaces → interfaces", async () => {
    await artifact("a", "spec");
    await artifact("a", "interfaces");
    await collectPipeline(db, opts());
    expect(listFeatures(db)[0].stage).toBe("interfaces");
  });

  it("all three gates → plan", async () => {
    await artifact("a", "spec");
    await artifact("a", "interfaces");
    await artifact("a", "plan");
    await collectPipeline(db, opts());
    expect(listFeatures(db)[0].stage).toBe("plan");
  });

  it("non-contiguous gates do not promote (plan without spec → not_started)", async () => {
    await artifact("a", "plan");
    await collectPipeline(db, opts());
    expect(listFeatures(db)[0].stage).toBe("not_started");
  });

  it("all gates + branch → implementing", async () => {
    for (const g of ["spec", "interfaces", "plan"] as const) {
      await artifact("a", g);
    }
    await collectPipeline(db, opts({ listBranches: async () => ["feat/a"] }));
    const [row] = listFeatures(db);
    expect(row.stage).toBe("implementing");
    expect(row.branch).toBe("feat/a");
  });

  it("an open unapproved PR → in_review, approved → merge_ready, merged → merged", async () => {
    await artifact("a", "spec");
    const run = async (info: PrInfo) => {
      await collectPipeline(db, opts({ listPrs: async () => ({ a: info }) }));
      return listFeatures(db)[0].stage;
    };
    expect(await run(pr())).toBe("in_review");
    expect(await run(pr({ approved: true }))).toBe("merge_ready");
    expect(await run(pr({ state: "merged" }))).toBe("merged");
  });
});

describe("branch matching", () => {
  it("attaches a `feat/<name>` branch to the feature", async () => {
    await artifact("checkout", "spec");
    await collectPipeline(
      db,
      opts({ listBranches: async () => ["feat/checkout"] }),
    );
    expect(listFeatures(db)[0].branch).toBe("feat/checkout");
  });

  it("attaches an exact-name branch to the feature", async () => {
    await artifact("checkout", "spec");
    await collectPipeline(
      db,
      opts({ listBranches: async () => ["checkout"] }),
    );
    expect(listFeatures(db)[0].branch).toBe("checkout");
  });

  it("does NOT attach unrelated branches like `main`", async () => {
    await artifact("checkout", "spec");
    await collectPipeline(
      db,
      opts({
        listBranches: async () => ["main", "develop", "feat/other-thing"],
      }),
    );
    const [row] = listFeatures(db);
    expect(row.branch).toBeNull();
    expect(row.name).toBe("checkout");
  });

  it("does not match on a mere substring (`feat/checkout-v2` is a different feature)", async () => {
    await artifact("checkout", "spec");
    await collectPipeline(
      db,
      opts({ listBranches: async () => ["feat/checkout-v2"] }),
    );
    expect(listFeatures(db).find((f) => f.name === "checkout")!.branch).toBeNull();
  });

  it("prefers the `feat/<name>` branch when both conventions exist", async () => {
    await artifact("checkout", "spec");
    await collectPipeline(
      db,
      opts({ listBranches: async () => ["checkout", "feat/checkout"] }),
    );
    expect(listFeatures(db)[0].branch).toBe("feat/checkout");
  });
});

describe("PR, owner and timestamp persistence", () => {
  it("persists pr_url when a PR exists", async () => {
    await artifact("a", "spec");
    await collectPipeline(
      db,
      opts({ listPrs: async () => ({ a: pr({ url: "https://gh/pr/42" }) }) }),
    );
    expect(listFeatures(db)[0].pr_url).toBe("https://gh/pr/42");
  });

  it("leaves pr_url null when no PR exists", async () => {
    await artifact("a", "spec");
    await collectPipeline(db, opts({ listPrs: async () => ({ other: pr() }) }));
    expect(listFeatures(db).find((f) => f.name === "a")!.pr_url).toBeNull();
  });

  it("populates owner from opts.owners, null when absent", async () => {
    await artifact("a", "spec");
    await artifact("b", "spec");
    await collectPipeline(db, opts({ owners: { a: "payments-agent" } }));
    const rows = listFeatures(db);
    expect(rows.find((f) => f.name === "a")!.owner).toBe("payments-agent");
    expect(rows.find((f) => f.name === "b")!.owner).toBeNull();
  });

  it("sets updated_at from now()", async () => {
    await artifact("a", "spec");
    await collectPipeline(db, opts({ now: () => 12345 }));
    expect(listFeatures(db)[0].updated_at).toBe(12345);
  });
});

describe("noise and missing inputs", () => {
  it("does not throw and yields no features when specsDir does not exist", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      collectPipeline(db, opts({ specsDir: join(dir, "nope", "specs") })),
    ).resolves.toBeUndefined();

    expect(listFeatures(db)).toEqual([]);
    expect(out).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    out.mockRestore();
    log.mockRestore();
    err.mockRestore();
  });

  it("yields no features for an empty specs dir", async () => {
    await collectPipeline(db, opts());
    expect(listFeatures(db)).toEqual([]);
  });

  it("ignores files that don't match the gate pattern", async () => {
    await writeFile(join(dir, "README.md"), "# readme");
    await writeFile(join(dir, "notes.txt"), "notes");
    await writeFile(join(dir, "checkout.md"), "not a gate");
    await writeFile(join(dir, "checkout.design.md"), "not a gate either");
    await mkdir(join(dir, "archive"));
    await artifact("archive", "spec", join(dir, "archive"));
    await collectPipeline(db, opts());
    expect(listFeatures(db)).toEqual([]);
  });

  it("ignores a subdirectory even when it is named like a gate artifact", async () => {
    await mkdir(join(dir, "bogus.spec.md"));
    await collectPipeline(db, opts());
    expect(listFeatures(db)).toEqual([]);
  });
});

describe("re-running the collector", () => {
  it("upserts by name instead of duplicating rows", async () => {
    await artifact("checkout", "spec");
    await collectPipeline(db, opts({ now: () => 1 }));
    expect(listFeatures(db)).toHaveLength(1);
    expect(listFeatures(db)[0].stage).toBe("spec");

    // The feature advances: more gates land and a PR opens.
    await artifact("checkout", "interfaces");
    await artifact("checkout", "plan");
    await collectPipeline(
      db,
      opts({
        now: () => 2,
        listBranches: async () => ["feat/checkout"],
        listPrs: async () => ({ checkout: pr({ approved: true }) }),
      }),
    );

    const rows = listFeatures(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe("merge_ready");
    expect(rows[0].updated_at).toBe(2);
    expect(rows[0].pr_url).toBe("https://gh/pr/1");
  });
});

describe("features with no artifacts at all", () => {
  it("discovers a feature that only has a PR", async () => {
    await collectPipeline(
      db,
      opts({ listPrs: async () => ({ ghost: pr({ state: "merged" }) }) }),
    );
    const rows = listFeatures(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("ghost");
    expect(rows[0].stage).toBe("merged");
  });

  it("discovers a feature that only has a `feat/<name>` branch", async () => {
    await collectPipeline(db, opts({ listBranches: async () => ["feat/ghost"] }));
    const rows = listFeatures(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("ghost");
    expect(rows[0].branch).toBe("feat/ghost");
    expect(rows[0].stage).toBe("not_started");
  });

  it("does NOT invent a feature from a bare branch name (main, develop, checkout)", async () => {
    await collectPipeline(
      db,
      opts({ listBranches: async () => ["main", "develop", "checkout"] }),
    );
    expect(listFeatures(db)).toEqual([]);
  });
});

describe("injected listArtifacts (GitHub-sourced gates)", () => {
  const flags = (over: Partial<{ spec: boolean; interfaces: boolean; plan: boolean }> = {}) => ({
    spec: false,
    interfaces: false,
    plan: false,
    ...over,
  });

  it("derives features and stages from listArtifacts, never touching specsDir", async () => {
    await collectPipeline(
      db,
      opts({
        // A path that does not exist: if the local scan ran, it would find
        // nothing; the point is that listArtifacts replaces it entirely.
        specsDir: join(dir, "does-not-exist"),
        listArtifacts: async () => ({
          checkout: flags({ spec: true, interfaces: true }),
          "web-lead.v2": flags({ spec: true, interfaces: true, plan: true }),
        }),
      }),
    );
    const rows = listFeatures(db);
    expect(rows.map((f) => f.name)).toEqual(["checkout", "web-lead.v2"]);
    expect(rows.find((f) => f.name === "checkout")!.stage).toBe("interfaces");
    expect(rows.find((f) => f.name === "web-lead.v2")!.stage).toBe("plan");
  });

  it("ignores local gate files when listArtifacts is provided", async () => {
    await artifact("local-only", "spec");
    await collectPipeline(
      db,
      opts({ listArtifacts: async () => ({ remote: flags({ spec: true }) }) }),
    );
    expect(listFeatures(db).map((f) => f.name)).toEqual(["remote"]);
  });

  it("unions listArtifacts features with branches and PRs exactly like local files", async () => {
    await collectPipeline(
      db,
      opts({
        specsDir: join(dir, "does-not-exist"),
        listArtifacts: async () => ({
          a: flags({ spec: true, interfaces: true, plan: true }),
        }),
        listBranches: async () => ["feat/a", "feat/branch-only", "main"],
        listPrs: async () => ({ "pr-only": pr({ state: "merged" }) }),
      }),
    );
    const rows = listFeatures(db);
    expect(rows.map((f) => f.name).sort()).toEqual(["a", "branch-only", "pr-only"]);
    expect(rows.find((f) => f.name === "a")!.stage).toBe("implementing");
    expect(rows.find((f) => f.name === "pr-only")!.stage).toBe("merged");
  });

  it("without listArtifacts the local scan still runs (unchanged behaviour)", async () => {
    await artifact("checkout", "spec");
    await collectPipeline(db, opts());
    expect(listFeatures(db).map((f) => f.name)).toEqual(["checkout"]);
  });
});
