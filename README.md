# Agent Team Dashboard

See [`docs/PRD.md`](docs/PRD.md) for the product requirements and
[`docs/agentdashboardplan.md`](docs/agentdashboardplan.md) for the technical
plan.

## Structure

- `backend/` — Fastify + TypeScript service (collectors, SQLite store, REST
  + SSE API).
- `frontend/` — Vite + React + Tailwind dashboard UI.
- `docs/` — PRD and technical plan.

## Running it

The dashboard is served from the same origin as its API — the UI fetches
relative paths, so it needs one URL, not two.

```bash
cd frontend && npm install && npm run build   # produces frontend/dist
cd backend  && npm install && npm run build && npm start
# open http://localhost:8787
```

The backend serves `frontend/dist` when it exists; set `UI_DIR` to override.
Without a build it runs API-only and logs a warning.

### Development (hot reload)

```bash
cd backend  && npm run dev    # API on :8787
cd frontend && npm run dev    # UI on :5173, proxying API paths to :8787
# open http://localhost:5173
```

The Vite dev proxy is what makes the relative fetches reach the backend; set
`DASHBOARD_API` if the backend is not on :8787.

### Checks

```bash
npm test                                             # in either workspace
npm run validate:transcripts -- ~/.claude/projects   # backend: parser vs a real corpus
```
