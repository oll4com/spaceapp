import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChessBenchmark, defaultChessSelection } from "../src/features/benchmark/ChessBenchmark.js";
import { boardFromFen } from "../src/features/benchmark/ChessBoard.js";

const contestants = [
  { id: "codex/sol@low", modelId: "codex/sol", providerId: "codex", modelName: "Sol", reasoningEffort: "low", displayName: "Sol · low" },
  { id: "codex/sol@high", modelId: "codex/sol", providerId: "codex", modelName: "Sol", reasoningEffort: "high", displayName: "Sol · high" },
  { id: "codex/luna@low", modelId: "codex/luna", providerId: "codex", modelName: "Luna", reasoningEffort: "low", displayName: "Luna · low" },
  { id: "openrouter/free@default", modelId: "openrouter/free", providerId: "openrouter", modelName: "Free router", reasoningEffort: "default", displayName: "Free router" },
];

const catalog = {
  contestants,
  providers: [
    { id: "codex", name: "Codex", available: true, count: 3, requestLimit: 4 },
    { id: "opencode", name: "OpenCode", available: false, count: 0, requestLimit: 2, note: "No verified runtime" },
    { id: "openrouter", name: "OpenRouter", available: true, count: 1, requestLimit: 2 },
  ],
  generatedAt: "2026-10-11T00:00:00.000Z",
};

function standing(id: string, rank: number, points: number) {
  const contestant = contestants.find((candidate) => candidate.id === id)!;
  return {
    id, rank, contestant, points, wins: points, draws: 0, losses: 1 - points, byes: 0, games: 1, elo: 1500 + points * 12,
    buchholz: 0, modelMoves: 10, illegalReplies: 0, fallbackMoves: 0, forfeits: 0, totalLatencyMs: 50_000,
  };
}

const running = {
  id: "chess-1",
  status: "running",
  active: true,
  createdAt: "2026-10-11T00:00:00.000Z",
  completedAt: null,
  settings: { format: "swiss", rounds: 2, moveTimeoutMs: 30_000, maxPlies: 60, concurrency: 16 },
  error: null,
  round: 1,
  totalRounds: 2,
  totals: { games: 4, finished: 1, running: 1, pending: 2, plies: 31 },
  standings: [standing("codex/sol@high", 1, 1), standing("codex/luna@low", 2, 0)],
  liveGames: [
    {
      id: "r1-g2", round: 1, white: "codex/sol@low", black: "openrouter/free@default", status: "running", result: null, reason: null,
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2", thinking: "w", strikes: { w: 0, b: 1 },
      lastNote: "Black timed out: random legal move (strike 1/3)", plies: 2, recentSan: ["e4", "e5"], lastUci: "e7e5",
    },
    {
      id: "r1-g3", round: 1, white: "codex/luna@low", black: "codex/sol@high", status: "running", result: null, reason: null,
      fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", thinking: "w", queued: true, strikes: { w: 0, b: 0 },
      lastNote: null, plies: 0, recentSan: [], lastUci: null,
    },
  ],
  recentGames: [
    {
      id: "r1-g1", round: 1, white: "codex/sol@high", black: "codex/luna@low", status: "finished", result: "1-0", reason: "checkmate",
      fen: "8/8/8/8/8/8/8/8 w - - 0 1", thinking: null, strikes: { w: 0, b: 0 }, lastNote: null, plies: 29, recentSan: ["Qh7#"], lastUci: "h5h7",
    },
  ],
};

let posts: Array<{ url: string; body: unknown }> = [];
let tournament: unknown = null;
let catalogResponse: unknown = catalog;

beforeEach(() => {
  posts = [];
  tournament = null;
  catalogResponse = catalog;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/auth/csrf") return json({ csrfToken: "token", headerName: "x-space-csrf-token" });
    if (url === "/api/chess/benchmark/contestants") return json(catalogResponse);
    if (url === "/api/chess/benchmark/providers/check") {
      posts.push({ url, body: JSON.parse(String(init?.body)) });
      const checked = {
        ...catalog,
        checking: false,
        providers: catalog.providers.map((provider) =>
          provider.id === "openrouter"
            ? { ...provider, check: { ok: false, latencyMs: 900, contestantId: "openrouter/free@default", error: "HTTP 429", checkedAt: "" } }
            : provider.id === "codex"
            ? { ...provider, check: { ok: true, latencyMs: 3100, contestantId: "codex/sol@low", error: null, checkedAt: "" } }
            : provider
        ),
      };
      catalogResponse = checked;
      return new Response(JSON.stringify({ ...catalog, checking: true }), { status: 202, headers: { "content-type": "application/json" } });
    }
    if (url === "/api/chess/benchmark/tournament") return json({ tournament });
    if (url.startsWith("/api/chess/benchmark/games/")) return json({ game: { ...running.recentGames[0], san: ["e4", "e5"], uci: ["e2e4", "e7e5"] } });
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      tournament = running;
      return json({ tournament });
    }
    return new Response("{}", { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ChessBenchmark", () => {
  it("lists every model with its reasoning levels and launches the selected field", async () => {
    render(<ChessBenchmark />);
    await screen.findByText("Sol");
    expect(screen.getByText("Luna")).toBeTruthy();
    expect(screen.getByText("Contestants (4 selected of 4 shown)")).toBeTruthy();
    expect(screen.getByText("No verified runtime")).toBeTruthy();

    // Turning a reasoning level off hides its contestants.
    fireEvent.click(screen.getByRole("switch", { name: "Reasoning level high" }));
    expect(screen.getByText("Contestants (3 selected of 3 shown)")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Reasoning level high" }));

    fireEvent.click(screen.getByRole("button", { name: "Round robin" }));
    fireEvent.click(screen.getByRole("button", { name: "Bullet 15s" }));
    expect(screen.getByText(/4 contestants · 6 games · up to 360 model calls · 6 moves at a time/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Launch tournament (4)" }));
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({
      url: "/api/chess/benchmark/tournament/start",
      body: {
        contestantIds: ["codex/sol@low", "codex/sol@high", "codex/luna@low", "openrouter/free@default"],
        format: "round_robin",
        moveTimeoutMs: 15_000,
        maxPlies: 60,
        concurrency: 16,
      },
    });
  });

  it("shows live boards, standings and results of a running tournament", async () => {
    tournament = running;
    render(<ChessBenchmark />);
    expect(await screen.findByText("Live · round 1/2")).toBeTruthy();
    expect(screen.getByLabelText("Live games")).toBeTruthy();
    expect(screen.getByText("Black timed out: random legal move (strike 1/3)")).toBeTruthy();
    expect(screen.getByText("Checkmate")).toBeTruthy();
    expect(screen.getByText("queued")).toBeTruthy();
    expect(screen.getByText("thinking")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tournament in progress…" }).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "View" }));
    });
    await waitFor(() => expect(screen.getByText("1. e4 e5")).toBeTruthy());
  });

  it("checks providers and switches off the ones that failed", async () => {
    render(<ChessBenchmark />);
    await screen.findByText("Sol");
    expect(screen.getByRole("switch", { name: "OpenRouter provider" })).toHaveProperty("checked", true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check providers" }));
    });
    expect(screen.getByRole("button", { name: "Checking providers…" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("switch", { name: "OpenRouter provider" })).toHaveProperty("checked", false), { timeout: 5_000 });
    expect(screen.getByText("Check failed: HTTP 429")).toBeTruthy();
    expect(screen.getByText("3 contestants · check ok in 3.1 s")).toBeTruthy();
    expect(screen.getByText("Contestants (3 selected of 3 shown)")).toBeTruthy();
  });

  it("applies the Quick and Full presets", async () => {
    render(<ChessBenchmark />);
    await screen.findByText("Sol");
    fireEvent.click(screen.getByRole("button", { name: "Quick" }));
    expect(screen.getByRole("switch", { name: "Reasoning level high" })).toHaveProperty("checked", false);
    expect(screen.getByRole("switch", { name: "Reasoning level low" })).toHaveProperty("checked", true);
    expect(screen.getByText(/3 contestants · 2 games · 2 rounds · up to 80 model calls/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Full" }));
    expect(screen.getByRole("switch", { name: "Reasoning level high" })).toHaveProperty("checked", true);
    expect(screen.getByText(/4 contestants · 6 games · 3 rounds · up to 360 model calls/)).toBeTruthy();
  });

  it("selects small catalogs in full and only the first model of large ones", () => {
    const big = Array.from({ length: 13 }, (_, index) => ({
      id: `cursor/m${index}@default`, modelId: `cursor/m${index}`, providerId: "cursor", modelName: `M${index}`, reasoningEffort: "default", displayName: `M${index}`,
    }));
    const selection = defaultChessSelection([...contestants, ...big]);
    expect(selection.has("codex/sol@high")).toBe(true);
    expect(selection.has("cursor/m0@default")).toBe(true);
    expect(selection.has("cursor/m1@default")).toBe(false);
    expect(selection.size).toBe(contestants.length + 1);
  });

  it("reads piece placement from FEN", () => {
    const board = boardFromFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1");
    expect(board[4]).toBe("K");
    expect(board[28]).toBe("P");
    expect(board[12]).toBe("");
    expect(board[60]).toBe("k");
  });
});
