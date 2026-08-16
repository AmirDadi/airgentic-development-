# Direction change: pipeline signals come from the project's GitHub repo

2026-08-16

Spec gate artifacts (`<feature>.{spec,interfaces,plan}.md`) now live in the
PROJECT's GitHub repo, not in a local directory next to the dashboard. When
`GITHUB_REPO` is configured, ALL THREE pipeline signals are read from that
repo:

- gate artifacts — contents API (`SPECS_REPO_PATH`, default `specs`, read from
  `SPECS_REF`, default `main`; a 404 means "no specs dir yet" and is a normal
  zero-artifact state, not an error);
- branches — branches API;
- PRs — pulls API (unchanged).

The local `SPECS_DIR` scan and local git branches remain ONLY as the fallback
when no GitHub repo is configured.

Why:

1. **Single source of truth.** The team's specs are project artifacts; keeping
   them in the project repo means the dashboard, reviewers, and agents all read
   the same tree, and the dashboard no longer depends on a particular checkout
   being present on the machine it runs on.
2. **The branch signal was incoherent.** `defaultListBranches` ran
   `git for-each-ref` in the dashboard's own cwd — the DASHBOARD's repo, not
   the monitored project's — so it was only ever right if the dashboard
   happened to run inside the project checkout. Reading branches from the
   configured repo makes the signal correct by construction.

Implementation: `createGithubArtifactSource` / `createGithubBranchSource` in
`src/github.ts` (same never-throw / last-known-good / injected-fetch contract
as the PR source), the `listArtifacts` seam in `src/collectors/pipeline.ts`,
and env wiring in `src/runtime.ts` (`resolvePipelineSources`, read once per
`createRuntime`).
