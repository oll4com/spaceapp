import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  codex: vi.fn(),
  agy: vi.fn(),
  claude: vi.fn(),
  apiProviders: vi.fn(),
}));
vi.mock("../src/api.js", () => ({
  api: {
    toolbarUsageAccounts: mocks.codex,
    toolbarAntigravityUsageAccounts: mocks.agy,
    toolbarClaudeUsageAccounts: mocks.claude,
    toolbarApiProviderAccounts: mocks.apiProviders,
  },
}));
vi.mock("../src/features/user-settings/user-settings-manager.js", () => ({ saveUserSettingDebounced: vi.fn() }));
vi.mock("../src/features/desktop-widgets/audio-chime.js", () => ({ playChime: vi.fn(), getAudioContext: vi.fn() }));

import { playChime } from "../src/features/desktop-widgets/audio-chime.js";
import { AiQuotaWidget } from "../src/features/desktop-widgets/AiQuotaWidget.js";
import { getAlarmLogs } from "../src/features/desktop-widgets/alarm-log-service.js";
import { resetSharedQuotaCacheForTests } from "../src/features/desktop-widgets/shared-quota-cache.js";

const sampledAt = new Date().toISOString();
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const page = <T,>(data: T[], source: string) => ({
  data,
  pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 },
  source,
  isStale: false,
  error: null,
  checkedAt: sampledAt,
});
const claudeAccount = (id: string, fiveHour: number | null, status: "CONNECTED" | "NOT_CONNECTED" = "CONNECTED") => ({
  id,
  label: id,
  email: status === "CONNECTED" ? `${id}@example.test` : null,
  plan: status === "CONNECTED" ? "Team · Max 5x" : null,
  status,
  fiveHourRemainingPercent: fiveHour,
  fiveHourResetAt: fiveHour === 0 ? at(25) : at(200),
  weeklyRemainingPercent: status === "CONNECTED" ? 90 : null,
  weeklyResetAt: status === "CONNECTED" ? at(4 * 24 * 60) : null,
  weeklyScope: "Fable",
  sampledAt,
});
const group = (fiveHour: number | null, weekly: number | null, weeklyResetAt: string | null = null) => ({
  displayName: "Models",
  fiveHourRemainingPercent: fiveHour,
  fiveHourResetAt: null,
  weeklyRemainingPercent: weekly,
  weeklyResetAt,
});

function mockSample(claude = [claudeAccount("dev", 96), claudeAccount("ops", 85), claudeAccount("api", null, "NOT_CONNECTED")]) {
  mocks.codex.mockResolvedValue(page([
    { id: "codex-a", label: "alpha@example.test", fiveHourRemainingPercent: 80, weeklyRemainingPercent: 70, fiveHourResetAt: at(100), weeklyResetAt: at(5000), sampledAt },
    { id: "codex-b", label: "beta@example.test", fiveHourRemainingPercent: 0, weeklyRemainingPercent: 60, fiveHourResetAt: at(30), weeklyResetAt: at(5000), sampledAt },
  ], "codex"));
  mocks.agy.mockResolvedValue(page([
    { id: "agy-1", label: "gem", email: "gem@example.test", tier: "Google AI Pro", status: "CONNECTED", gemini: group(100, 0, at(3 * 24 * 60)), claude: group(null, null), sampledAt },
  ], "space-gemini-profiles"));
  mocks.claude.mockResolvedValue(page(claude, "space-claude-profiles"));
  mocks.apiProviders.mockResolvedValue(page([
    { id: "deepseek", providerId: "deepseek", label: "DeepSeek", status: "CONNECTED", balance: "$0.19", sampledAt },
    { id: "openai", providerId: "openai", label: "OpenAI", status: "UNCONFIGURED", sampledAt },
  ], "api"));
}

function renderWidget() {
  return render(
    <AiQuotaWidget
      state={{ id: "ai-quota", enabled: true, x: 100, y: 100 }}
      onPositionChange={vi.fn()}
      onToggleMinimize={vi.fn()}
      onClose={vi.fn()}
      onFocus={vi.fn()}
    />
  );
}

describe("AI Quota & Usage widget", () => {
  beforeEach(() => {
    localStorage.clear();
    resetSharedQuotaCacheForTests();
    vi.mocked(playChime).mockClear();
    mockSample();
  });

  it("shows how many accounts are ready, per provider, and when the next one returns", async () => {
    renderWidget();
    const hero = await screen.findByRole("region", { name: "Account availability" });
    await waitFor(() => expect(within(hero).getByText("3")).toBeTruthy());
    expect(within(hero).getByText("/6")).toBeTruthy();
    expect(within(hero).getByText("accounts ready now")).toBeTruthy();
    expect(within(hero).getByText("Next back: beta · Codex in 30m")).toBeTruthy();
    expect(within(hero).getByText("1 back soon")).toBeTruthy();
    expect(within(hero).getByText("1 exhausted")).toBeTruthy();

    expect(screen.getByRole("button", { name: "Codex: 1 of 2 accounts ready" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Antigravity: 0 of 1 accounts ready" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Claude: 2 of 3 accounts ready" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Claude2/3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /API providers/ }).textContent).toContain("1/2 connected");
    expect(screen.getByRole("region", { name: "Reset alerts" })).toBeTruthy();
  });

  it("opens a provider's accounts with the same cards as Resources", async () => {
    renderWidget();
    fireEvent.click(await screen.findByRole("button", { name: "Claude: 2 of 3 accounts ready" }));
    expect(screen.getByRole("tab", { name: "Claude2/3" }).getAttribute("aria-selected")).toBe("true");
    const cards = [...document.querySelectorAll<HTMLElement>(".account-quota-card")];
    expect(cards.map((card) => card.querySelector(".account-quota-title")?.textContent)).toEqual(["dev", "ops", "api"]);
    expect(within(cards[2]!).getByText("Not signed in")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Available (2)" }));
    expect(document.querySelectorAll(".account-quota-card")).toHaveLength(2);
  });

  it("chimes once when a watched account gets quota back after all were out", async () => {
    localStorage.setItem("space.desktop-widgets.config.ai-quota", JSON.stringify({ alertsEnabled: true, alertProvider: "claude" }));
    mockSample([claudeAccount("dev", 0), claudeAccount("ops", 0)]);
    renderWidget();
    expect(await screen.findByText(/All watched accounts are out of quota\. Next back: dev · Claude in 25m\./)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    mockSample([claudeAccount("dev", 100), claudeAccount("ops", 0)]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh quota now" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Quota is back")).toBeTruthy();
    expect(within(alert).getByText("Ready now: dev (Claude)")).toBeTruthy();
    expect(playChime).toHaveBeenCalledWith("pushup-alert");
    expect(getAlarmLogs()[0]).toMatchObject({ triggerSource: "quota_available_transition", provider: "claude", availableCount: 1, totalCount: 2 });

    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not chime when alerts are off and offers a manual test", async () => {
    localStorage.setItem("space.desktop-widgets.config.ai-quota", JSON.stringify({ alertsEnabled: false, alertProvider: "claude" }));
    mockSample([claudeAccount("dev", 0)]);
    renderWidget();
    await screen.findByText(/All watched accounts are out of quota/);
    mockSample([claudeAccount("dev", 100)]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh quota now" }));
    await screen.findByText("1 of 1 watched accounts ready.");
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Test alert" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(getAlarmLogs()[0]?.triggerSource).toBe("manual_test");

    const toggle = screen.getByRole("switch", { name: "Reset alerts" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    expect(JSON.parse(localStorage.getItem("space.desktop-widgets.config.ai-quota") ?? "{}").alertsEnabled).toBe(true);
  });

  it("summarises readiness when minimized and docked", async () => {
    const { container, rerender } = render(
      <AiQuotaWidget state={{ id: "ai-quota", enabled: true, x: 100, y: 100, minimized: true }} onPositionChange={vi.fn()} onToggleMinimize={vi.fn()} onClose={vi.fn()} />
    );
    expect(await screen.findByText("3/6 ready")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View alarm log" })).toBeNull();
    rerender(
      <AiQuotaWidget state={{ id: "ai-quota", enabled: true, x: 100, y: 100, minimized: true, dockedToRail: true }} onPositionChange={vi.fn()} onToggleMinimize={vi.fn()} onClose={vi.fn()} />
    );
    const rows = [...container.querySelectorAll(".ai-quota-docked-row")].map((row) => row.textContent);
    expect(rows).toEqual(["AIReady3/6", "Nextnow"]);
  });
});
