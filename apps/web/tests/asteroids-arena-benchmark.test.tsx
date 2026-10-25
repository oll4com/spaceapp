import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsteroidsArenaBenchmark } from "../src/features/benchmark/AsteroidsArenaBenchmark.js";

const catalog = {
  available: true,
  models: [
    { id: "codex/gpt-6.1-sol", displayName: "GPT-6.1-Sol", providerId: "codex" },
    { id: "codex/gpt-6-astra", displayName: "GPT-6-Astra", providerId: "codex" },
    { id: "claude/claude-opus-5-5", displayName: "Claude Opus 5.5", providerId: "claude" },
    { id: "claude/claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", providerId: "claude" },
    { id: "claude/claude-haiku-5-5", displayName: "Claude Haiku 5.5", providerId: "claude" },
    { id: "claude/claude-fable-5-1", displayName: "Claude Fable 5.1", providerId: "claude" },
    { id: "baseline/scripted-pilot", displayName: "Scripted Baseline", providerId: "baseline" }
  ],
  providers: [{ id: "claude", path: "Claude Code headless (agent-chat), effort low" }]
};

const protocol = {
  protocol: "agent-arena/2",
  tickHz: 30,
  roundSeconds: 45,
  decisionIntervalS: 1.5,
  decisionsPerRound: 30,
  decisionTimeoutS: 30,
  scoring: { rock: { "1": 50, "2": 25, "3": 10 }, hunter: 200, gunship: 350, pilotHit: 75, pilotKill: 600, pickup: 75, survivalPerSecond: 10, hullLost: -150, placement: [600, 300, 150] },
  maneuvers: ["attack", "evade", "orbit", "hold", "collect", "brake"],
  modes: {
    championship: { title: "Championship", tests: "Decision quality on an identical gauntlet.", timing: "Lockstep.", systemPrompt: "You are an autonomous starship pilot (championship prompt)." },
    duel: { title: "Real-Time Duel", tests: "Decision quality under time pressure.", timing: "Real time.", systemPrompt: "Real-time prompt" },
    shared_arena: { title: "All-in-One Arena", tests: "Multi-agent play.", timing: "Lockstep.", systemPrompt: "Shared prompt" }
  },
  sampleSnapshot: { self: { hull: 5 } },
  providers: { claude: "Claude Code headless (agent-chat), effort low", codex: "Space Gateway chat completions, reasoning effort low" }
};

const leaderboard = {
  mode: "championship",
  protocol: "agent-arena/2",
  updatedAt: "2026-10-12T08:00:00.000Z",
  runs: 1,
  roundsRecorded: 3,
  championId: "claude/claude-opus-5-5",
  rows: [
    {
      rank: 1, id: "claude/claude-opus-5-5", displayName: "Claude Opus 5.5", providerId: "claude", reference: false, rounds: 3, wins: 2, winRate: 67,
      avgScore: 5120, bestScore: 6200, totalScore: 15360, kills: { rocks: 120, drones: 40, pilots: 0 }, accuracy: 71, avgHullLost: 1.3,
      survivalRate: 100, avgSurvivalS: 45, validRate: 98, decisions: { total: 90, ok: 88, invalid: 1, timeout: 1, error: 0 },
      avgLatencyMs: 3400, p50LatencyMs: 3200, p95LatencyMs: 5100, vsBaseline: 640, degradedRounds: 0, lastPlayedAt: "2026-10-12T08:00:00.000Z"
    },
    {
      rank: 2, id: "baseline/scripted-pilot", displayName: "Scripted Baseline", providerId: "baseline", reference: true, rounds: 3, wins: 1, winRate: 33,
      avgScore: 4480, bestScore: 5000, totalScore: 13440, kills: { rocks: 100, drones: 35, pilots: 0 }, accuracy: 68, avgHullLost: 2,
      survivalRate: 67, avgSurvivalS: 41, validRate: null, decisions: { total: 90, ok: 90, invalid: 0, timeout: 0, error: 0 },
      avgLatencyMs: null, p50LatencyMs: null, p95LatencyMs: null, vsBaseline: null, degradedRounds: 0, lastPlayedAt: "2026-10-12T08:00:00.000Z"
    }
  ]
};

const liveRun = {
  id: "arena-20261012080000-championship-abc123",
  mode: "championship",
  origin: "ui",
  status: "running",
  phase: "playing",
  message: "Round 1/3 under way.",
  round: 1,
  rounds: 3,
  t: 12.5,
  tLeft: 32.5,
  decisionIndex: 8,
  decisionsPerRound: 30,
  realtime: false,
  startedAt: "2026-10-12T08:00:00.000Z",
  pilots: [
    {
      id: "claude/claude-opus-5-5", slot: 0, displayName: "Claude Opus 5.5", providerId: "claude", color: "#4dd8ff", reference: false, status: "thinking",
      hull: 4, shield: 1, bombs: 1, roundScore: 1450, runScore: 0, roundWins: 0, decisions: { total: 8, ok: 8, invalid: 0, timeout: 0, error: 0 },
      avgLatencyMs: 3100, last: { outcome: "ok", command: "attack D14 fire", note: "hunter first", latencyMs: 2900, t: 10.5 }
    },
    {
      id: "baseline/scripted-pilot", slot: 1, displayName: "Scripted Baseline", providerId: "baseline", color: "#9aa4b2", reference: true, status: "flying",
      hull: 5, shield: 2, bombs: 1, roundScore: 1200, runScore: 0, roundWins: 0, decisions: { total: 8, ok: 8, invalid: 0, timeout: 0, error: 0 },
      avgLatencyMs: null, last: { outcome: "ok", command: "hold R9 fire", note: "engaging R9", latencyMs: 0, t: 10.5 }
    }
  ],
  skipped: [{ id: "claude/claude-fable-5-1", displayName: "Claude Fable 5.1", providerId: "claude", reason: "Provider unavailable: You've hit your session limit" }],
  roundWinners: [],
  championId: null
};

let posts: Array<{ url: string; body: unknown }> = [];
let currentRun: unknown = null;

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  posts = [];
  currentRun = null;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "/api/auth/csrf") return json({ csrfToken: "token", headerName: "x-space-csrf-token" });
    if (url === "/api/asteroids/benchmark/models") return json(catalog);
    if (url === "/api/asteroids/benchmark/protocol") return json(protocol);
    if (url.startsWith("/api/cli/runtimes/cli:claude/account-profiles")) return json({ profiles: [{ profileId: "crew", displayName: "Crew" }] });
    if (url.startsWith("/api/asteroids/benchmark/leaderboard")) return json(leaderboard);
    if (url.startsWith("/api/asteroids/benchmark/runs?")) return json({ runs: [] });
    if (url.startsWith("/api/asteroids/benchmark/live")) return json({ run: currentRun, frames: [], events: [], latestSeq: 0 });
    if (init?.method === "POST" && url === "/api/asteroids/benchmark/runs") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      currentRun = liveRun;
      return json({ run: liveRun }, 202);
    }
    return json({ error: { message: `unexpected ${url}` } }, 404);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AsteroidsArenaBenchmark", () => {
  it("explains what the benchmark measures and publishes the exact prompt", async () => {
    render(<AsteroidsArenaBenchmark />);
    expect(screen.getByText("What this benchmark measures")).toBeTruthy();
    expect(screen.getByText(/Threat prediction/)).toBeTruthy();
    expect(screen.getByText(/Every decision:/)).toBeTruthy();
    expect(screen.getByText(/Why it is fair/)).toBeTruthy();
    await screen.findByText("Hunter +200");
    fireEvent.click(screen.getByRole("button", { name: /Show the exact prompt/ }));
    expect(screen.getByText(/championship prompt/)).toBeTruthy();
    expect(screen.getAllByText(/Claude Code headless/).length).toBeGreaterThan(0);
  });

  it("offers Claude as a provider and launches a server-side run with the baseline", async () => {
    render(<AsteroidsArenaBenchmark />);
    const opus = await screen.findByRole("button", { name: "Claude Opus 5.5" });
    expect(opus.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Claude Fable 5.1" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("switch", { name: /Claude/ })).toBeTruthy();
    await screen.findByRole("option", { name: "Crew (crew)" });
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("auto");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "crew" } });
    fireEvent.click(screen.getByRole("button", { name: /Launch Championship · 5 pilots × 3 rounds/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({
      mode: "championship",
      rounds: 3,
      claudeAccount: "crew",
      contestants: [
        { id: "claude/claude-opus-5-5", displayName: "Claude Opus 5.5" },
        { id: "claude/claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" },
        { id: "codex/gpt-6.1-sol", displayName: "GPT-6.1-Sol" },
        { id: "codex/gpt-6-astra", displayName: "GPT-6-Astra" },
        { id: "baseline/scripted-pilot", displayName: "Scripted Baseline" }
      ]
    });
    expect(await screen.findByText("Thinking…")).toBeTruthy();
    expect(screen.getByText(/attack D14 fire · “hunter first”/)).toBeTruthy();
    expect(screen.getByText(/Skipped \(provider unavailable, not scored\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop run" })).toBeTruthy();
  });

  it("ranks the leaderboard with agent metrics and the baseline as reference", async () => {
    render(<AsteroidsArenaBenchmark />);
    const table = await screen.findByRole("table");
    await within(table).findByText("5120");
    expect(within(table).getByText("98%")).toBeTruthy();
    expect(within(table).getByText("+640")).toBeTruthy();
    expect(within(table).getByText("reference")).toBeTruthy();
    expect(within(table).getByText("3.4 s / 5.1 s")).toBeTruthy();
    expect(screen.getByText(/Champion:/).textContent).toContain("Claude Opus 5.5");
  });
});
