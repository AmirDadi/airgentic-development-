# Agent Team Dashboard

See [`docs/PRD.md`](docs/PRD.md) for the product requirements and
[`docs/agentdashboardplan.md`](docs/agentdashboardplan.md) for the technical
plan.

## Structure

- `backend/` — Fastify + TypeScript service (collectors, SQLite store, REST
  + SSE API).
- `frontend/` — Vite + React + Tailwind dashboard UI.
- `docs/` — PRD and technical plan.

## Local development

```bash
cd backend && npm install && npm run dev   # http://localhost:8787/health
cd frontend && npm install && npm run dev  # http://localhost:5173
```
