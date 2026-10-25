import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliAccountProfile } from "@space/contracts";

const mocks = vi.hoisted(() => ({
  codex: vi.fn(),
  agy: vi.fn(),
  claude: vi.fn(),
  apiProviders: vi.fn(),
  identities: vi.fn(),
  balance: vi.fn(),
}));
vi.mock("../src/api.js", () => ({
  api: {
    toolbarUsageAccounts: mocks.codex,
    toolbarAntigravityUsageAccounts: mocks.agy,
    toolbarClaudeUsageAccounts: mocks.claude,
    toolbarApiProviderAccounts: mocks.apiProviders,
    cliAccountIdentities: mocks.identities,
    cliAccountBalance: mocks.balance,
  },
}));

import { CliAccountPicker } from "../src/features/cli-accounts/CliAccountPicker.js";
import { CodexAccountPicker } from "../src/features/cli-accounts/CodexAccountPicker.js";
import {
  antigravityModelGroup,
  CLI_ACCOUNT_BLOCKED_COLOR,
  CLI_ACCOUNT_OFF_COLOR,
  cliAccountAvailability,
  cliAccountAvailabilityColor,
  cliAccountPlan,
  cliAccountPool,
  cliAccountWeeklyForecast,
} from "../src/features/cli-accounts/cli-account-availability.js";
import { resetCliAccountBalanceForTests } from "../src/features/cli-accounts/cli-account-balance.js";
import { resetCliAccountIdentitiesForTests } from "../src/features/cli-accounts/cli-account-identities.js";
import { resetSharedQuotaCacheForTests, type SharedQuotaCache } from "../src/features/desktop-widgets/shared-quota-cache.js";
import { watchedQuota } from "../src/features/desktop-widgets/quota-overview.js";
import { claudeAccountEntries } from "../src/features/toolbar-metrics/account-entries.js";

const sampledAt = new Date().toISOString();
// One fixed now for reset times and the clock: a millisecond between them rounded "Back in 40m" up to 41m on CI.
const NOW = Date.now();
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const page = <T,>(data: T[], source: string) => ({
  data,
  pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 },
  source,
  isStale: false,
  error: null,
  checkedAt: sampledAt,
});
const claudeAccount = (id: string, fiveHour: number | null, weekly: number | null, status: "CONNECTED" | "NOT_CONNECTED" = "CONNECTED") => ({
  id,
  label: id,
  email: `${id}@example.test`,
  plan: "Team",
  status,
  fiveHourRemainingPercent: fiveHour,
  fiveHourResetAt: at(90),
  weeklyRemainingPercent: weekly,
  weeklyResetAt: at(4 * 24 * 60),
  weeklyScope: null,
  sampledAt,
});
const profile = (profileId: string): CliAccountProfile => ({
  runtimeId: "cli:claude",
  profileId,
  displayName: profileId,
  createdAt: sampledAt,
  updatedAt: sampledAt,
  updatedBy: null,
});
const hue = (color: string) => Number(/^hsl\((\d+)/.exec(color)?.[1]);

function quotaSample(claude: ReturnType<typeof claudeAccount>[]): SharedQuotaCache {
  return { codex: null, agy: null, claude: page(claude, "space-claude-profiles"), api: null, fetchedAt: Date.now() };
}

describe("CLI account availability colours", () => {
  it("moves continuously from orange to green with remaining quota and turns red when unusable", () => {
    const hues = [1, 25, 50, 75, 100].map((percent) => hue(cliAccountAvailabilityColor(percent)));
    for (let index = 1; index < hues.length; index += 1) expect(hues[index]!).toBeGreaterThan(hues[index - 1]!);
    expect(hues[0]).toBeGreaterThan(10);
    expect(hues.at(-1)).toBeGreaterThan(130);

    const clock = NOW;
    const quota = quotaSample([claudeAccount("ready", 82, 64), claudeAccount("limited", 0, 70), claudeAccount("signedout", null, null, "NOT_CONNECTED")]);
    const ready = cliAccountAvailability({ runtimeId: "cli:claude", profileId: "ready", quota, identity: null, clock });
    expect(ready).toMatchObject({ tone: "ready", percent: 64, label: "64%" });
    expect(ready.color).toBe(cliAccountAvailabilityColor(64));
    const limited = cliAccountAvailability({ runtimeId: "cli:claude", profileId: "limited", quota, identity: null, clock });
    expect(limited).toMatchObject({ tone: "blocked", color: CLI_ACCOUNT_BLOCKED_COLOR });
    expect(limited.label).toMatch(/^Back in /);
    expect(cliAccountAvailability({ runtimeId: "cli:claude", profileId: "signedout", quota, identity: null, clock }))
      .toMatchObject({ tone: "blocked", color: CLI_ACCOUNT_BLOCKED_COLOR, label: "Not signed in" });
    // Before the first quota sample a signed-in Claude account is still being checked.
    expect(cliAccountAvailability({
      runtimeId: "cli:claude",
      profileId: "ready",
      quota: null,
      identity: { runtimeId: "cli:claude", profileId: "ready", displayName: "ready", email: null, authStatus: "CONNECTED" },
      clock,
    })).toMatchObject({ tone: "pending", label: "Checking…" });
    // CLIs without quota reports fall back to their sign-in status.
    expect(cliAccountAvailability({
      runtimeId: "cli:cursor",
      profileId: "main",
      quota,
      identity: { runtimeId: "cli:cursor", profileId: "main", displayName: "Main", email: null, authStatus: "NOT_CONNECTED" },
      clock,
    })).toMatchObject({ tone: "blocked", label: "Not signed in" });
  });
});

describe("weekly forecast", () => {
  it("projects this week's pace of the subscription accounts to their reset", () => {
    const clock = NOW;
    // Each fixture week resets in 4 days, so 3 of its 7 days have passed.
    const stale = { ...claudeAccount("stale", 90, 10), weeklyResetAt: at(-60) };
    const quota = quotaSample([claudeAccount("paced", 90, 80), claudeAccount("spent", 0, 0), claudeAccount("out", null, 30, "NOT_CONNECTED"), stale]);
    // paced: 20 used + 20/3 a day for 4 days; spent stays at 100 until it resets; signed-out and stale weeks are left out.
    const forecast = cliAccountWeeklyForecast("cli:claude", quota, clock)!;
    expect(forecast.accounts).toBe(2);
    expect(forecast.percent).toBeCloseTo(100 - (20 + 80 / 3 + 100) / 2, 1);
    expect(forecast.color).toBe(cliAccountAvailabilityColor(forecast.percent));
    expect(forecast.resetWhen).toMatch(/^at /);

    const short = cliAccountWeeklyForecast("cli:claude", quotaSample([claudeAccount("fast", 90, 40)]), clock)!;
    expect(short).toMatchObject({ percent: 0, color: CLI_ACCOUNT_BLOCKED_COLOR });
    expect(cliAccountWeeklyForecast("cli:cursor", quota, clock)).toBeNull();
    expect(cliAccountWeeklyForecast("cli:claude", null, clock)).toBeNull();
  });
});

describe("Antigravity model groups and plans", () => {
  const group = (fiveHour: number | null, weekly: number | null) => ({
    displayName: "Models", fiveHourRemainingPercent: fiveHour, fiveHourResetAt: at(40), weeklyRemainingPercent: weekly, weeklyResetAt: at(3 * 24 * 60),
  });
  const agy = (id: string, tier: string | null, gemini: ReturnType<typeof group>, claude: ReturnType<typeof group>) => ({
    id, label: id, email: `${id}@example.test`, tier, status: "CONNECTED" as const, gemini, claude, sampledAt,
  });
  const quota: SharedQuotaCache = {
    codex: null,
    agy: page([agy("spc", "Google AI Pro", group(0, 60), group(100, 100)), agy("free", "Free", group(80, 90), group(null, null))], "agy"),
    claude: page([
      claudeAccount("team", 90, 80),
      { ...claudeAccount("api", null, null), status: "API_KEY" as never },
      { ...claudeAccount("space-gateway", null, null), status: "GATEWAY" as never },
    ], "claude"),
    api: null,
    fetchedAt: Date.now(),
  };

  it("judges an Antigravity account by the model group the pane runs", () => {
    expect(antigravityModelGroup("gemini-3.8-flash")).toBe("gemini");
    expect(antigravityModelGroup("claude-sonnet-4.6")).toBe("claude");
    expect(antigravityModelGroup("gpt-oss-120b")).toBe("claude");
    expect(antigravityModelGroup(null)).toBeNull();
    const clock = NOW;
    const onGemini = cliAccountAvailability({ runtimeId: "cli:gemini", profileId: "spc", quota, identity: null, clock, modelGroup: "gemini" });
    expect(onGemini).toMatchObject({ tone: "blocked", color: CLI_ACCOUNT_BLOCKED_COLOR });
    expect(onGemini.description).toContain("For Gemini models");
    expect(cliAccountAvailability({ runtimeId: "cli:gemini", profileId: "spc", quota, identity: null, clock, modelGroup: "claude" }))
      .toMatchObject({ tone: "ready", percent: 100 });
    // Without a known model the best group decides, and both windows stay visible.
    const best = cliAccountAvailability({ runtimeId: "cli:gemini", profileId: "spc", quota, identity: null, clock });
    expect(best).toMatchObject({ tone: "ready", percent: 100 });
    expect(best.windows.map((window) => window.label)).toEqual(["Gemini", "Claude · GPT"]);
  });

  it("judges the Antigravity Space Gateway account by the best pooled account for the pane's model group", () => {
    const clock = NOW;
    // spc is out of Gemini quota, free still has 80%: the gateway serves Gemini models from free.
    expect(cliAccountAvailability({ runtimeId: "cli:gemini", profileId: "space-gateway", quota, identity: null, clock, modelGroup: "gemini" }))
      .toMatchObject({ tone: "ready", percent: 80, detail: "1 of 2 pooled accounts ready" });
    const empty = { ...quota, agy: page([agy("spc", null, group(0, 0), group(0, 0))].map((account) => ({ ...account, status: "EXPIRED" as const })), "agy") };
    expect(cliAccountAvailability({ runtimeId: "cli:gemini", profileId: "space-gateway", quota: empty, identity: null, clock }))
      .toMatchObject({ tone: "blocked", label: "No accounts" });
  });

  it("keeps the paid API key account out of use and shows the Space Gateway account as ready", () => {
    const clock = NOW;
    expect(cliAccountAvailability({ runtimeId: "cli:claude", profileId: "api", quota, identity: null, clock }))
      .toMatchObject({ tone: "off", color: CLI_ACCOUNT_OFF_COLOR, label: "Paid · not used", detail: "Per token · only when picked by hand" });
    expect(cliAccountAvailability({ runtimeId: "cli:claude", profileId: "space-gateway", quota, identity: null, clock }))
      .toMatchObject({ tone: "ready", label: "Ready", description: "Available now · Space Gateway picks a pooled Claude account" });
  });

  it("judges the Space Gateway account by its pool and names the pooled accounts", () => {
    const clock = NOW;
    const member = (label: string, fiveHour: number | null, minutes = 40, signInRequired = false) => ({
      label, signInRequired, fiveHourRemainingPercent: fiveHour, fiveHourResetAt: at(minutes), weeklyRemainingPercent: 70, weeklyResetAt: at(3 * 24 * 60),
    });
    const withPool = (pool: ReturnType<typeof member>[]): SharedQuotaCache => ({
      ...quota, claude: page([{ ...claudeAccount("space-gateway", null, null), label: "Space Gateway (pooled)", status: "GATEWAY" as never, pool }], "claude"),
    });
    const read = (pool: ReturnType<typeof member>[]) =>
      cliAccountAvailability({ runtimeId: "cli:claude", profileId: "space-gateway", quota: withPool(pool), identity: null, clock });

    // Every pooled account at its 5-hour limit (seen live 2026-10-12): not ready, back when the first one resets.
    const limited = read([member("crew", 0, 140), member("lab", 0, 40), member("ops", 0, 170)]);
    expect(limited).toMatchObject({ tone: "blocked", label: "Back in 40m" });
    expect(limited.description).toBe("Not available now · Back in 40m · 0 of 3 pooled accounts ready");
    expect(limited.detail).toBe("0 of 3 pooled accounts ready");
    expect(read([member("crew", 0), member("lab", 64)])).toMatchObject({ tone: "ready", percent: 64, detail: "1 of 2 pooled accounts ready" });
    expect(read([member("ops", null, 40, true)])).toMatchObject({ tone: "blocked", label: "Sign-in required" });
    expect(read([])).toMatchObject({ tone: "blocked", label: "No accounts" });

    const [entry] = claudeAccountEntries(withPool([member("crew", 0, 140), member("lab", 0, 40)]).claude!.data, clock);
    expect(entry).toMatchObject({ title: "Space Gateway (pooled)", details: ["Pools crew, lab"], hint: "0 of 2 pooled accounts available now.",
      availability: { state: "soon" }, rows: [] });
    // Quota alerts count accounts, and the gateway's accounts are already listed on their own.
    expect(watchedQuota(withPool([member("lab", 64)]), clock, { provider: "claude", proOnly: false }).total).toBe(0);
  });

  it("names each account's plan", () => {
    expect(cliAccountPlan("cli:gemini", "spc", quota)).toBe("AI Pro");
    expect(cliAccountPlan("cli:gemini", "free", quota)).toBe("Free");
    expect(cliAccountPlan("cli:claude", "team", quota)).toBe("Team");
    expect(cliAccountPlan("cli:claude", "api", quota)).toBe("API key");
    // The gateway account's name already says Space Gateway, so it carries no plan badge.
    expect(cliAccountPlan("cli:claude", "space-gateway", quota)).toBeNull();
    expect(cliAccountPlan("cli:cursor", "main", quota)).toBeNull();
  });
});

const codexAccount = (id: string, fiveHour: number | null, weekly: number | null, planType: string | null = "pro") => ({
  id, label: id, planType, fiveHourRemainingPercent: fiveHour, weeklyRemainingPercent: weekly,
  fiveHourResetAt: at(90), weeklyResetAt: at(4 * 24 * 60), sampledAt,
});
const codexQuota = (accounts: ReturnType<typeof codexAccount>[] | null): SharedQuotaCache => ({
  codex: accounts ? page(accounts, "space-gateway") : null, agy: null, claude: null, api: null, fetchedAt: Date.now(),
});

describe("Codex accounts behind Space Gateway", () => {
  it("judges the gateway by the best ChatGPT account in its pool", () => {
    const clock = NOW;
    const gateway = (accounts: ReturnType<typeof codexAccount>[] | null) =>
      cliAccountAvailability({ runtimeId: "cli:codex", profileId: "space-gateway", quota: codexQuota(accounts), identity: null, clock });
    expect(gateway([codexAccount("kate", 90, 72), codexAccount("leo", 1, 80)]))
      .toMatchObject({ tone: "ready", percent: 72, label: "72%", detail: "1 of 2 pooled accounts ready" });
    const limited = gateway([codexAccount("leo", 1, 80)]);
    expect(limited).toMatchObject({ tone: "blocked", detail: "0 of 1 pooled account ready" });
    expect(limited.label).toMatch(/^Back in 1h 3\dm$/);
    expect(gateway([])).toMatchObject({ tone: "blocked", label: "No accounts" });
    expect(gateway(null)).toMatchObject({ tone: "pending", label: "Unknown" });
    expect(cliAccountAvailability({ runtimeId: "cli:codex", profileId: "space-gateway", quota: null, identity: null, clock }))
      .toMatchObject({ tone: "pending", label: "Checking…" });
    expect(cliAccountPlan("cli:codex", "space-gateway", codexQuota([codexAccount("kate", 90, 72)]))).toBeNull();
  });

  it("lists each pooled account with its plan and both quota windows", () => {
    const clock = NOW;
    const pool = cliAccountPool("cli:codex", codexQuota([codexAccount("kate", 90, 72), codexAccount("leo", 0, 80, null)]), clock)!;
    expect(pool.map((member) => [member.name, member.plan, member.availability.detail])).toEqual([
      ["kate", "Pro", "5h 90% · Week 72%"],
      ["leo", null, "5h 0% · Week 80%"],
    ]);
    expect(pool[0]!.availability).toMatchObject({ tone: "ready", label: "72%" });
    expect(pool[1]!.availability.tone).toBe("blocked");
    expect(pool[1]!.availability.label).toMatch(/^Back in /);
    expect(cliAccountPool("cli:codex", codexQuota(null), clock)).toBeNull();
    expect(cliAccountPool("cli:claude", codexQuota([codexAccount("kate", 90, 72)]), clock)).toBeNull();
  });
});

describe("CliAccountPicker", () => {
  beforeEach(() => {
    resetSharedQuotaCacheForTests();
    resetCliAccountIdentitiesForTests();
    resetCliAccountBalanceForTests();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.codex.mockResolvedValue(page([], "codex"));
    mocks.agy.mockResolvedValue(page([], "agy"));
    mocks.apiProviders.mockResolvedValue(page([], "api"));
    mocks.claude.mockResolvedValue(page([claudeAccount("ops", 90, 80), claudeAccount("lab", 0, 50)], "space-claude-profiles"));
    mocks.identities.mockResolvedValue({
      accounts: [
        { runtimeId: "cli:claude", profileId: "ops", displayName: "ops", email: "ops@example.test", authStatus: "CONNECTED" },
        { runtimeId: "cli:claude", profileId: "lab", displayName: "lab", email: "lab@example.test", authStatus: "CONNECTED" },
      ],
      checkedAt: sampledAt,
    });
  });

  it("opens the account list with one click, marks the active account and switches with a second click", async () => {
    const onSelect = vi.fn();
    render(
      <CliAccountPicker
        runtimeId="cli:claude"
        providerLabel="Claude"
        icon={<span />}
        paneTitle="Claude pane"
        profiles={[profile("ops"), profile("lab")]}
        selectedProfileId="ops"
        onSelect={onSelect}
      />
    );
    const trigger = screen.getByRole("button", { name: "Claude account for Claude pane" });
    expect(trigger.getAttribute("title")).toMatch(/^Claude account: ops/);
    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu", { name: "Claude account for Claude pane" });
    const [ops, lab] = within(menu).getAllByRole("menuitemradio");
    expect(ops!.getAttribute("aria-checked")).toBe("true");
    expect(within(ops!).getByText("Active")).toBeTruthy();
    await waitFor(() => expect(within(ops!).getByText("80%")).toBeTruthy());
    expect(within(ops!).getByText("ops@example.test")).toBeTruthy();
    expect(within(ops!).getByText("Team")).toBeTruthy();
    expect(ops!.getAttribute("data-tone")).toBe("ready");
    expect(lab!.getAttribute("data-tone")).toBe("blocked");
    expect(lab!.style.getPropertyValue("--cli-account-color")).toBe(CLI_ACCOUNT_BLOCKED_COLOR);
    expect(within(menu).getByText("1 of 2 available now")).toBeTruthy();
    // ops and lab, 3 days into their weeks with 20% and 50% used, leave about 18% at their reset.
    expect(within(menu).getByText("18%").closest(".cli-account-menu-forecast")).toBeTruthy();

    fireEvent.click(lab!);
    expect(onSelect).toHaveBeenCalledWith("lab");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows the paid API key account greyed out, still selectable by hand, and never counts it as available", async () => {
    mocks.claude.mockResolvedValue(page([
      claudeAccount("ops", 90, 80),
      { ...claudeAccount("api", null, null), email: null, plan: null, status: "API_KEY" as never },
    ], "space-claude-profiles"));
    mocks.identities.mockResolvedValue({
      accounts: [
        { runtimeId: "cli:claude", profileId: "ops", displayName: "ops", email: "ops@example.test", authStatus: "CONNECTED" },
        { runtimeId: "cli:claude", profileId: "api", displayName: "api", email: null, authStatus: "CONNECTED" },
      ],
      checkedAt: sampledAt,
    });
    const onSelect = vi.fn();
    render(
      <CliAccountPicker
        runtimeId="cli:claude"
        providerLabel="Claude"
        icon={<span />}
        paneTitle="Claude pane"
        profiles={[profile("ops"), profile("api")]}
        selectedProfileId="ops"
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Claude account for Claude pane" }));
    const menu = await screen.findByRole("menu", { name: "Claude account for Claude pane" });
    const [, api] = within(menu).getAllByRole("menuitemradio");
    await waitFor(() => expect(within(api!).getByText("Paid · not used")).toBeTruthy());
    expect(within(api!).getByText("Per token · only when picked by hand")).toBeTruthy();
    expect(api!.getAttribute("data-tone")).toBe("off");
    expect(api!.style.getPropertyValue("--cli-account-color")).toBe(CLI_ACCOUNT_OFF_COLOR);
    expect(within(menu).getByText("1 of 2 available now")).toBeTruthy();
    fireEvent.click(api!);
    expect(onSelect).toHaveBeenCalledWith("api");
  });

  it("names Space Gateway once and shows its pool in a short line instead of the long description", async () => {
    const pooled = (label: string, fiveHour: number) => ({
      label, signInRequired: false, fiveHourRemainingPercent: fiveHour, fiveHourResetAt: at(40), weeklyRemainingPercent: 70, weeklyResetAt: at(3 * 24 * 60),
    });
    mocks.claude.mockResolvedValue(page([
      claudeAccount("ops", 90, 80),
      { ...claudeAccount("space-gateway", null, null), label: "Space Gateway", email: null, plan: null, status: "GATEWAY" as never,
        pool: [pooled("crew", 34), pooled("lab", 60)] },
    ], "space-claude-profiles"));
    render(
      <CliAccountPicker
        runtimeId="cli:claude"
        providerLabel="Claude"
        icon={<span />}
        paneTitle="Claude pane"
        profiles={[profile("ops"), { ...profile("space-gateway"), displayName: "Space Gateway" }]}
        selectedProfileId="space-gateway"
        onSelect={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Claude account for Claude pane" }));
    const menu = await screen.findByRole("menu", { name: "Claude account for Claude pane" });
    const [, gateway] = within(menu).getAllByRole("menuitemradio");
    await waitFor(() => expect(within(gateway!).getByText("2 of 2 pooled accounts ready")).toBeTruthy());
    expect(within(gateway!).getByText("Space Gateway")).toBeTruthy();
    expect(gateway!.querySelector(".cli-account-plan-badge")).toBeNull();
    expect(gateway!.textContent!.match(/Space Gateway/g)).toHaveLength(1);
  });

  it("narrows the menu to the pane so a small pane or screen shows it whole", async () => {
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
    Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get() { return pane; } });
    pane.getBoundingClientRect = () => ({ left: 100, right: 340, top: 0, bottom: 400, width: 240, height: 400, x: 100, y: 0, toJSON: () => ({}) });
    try {
      render(
        <CliAccountPicker
          runtimeId="cli:claude"
          providerLabel="Claude"
          icon={<span />}
          paneTitle="Claude pane"
          profiles={[profile("ops"), profile("lab")]}
          selectedProfileId="ops"
          onSelect={vi.fn()}
        />,
        { container: pane },
      );
      const trigger = screen.getByRole("button", { name: "Claude account for Claude pane" });
      trigger.getBoundingClientRect = () => ({ left: 300, right: 330, top: 8, bottom: 36, width: 30, height: 28, x: 300, y: 8, toJSON: () => ({}) });
      fireEvent.click(trigger);
      const menu = await screen.findByRole("menu");
      expect(menu.style.maxWidth).toBe("222px");
    } finally {
      if (offsetParent) Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent);
      pane.remove();
    }
  });

  it("shows the GitHub login for Copilot accounts that report no email", async () => {
    mocks.identities.mockResolvedValue({
      accounts: [{ runtimeId: "cli:copilot", profileId: "main", displayName: "Main", email: null, login: "octo-cat", authStatus: "CONNECTED" }],
      checkedAt: sampledAt,
    });
    render(
      <CliAccountPicker
        runtimeId="cli:copilot"
        providerLabel="GitHub"
        icon={<span />}
        paneTitle="Copilot pane"
        profiles={[{ ...profile("main"), displayName: "Main" }]}
        selectedProfileId="main"
        onSelect={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "GitHub account for Copilot pane" }));
    const menu = await screen.findByRole("menu", { name: "GitHub account for Copilot pane" });
    expect(await within(menu).findByText("@octo-cat")).toBeTruthy();
    expect(within(menu).getByText("Signed in")).toBeTruthy();
  });

  it("closes on Escape without switching and does not reselect the active account", async () => {
    const onSelect = vi.fn();
    render(
      <CliAccountPicker
        runtimeId="cli:claude"
        providerLabel="Claude"
        icon={<span />}
        paneTitle="Claude pane"
        profiles={[profile("ops"), profile("lab")]}
        selectedProfileId="ops"
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Claude account for Claude pane" }));
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Claude account for Claude pane" }));
    fireEvent.click(within(await screen.findByRole("menu")).getAllByRole("menuitemradio")[0]!);
    expect(onSelect).not.toHaveBeenCalled();
  });
  it("offers Auto first for balanced CLIs and names the account Auto runs on", async () => {
    const onSelect = vi.fn();
    const onAuto = vi.fn();
    const { rerender } = render(
      <CliAccountPicker
        runtimeId="cli:copilot"
        providerLabel="GitHub"
        icon={<span />}
        paneTitle="Copilot pane"
        profiles={[profile("main"), profile("work")]}
        selectedProfileId="main"
        onSelect={onSelect}
        auto={{ active: false, onSelect: onAuto }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "GitHub account for Copilot pane" }));
    const items = within(await screen.findByRole("menu")).getAllByRole("menuitemradio");
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain("Auto (Space Gateway)");
    expect(items[1]!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(items[0]!);
    expect(onAuto).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();

    rerender(
      <CliAccountPicker
        runtimeId="cli:copilot"
        providerLabel="GitHub"
        icon={<span />}
        paneTitle="Copilot pane"
        profiles={[profile("main"), profile("work")]}
        selectedProfileId="work"
        onSelect={onSelect}
        auto={{ active: true, onSelect: onAuto }}
      />
    );
    expect(screen.getByRole("button", { name: "GitHub account for Copilot pane" }).getAttribute("title")).toContain("Auto, now work");
    fireEvent.click(screen.getByRole("button", { name: "GitHub account for Copilot pane" }));
    const menu = await screen.findByRole("menu");
    const autoItem = within(menu).getAllByRole("menuitemradio")[0]!;
    expect(autoItem.getAttribute("aria-checked")).toBe("true");
    expect(autoItem.textContent).toContain("Now on work");
    expect(within(menu).getByText("In use")).toBeTruthy();
    fireEvent.click(autoItem);
    expect(onAuto).toHaveBeenCalledTimes(1);
  });
});

describe("CodexAccountPicker", () => {
  beforeEach(() => {
    resetSharedQuotaCacheForTests();
    resetCliAccountIdentitiesForTests();
    resetCliAccountBalanceForTests();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.agy.mockResolvedValue(page([], "agy"));
    mocks.claude.mockResolvedValue(page([], "space-claude-profiles"));
    mocks.apiProviders.mockResolvedValue(page([], "api"));
  });

  it("shows Space Gateway as the pane's account and its ChatGPT accounts for their quota only", async () => {
    mocks.codex.mockResolvedValue(page([codexAccount("kate", 90, 72), codexAccount("leo", 0, 80, "plus")], "space-gateway"));
    render(<CodexAccountPicker paneTitle="Kate" />);
    const trigger = screen.getByRole("button", { name: "ChatGPT account for Kate" });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "ChatGPT account for Kate" });
    const [gateway] = within(menu).getAllByRole("menuitemradio");
    expect(gateway!.getAttribute("aria-checked")).toBe("true");
    expect(within(gateway!).getByText("Space Gateway")).toBeTruthy();
    await waitFor(() => expect(within(gateway!).getByText("1 of 2 pooled accounts ready")).toBeTruthy());
    expect(within(gateway!).getByText("72%")).toBeTruthy();
    expect(within(menu).getByText("Space Gateway picks the account")).toBeTruthy();

    const pool = within(menu).getByRole("group", { name: "Accounts Space Gateway picks from" });
    const [kate, leo] = within(pool).getAllByRole("menuitem");
    expect(kate!.getAttribute("aria-disabled")).toBe("true");
    expect(within(kate!).getByText("Pro")).toBeTruthy();
    expect(within(kate!).getByText("5h 90% · Week 72%")).toBeTruthy();
    expect(leo!.getAttribute("data-tone")).toBe("blocked");
    expect(within(leo!).getByText("Plus")).toBeTruthy();

    // Arrow keys move between choices only; the pooled accounts cannot be picked one by one.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(gateway);
    fireEvent.click(leo!);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("stays hidden once Space Gateway reports no ChatGPT accounts", async () => {
    mocks.codex.mockResolvedValue(page([], "space-gateway"));
    render(<CodexAccountPicker paneTitle="Kate" />);
    fireEvent.click(screen.getByRole("button", { name: "ChatGPT account for Kate" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "ChatGPT account for Kate" })).toBeNull());
  });
});

describe("balanced CLI accounts", () => {
  const usage = (remainingPercent: number | null, status: "OK" | "UNKNOWN" | "NOT_CONNECTED" | "GATEWAY" | "ERROR" = "OK") => ({
    status, plan: status === "OK" ? "Copilot Pro" : null, remainingPercent, resetAt: at(3 * 24 * 60),
    windows: remainingPercent === null ? [] : [{ id: "premium", label: "Premium requests", remainingPercent, resetAt: at(3 * 24 * 60) }],
  });
  const balance = (profiles: Array<[string, ReturnType<typeof usage>, string | null]>, next: string | null) => ({
    runtimeId: "cli:copilot" as const,
    profiles: profiles.map(([profileId, entryUsage, exhaustedUntil]) => ({ profileId, displayName: profileId, usage: entryUsage, exhaustedUntil,
      available: entryUsage.status === "OK" && !exhaustedUntil })),
    next,
    checkedAt: sampledAt,
  });
  const signedIn = (profileId: string) => ({ runtimeId: "cli:copilot" as const, profileId, displayName: profileId, email: null, authStatus: "CONNECTED" as const });

  beforeEach(() => {
    resetSharedQuotaCacheForTests();
    resetCliAccountIdentitiesForTests();
    resetCliAccountBalanceForTests();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.codex.mockResolvedValue(page([], "codex"));
    mocks.agy.mockResolvedValue(page([], "agy"));
    mocks.apiProviders.mockResolvedValue(page([], "api"));
    mocks.claude.mockResolvedValue(page([], "space-claude-profiles"));
    mocks.identities.mockResolvedValue({ accounts: [signedIn("main"), signedIn("work")], checkedAt: sampledAt });
  });

  it("judges Copilot, Cursor and Kimi accounts by the quota their CLI reports and the limits Space saw", () => {
    const clock = NOW;
    const sample = balance([["main", usage(40), null], ["work", usage(70), at(90)], ["spare", usage(null, "UNKNOWN"), null], ["gone", usage(null, "NOT_CONNECTED"), null],
      ["empty", usage(0), null]], "main");
    const judge = (profileId: string) => cliAccountAvailability({ runtimeId: "cli:copilot", profileId, quota: null, identity: signedIn(profileId), clock, balance: sample });
    expect(judge("main")).toMatchObject({ tone: "ready", percent: 40, label: "40%", windows: [{ label: "Premium requests", percent: 40 }] });
    expect(judge("main").description).toContain("Premium requests 40%");
    expect(judge("work")).toMatchObject({ tone: "blocked", color: CLI_ACCOUNT_BLOCKED_COLOR });
    expect(judge("work").description).toContain("reached its limit");
    expect(judge("spare")).toMatchObject({ tone: "neutral", label: "Signed in" });
    expect(judge("gone")).toMatchObject({ tone: "blocked", label: "Not signed in" });
    expect(judge("empty").tone).toBe("blocked");
    // Another CLI's balance never colors this one.
    expect(cliAccountAvailability({ runtimeId: "cli:kimi", profileId: "main", quota: null, identity: signedIn("main"), clock, balance: sample }).tone).toBe("neutral");
    expect(cliAccountPlan("cli:copilot", "main", null, sample)).toBe("Copilot Pro");
    expect(cliAccountPlan("cli:copilot", "spare", null, sample)).toBeNull();
  });

  it("shows each account's quota and the account Auto would start on", async () => {
    mocks.balance.mockResolvedValue(balance([["main", usage(30), null], ["work", usage(80), null]], "work"));
    render(
      <CliAccountPicker
        runtimeId="cli:copilot"
        providerLabel="GitHub"
        icon={<span />}
        paneTitle="Copilot pane"
        profiles={[profile("main"), profile("work")]}
        selectedProfileId="main"
        onSelect={vi.fn()}
        auto={{ active: false, onSelect: vi.fn() }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "GitHub account for Copilot pane" }));
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(within(menu).getAllByRole("menuitemradio")[0]!.textContent).toContain("Would start on work"));
    expect(mocks.balance).toHaveBeenCalledWith("cli:copilot");
    const [, main, work] = within(menu).getAllByRole("menuitemradio");
    expect(main!.textContent).toContain("30%");
    expect(main!.textContent).toContain("Copilot Pro");
    expect(work!.textContent).toContain("80%");
  });
});
