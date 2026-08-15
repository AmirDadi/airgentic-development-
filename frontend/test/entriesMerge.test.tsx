import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App";
import type { ApiClient } from "../src/api";
import type { Agent, StoredEntry } from "../src/types";

const agent: Agent = {
  name: "payments",
  kind: "node",
  workdir: "/srv/payments",
  alive: true,
  last_seen: 1_000,
  current_activity: "running tests",
};

function entry(i: number): StoredEntry {
  return {
    id: `e${i}`,
    agent: "payments",
    ts: 1_000 + i,
    kind: "assistant_text",
    entry: { kind: "assistant_text", ts: 1_000 + i, text: `line ${i}` },
    session_id: "s1",
  };
}

function fakeApi(entries: StoredEntry[]): ApiClient {
  return {
    agents: vi.fn(async () => [agent]),
    features: vi.fn(async () => []),
    threads: vi.fn(async () => []),
    events: vi.fn(async () => []),
    agentEntries: vi.fn(async () => entries),
  } as unknown as ClientLike as ApiClient;
}
type ClientLike = ApiClient;

describe("live entries frames vs. the history already on screen", () => {
  it("keeps older entries that a capped SSE frame omits", async () => {
    // The backend caps each broadcast at the newest 200 entries, but the
    // initial REST snapshot returns everything it retains (up to 500). If a
    // frame REPLACES state, entries the user is currently reading vanish the
    // moment the agent says anything.
    let emit: ((e: { data: string }) => void) | undefined;
    const factory = () => ({
      addEventListener(type: string, cb: (e: { data: string }) => void) {
        if (type === "entries") emit = cb;
      },
      close() {},
    });

    const initial = Array.from({ length: 300 }, (_, i) => entry(i));
    render(
      <App api={fakeApi(initial)} liveFactory={factory} now={2_000} />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "payments" }));
    await screen.findByText("line 0");
    expect(screen.getByText("line 299")).toBeInTheDocument();

    // A capped frame: newest 200 (100..299) plus one genuinely new entry.
    emit!({
      data: JSON.stringify({
        agent: "payments",
        entries: [
          ...Array.from({ length: 200 }, (_, i) => entry(i + 100)),
          entry(300),
        ],
      }),
    });

    await waitFor(() => expect(screen.getByText("line 300")).toBeInTheDocument());

    // The new entry arrived AND the older history survived.
    expect(screen.getByText("line 0")).toBeInTheDocument();
    expect(screen.getByText("line 99")).toBeInTheDocument();
  });

  it("does not duplicate entries the frame re-sends", async () => {
    let emit: ((e: { data: string }) => void) | undefined;
    const factory = () => ({
      addEventListener(type: string, cb: (e: { data: string }) => void) {
        if (type === "entries") emit = cb;
      },
      close() {},
    });

    render(
      <App api={fakeApi([entry(1)])} liveFactory={factory} now={2_000} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "payments" }));
    await screen.findByText("line 1");

    emit!({
      data: JSON.stringify({ agent: "payments", entries: [entry(1), entry(2)] }),
    });

    await waitFor(() => expect(screen.getByText("line 2")).toBeInTheDocument());
    expect(screen.getAllByText("line 1")).toHaveLength(1);
  });
});

describe("initial snapshot vs. an SSE frame that arrives first", () => {
  it("does not let a slow REST snapshot overwrite newer live entries", async () => {
    // Opening an agent starts a REST fetch. If a live frame lands while that
    // fetch is still in flight, the snapshot is already stale by the time it
    // resolves — replacing state with it makes output the user just watched
    // arrive disappear again.
    let emit: ((e: { data: string }) => void) | undefined;
    const factory = () => ({
      addEventListener(type: string, cb: (e: { data: string }) => void) {
        if (type === "entries") emit = cb;
      },
      close() {},
    });

    const api = {
      agents: vi.fn(async () => [agent]),
      features: vi.fn(async () => []),
      threads: vi.fn(async () => []),
      events: vi.fn(async () => []),
      // Slow: resolves with the PRE-frame snapshot after the frame lands.
      agentEntries: vi.fn(
        () =>
          new Promise<StoredEntry[]>((resolve) =>
            setTimeout(() => resolve([entry(1)]), 60),
          ),
      ),
    } as unknown as ApiClient;

    render(<App api={api} liveFactory={factory} now={2_000} />);
    await userEvent.click(await screen.findByRole("button", { name: "payments" }));

    // Live frame arrives while the snapshot request is still outstanding.
    emit!({
      data: JSON.stringify({ agent: "payments", entries: [entry(1), entry(2)] }),
    });
    await screen.findByText("line 2");

    // ...and must still be there once the stale snapshot resolves.
    await new Promise((r) => setTimeout(r, 120));
    expect(screen.getByText("line 2")).toBeInTheDocument();
    expect(screen.getByText("line 1")).toBeInTheDocument();
  });
});
