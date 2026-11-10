import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ codex: vi.fn(), agy: vi.fn(), claude: vi.fn(), apiProviders: vi.fn(), tokenUsage: vi.fn() }));
vi.mock("../src/api.js", () => ({
  api: {
    toolbarUsageAccounts: mocks.codex,
    toolbarAntigravityUsageAccounts: mocks.agy,
    toolbarClaudeUsageAccounts: mocks.claude,
    toolbarApiProviderAccounts: mocks.apiProviders,
    nousTokenUsage: mocks.tokenUsage,
  },
}));

import { cliAccountForecasts } from "../src/features/cli-accounts/cli-account-availability.js";
import { providerQuotaAtReset } from "../src/features/desktop-widgets/quota-overview.js";
import { NousQuotas } from "../src/features/nous/NousQuotas.js";
import { peekSharedQuotaMetrics, resetSharedQuotaCacheForTests } from "../src/features/desktop-widgets/shared-quota-cache.js";

const sampledAt = new Date().toISOString();
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const page = <T,>(data: T[], source: string) => ({
  data, pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 }, source, isStale: false, error: null, checkedAt: sampledAt,
});
const group = (fiveHour: number | null, weekly: number | null) => ({
  displayName: "Models", fiveHourRemainingPercent: fiveHour, fiveHourResetAt: null, weeklyRemainingPercent: weekly, weeklyResetAt: at(3 * 24 * 60),
});

describe("Nous Quotas view (operator 2026-10-29, plan clipboard:4pyungpPsrfD)", () => {
  beforeEach(() => {
    resetSharedQuotaCacheForTests();
    const figures = (requests: number, inputTokens: number, outputTokens: number, costUsd: number) => ({ requests, inputTokens, cachedInputTokens: Math.round(inputTokens * 0.9),
      cacheCreationTokens: 0, outputTokens, costUsd });
    mocks.tokenUsage.mockImplementation(async (period: string) => ({ period, timeZone: "Asia/Bangkok", since: "2026-11-04T17:00:00.000Z", until: "2026-11-05T10:00:00.000Z",
      previousSince: "2026-11-03T17:00:00.000Z", previousUntil: "2026-11-04T10:00:00.000Z", totals: figures(300, 60_000_000, 200_000, 40), previousTotals: figures(500, 120_000_000, 300_000, 80),
      processes: [{ key: "mode:APP_STUDIO", label: "App Studio", kind: "copilot", detail: "1 pane", ...figures(200, 40_000_000, 100_000, 30) },
        { key: "nous:INBOX", label: "Nous · inbox turns", kind: "nous", detail: null, ...figures(100, 20_000_000, 100_000, 10) }],
      providers: [{ key: "CLAUDE", ...figures(300, 60_000_000, 200_000, 40) }],
      days: [{ day: "2026-11-05", providers: { CLAUDE: 60_200_000 } }], risers: [{ key: "nous:INBOX", label: "Nous · inbox turns", kind: "nous", tokens: 20_100_000, before: 5_000_000 }] }));
    mocks.codex.mockResolvedValue(page([
      { id: "codex-a", label: "alpha@example.test", fiveHourRemainingPercent: 80, weeklyRemainingPercent: 70, fiveHourResetAt: at(100), weeklyResetAt: at(5000), sampledAt },
      { id: "codex-b", label: "beta@example.test", fiveHourRemainingPercent: 0, weeklyRemainingPercent: 60, fiveHourResetAt: at(30), weeklyResetAt: at(5000), sampledAt },
    ], "codex"));
    mocks.agy.mockResolvedValue(page([
      { id: "agy-1", label: "gem", email: "gem@example.test", tier: "Google AI Pro", status: "CONNECTED", gemini: group(0, 0), claude: group(null, null), sampledAt },
    ], "space-gemini-profiles"));
    mocks.claude.mockResolvedValue(page([
      { id: "dev", label: "dev", email: "dev@example.test", plan: "Team · Max 5x", status: "CONNECTED", fiveHourRemainingPercent: 96, fiveHourResetAt: at(200),
        weeklyRemainingPercent: 90, weeklyResetAt: at(4 * 24 * 60), weeklyScope: "Fable", sampledAt },
    ], "space-claude-profiles"));
    mocks.apiProviders.mockResolvedValue(page([
      { id: "anthropic", providerId: "anthropic", label: "Claude API (Anthropic)", status: "CONNECTED", balance: "$41.20",
        detail: "Today $1.10 · 7 days $8.80 · This month $23.40", sampledAt },
      { id: "openai", providerId: "openai", label: "OpenAI", status: "UNCONFIGURED", sampledAt },
      { id: "vercel", providerId: "vercel", label: "Vercel AI Gateway", status: "CONNECTED", balance: "$4.77",
        detail: "Credits: $4.77 · Account: owner@example.test (Limited tier)", sampledAt },
    ], "api"));
  });

  it("shows one card per provider and the API spend, never an account list", async () => {
    render(<NousQuotas active />);
    const view = await screen.findByRole("region", { name: "Quotas" });
    await waitFor(() => expect(view.querySelectorAll(".aiq-provider")).toHaveLength(3));
    expect([...view.querySelectorAll(".aiq-provider strong")].map((node) => node.textContent)).toEqual(["Codex", "Antigravity", "Claude"]);
    const codex = view.querySelector<HTMLElement>('[data-provider="codex"]')!;
    // Per provider only (operator 6/11): each window's next reset, no count, name or e-mail of an account.
    expect(within(codex).getByText("resets in 30m")).toBeTruthy();
    expect(view.textContent).not.toMatch(/ready|Next back|Every account|example\.test|beta|accounts?\b/);
    expect(view.querySelector(".aiq-ring")).toBeNull();
    expect(within(view).getByText("API providers · 2/2 connected · $45.97")).toBeTruthy();
    expect(within(view).getByText("Credits: $4.77 · (Limited tier)")).toBeTruthy();
    expect(within(view).getByText("Today $1.10 · 7 days $8.80 · This month $23.40")).toBeTruthy();
    // API keys: what is left now (no weekly reset).
    expect(within(view).getByText("$41.20 left")).toBeTruthy();
    // A provider without a key is not in this installation (plan clipboard:sJpyQIBFGszW).
    expect(within(view).queryByText("No key")).toBeNull();
    // Aggregated only: no account cards, no provider buttons, no reset alerts.
    expect(view.querySelector(".account-quota-card, .aiq-alerts, button.aiq-provider")).toBeNull();
    expect(within(view).queryByText(/alpha/)).toBeNull();

    fireEvent.click(within(view).getByRole("button", { name: "Refresh quotas now" }));
    await waitFor(() => expect(mocks.codex).toHaveBeenCalledTimes(2));
  });

  it("leaves out API providers with nothing left to spend and lists Space Gateway's key pools (operator 6/11 21:49 BKK, nous_msg:71a41c2e)", async () => {
    mocks.apiProviders.mockResolvedValue(page([
      { id: "anthropic", providerId: "anthropic", label: "Claude API (Anthropic)", status: "CONNECTED", balance: "$41.20", sampledAt },
      // DeepSeek at $0 (still "available"), OpenRouter at $0 on its free daily requests, Vercel below zero: all out.
      { id: "deepseek", providerId: "deepseek", label: "DeepSeek", status: "CONNECTED", balance: "$0.00", sampledAt },
      { id: "openrouter", providerId: "openrouter", label: "OpenRouter", status: "CONNECTED", balance: "$0.00", sampledAt },
      { id: "vercel-gateway", providerId: "vercel-gateway", label: "Vercel AI Gateway", status: "EXHAUSTED", balance: "$-3.20", sampledAt },
      // The API lists only the pools Space Gateway serves (a paused one is never sent).
      { id: "gateway-adaption", providerId: "adaption", label: "Adaption Labs", status: "CONNECTED", balance: null, detail: "Space Gateway key pool", sampledAt },
      { id: "gateway-nvidia", providerId: "nvidia", label: "NVIDIA NIM", status: "CONNECTED", balance: null, detail: "Space Gateway key pool", sampledAt },
    ], "api"));
    render(<NousQuotas active />);
    const view = await screen.findByRole("region", { name: "Quotas" });
    expect(await within(view).findByText("API providers · 3/3 connected · $41.20")).toBeTruthy();
    expect(within(view).getByText("Adaption Labs")).toBeTruthy();
    expect(within(view).getByText("NVIDIA NIM")).toBeTruthy();
    expect(view.textContent).not.toMatch(/DeepSeek|OpenRouter|Vercel/);
  });

  // Plan clipboard:FDitYcI63D9R (operator 31/10 16:54 BKK): each card shows the pane account menu's "free at reset" (the picker module is
  // only read here, it is Alex/Dana's), labelled apart from the bars' "left now"; a provider that reports no week says unknown.
  it("shows the share free at the weekly reset, the same figure as the account menus", async () => {
    mocks.agy.mockResolvedValue(page([
      { id: "agy-1", label: "gem", email: "gem@example.test", tier: "Google AI Pro", status: "CONNECTED", gemini: group(null, null), claude: group(null, null), sampledAt },
    ], "space-gemini-profiles"));
    render(<NousQuotas active />);
    const view = await screen.findByRole("region", { name: "Quotas" });
    await waitFor(() => expect(view.querySelectorAll(".aiq-provider")).toHaveLength(3));
    const card = (provider: string) => view.querySelector<HTMLElement>(`[data-provider="${provider}"]`)!;
    const [menu] = cliAccountForecasts("cli:claude", peekSharedQuotaMetrics(), Date.now());
    const claude = card("claude").querySelector<HTMLElement>(".quota-at-reset")!;
    expect(claude.textContent).toBe(`At reset${Math.round(menu!.percent!)}% free ${menu!.resetWhen} · under pace`);
    expect(claude.querySelector("b")!.getAttribute("style")).toContain("color");
    expect(within(card("claude")).getByText("Left now")).toBeTruthy();
    expect(card("codex").querySelector(".quota-at-reset")!.textContent).toMatch(/^At reset\d+% free at .+ · (ahead of|on|under) pace$/);
    expect(card("antigravity").querySelector(".quota-at-reset")!.textContent).toBe("At resetunknown (no weekly usage reported)");
  });

  it("says why a provider has no figure at reset", () => {
    const clock = Date.now();
    const claude = (status: string, weeklyResetAt: string | null) => page([{ id: "a", label: "a", email: null, plan: null, status, fiveHourRemainingPercent: 50,
      fiveHourResetAt: null, weeklyRemainingPercent: 40, weeklyResetAt, weeklyScope: null, sampledAt }], "claude") as never;
    const reason = (list: unknown) => providerQuotaAtReset("claude", { codex: null, agy: null, claude: list as never }, clock).unknown;
    expect(reason(null)).toBe("not read yet");
    expect(reason(claude("EXPIRED", at(600)))).toBe("no connected account");
    expect(reason(claude("CONNECTED", null))).toBe("no weekly reset time reported");
    // Dev's copied gateway rows (31/10): weeks that reset days ago.
    expect(reason(claude("CONNECTED", at(-3 * 24 * 60)))).toBe("weekly sample out of date");
    expect(providerQuotaAtReset("claude", { codex: null, agy: null, claude: claude("CONNECTED", at(600)) }, clock)).toMatchObject({ unknown: null, entries: [{ accounts: 1 }] });
  });

  // Operator 5/11 17:26 BKK (plan clipboard:qH5emwVaV6yO): who consumed the tokens, per process and provider (never per account, operator 6/11), day, week or month.
  it("shows token usage by process and provider, no account bars, the change and the risers, per period", async () => {
    render(<NousQuotas active />);
    const usage = await screen.findByRole("region", { name: "Token usage" });
    await waitFor(() => expect(within(usage).getByText("App Studio")).toBeTruthy());
    expect(mocks.tokenUsage).toHaveBeenLastCalledWith("day");
    expect(usage.querySelector(".nous-load-percent")!.textContent).toBe("60.2M");
    expect(within(usage).getByText("▼ 50% against the same span before (120.3M)")).toBeTruthy();
    expect(within(usage.querySelector<HTMLElement>('[aria-label="By process"]')!).getByText(/66\.6% · 200 req · 200k\/req · \$30\.00 · 1 pane/)).toBeTruthy();
    expect(usage.querySelector('[aria-label="By account"]')).toBeNull();
    expect(within(usage).getByText("5.0M → 20.1M")).toBeTruthy();
    fireEvent.click(within(usage).getByRole("button", { name: "Week" }));
    await waitFor(() => expect(mocks.tokenUsage).toHaveBeenLastCalledWith("week"));
  });
});
