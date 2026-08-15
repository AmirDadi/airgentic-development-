import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app fetches same-origin relative paths (`/agents`, `/live`), so in dev
// these must reach the backend. Without this proxy Vite's SPA fallback answers
// them with index.html and a 200, the client fails to parse HTML as JSON, and
// the dashboard shows "backend unreachable" forever.
const API_PATHS = [
  "/health",
  "/agents",
  "/features",
  "/events",
  "/messages",
  "/threads",
  "/ingest",
  // Prefix-matched, so this also covers `/chat/history`.
  "/chat",
  "/live",
];

const target = process.env.DASHBOARD_API ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      // `/live` is SSE: it must not be buffered, so streaming stays streaming.
      API_PATHS.map((p) => [p, { target, changeOrigin: true, ws: false }]),
    ),
  },
});
