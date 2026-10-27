import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoHealthSnapshot } from "../src/demo/demo-health.js";
import { createDemoFixture } from "../src/demo/demo-fixture.js";
import { SystemHealth } from "../src/features/system-health/SystemHealth.js";
import {
  advanceHealthTone,
  computeCodexCooldown,
  defaultHealthThresholds,
  getReactivationCountdown,
  healthThresholdStorageKey,
  numericHealthTone,
  overallHealth,
  readHealthThresholds,
  validHealthThresholds,
} from "../src/features/system-health/health-model.js";
import { formatResetCountdown } from "../src/features/system-health/HealthTables.js";
import { getSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  ping: vi.fn(),
  models: vi.fn(),
  accounts: vi.fn(),
  antigravityAccounts: vi.fn(),
  claudeAccounts: vi.fn(),
  apiProviderAccounts: vi.fn(),
  sessions: vi.fn(),
  environment: vi.fn(),
}));
vi.mock("../src/api.js", () => ({
  api: {
    systemHealth: mocks.health,
    healthPing: mocks.ping,
    systemAnalyticsModels: mocks.models,
    toolbarUsageAccounts: mocks.accounts,
    toolbarResetCredits: async () => ({ accounts: [], credits: [], checkedAt: new Date().toISOString() }),
    toolbarAntigravityUsageAccounts: mocks.antigravityAccounts,
    toolbarClaudeUsageAccounts: mocks.claudeAccounts,
    toolbarApiProviderAccounts: mocks.apiProviderAccounts,
    toolbarCliSessions: mocks.sessions,
    codexEnvironment: mocks.environment,
    // The Token usage page's Anthropic bill panel (2026-10-18): not configured, as in the demo.
    gatewayAnthropicBilling: async () => ({ status: { configured: false, keyHint: null, savedAt: null, lastSyncAt: null, lastError: null, upstream: [] }, days: [] }),
  },
}));
vi.mock("../src/runtime/SpaceRuntime.js", () => ({
  DEMO_LOCAL_REPLY: "Demo only",
  getSpaceRuntimeKind: () => "live",
  getSpaceRuntime: () => ({ platform: { localStorage: window.localStorage } }),
}));
describe("health thresholds", () => {
  it("uses lower remaining capacity and higher utilization as danger", () => {
    expect(numericHealthTone("accounts", 10, defaultHealthThresholds)).toBe(
      "critical",
    );
    expect(numericHealthTone("accounts", 20, defaultHealthThresholds)).toBe(
      "warning",
    );
    expect(numericHealthTone("cpu", 85, defaultHealthThresholds)).toBe(
      "warning",
    );
    expect(numericHealthTone("cpu", 95, defaultHealthThresholds)).toBe(
      "critical",
    );
    expect(numericHealthTone("memory", null, defaultHealthThresholds)).toBe(
      "unavailable",
    );
    expect(numericHealthTone("models", 1000, defaultHealthThresholds)).toBe(
      "healthy",
    );
  });
  it("requires different consecutive sample timestamps to raise or clear an alert", () => {
    const first = advanceHealthTone(undefined, "healthy", "a");
    const pending = advanceHealthTone(first, "critical", "b");
    expect(pending.tone).toBe("healthy");
    expect(advanceHealthTone(pending, "critical", "b").tone).toBe("healthy");
    const critical = advanceHealthTone(pending, "critical", "c");
    expect(critical.tone).toBe("critical");
    expect(advanceHealthTone(critical, "healthy", "d").tone).toBe("critical");
    expect(advanceHealthTone(critical, "stale", "d").tone).toBe("stale");
    expect(overallHealth(["healthy", "unavailable"])).toBe("unavailable");
  });
  it("validates settings and isolates browser preferences by user", () => {
    localStorage.clear();
    localStorage.setItem(
      healthThresholdStorageKey("a"),
      JSON.stringify({
        ...defaultHealthThresholds,
        cpu: { warning: 10, critical: 20 },
      }),
    );
    expect(readHealthThresholds(localStorage, "a").cpu.warning).toBe(10);
    expect(readHealthThresholds(localStorage, "b").cpu.warning).toBe(85);
    expect(
      validHealthThresholds({
        ...defaultHealthThresholds,
        cpu: { warning: 90, critical: 80 },
      }),
    ).toBe(false);
    expect(
      validHealthThresholds({
        ...defaultHealthThresholds,
        accounts: { warning: 10, critical: 20 },
      }),
    ).toBe(false);
  });
});
describe("codex cooldown calculation", () => {
  it("returns null when Codex is disabled or when an account has active tokens", () => {
    expect(computeCodexCooldown(null, null, Date.now())).toBeNull();
    expect(
      computeCodexCooldown(
        {
          data: [{ id: "acc1", label: "test", fiveHourRemainingPercent: 0, weeklyRemainingPercent: 80, sampledAt: null }],
          pagination: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 },
          source: "test",
          isStale: false,
          error: null,
          checkedAt: new Date().toISOString(),
        },
        { isCodexEnabled: false } as any,
        Date.now(),
      ),
    ).toBeNull();

    // Active account present (fiveHour >= 3 and weekly >= 3):
    expect(
      computeCodexCooldown(
        {
          data: [
            { id: "acc1", label: "Rate limited", fiveHourRemainingPercent: 0, weeklyRemainingPercent: 80, sampledAt: null },
            { id: "acc2", label: "Active", fiveHourRemainingPercent: 50, weeklyRemainingPercent: 80, sampledAt: null },
          ],
          pagination: { page: 1, pageSize: 2, totalItems: 2, totalPages: 1 },
          source: "test",
          isStale: false,
          error: null,
          checkedAt: new Date().toISOString(),
        },
        null,
        Date.now(),
      ),
    ).toBeNull();
  });

  it("treats accounts with under 3% remaining as exhausted and computes cooldown", () => {
    const baseTime = Date.parse("2026-09-13T10:00:00Z");
    const reset2h = "2026-09-13T12:51:00Z";
    const accounts = {
      data: [
        {
          id: "flp",
          label: "flpgmopai@gmail.com",
          fiveHourRemainingPercent: 0,
          weeklyRemainingPercent: 35,
          fiveHourResetAt: reset2h,
          weeklyResetAt: "2026-09-19T08:00:00Z",
          sampledAt: null,
        },
        {
          id: "ind",
          label: "indgmopai@gmail.com",
          fiveHourRemainingPercent: 1,
          weeklyRemainingPercent: 30,
          fiveHourResetAt: "2026-09-13T12:54:00Z",
          weeklyResetAt: "2026-09-19T08:00:00Z",
          sampledAt: null,
        },
        {
          id: "mesie",
          label: "mesienikolas@gmail.com",
          fiveHourRemainingPercent: 2,
          weeklyRemainingPercent: 34,
          fiveHourResetAt: "2026-09-13T12:53:00Z",
          weeklyResetAt: "2026-09-19T08:00:00Z",
          sampledAt: null,
        },
      ],
      pagination: { page: 1, pageSize: 3, totalItems: 3, totalPages: 1 },
      source: "space-gateway",
      isStale: false,
      error: null,
      checkedAt: new Date(baseTime).toISOString(),
    };

    const cooldown = computeCodexCooldown(accounts, null, baseTime);
    expect(cooldown).not.toBeNull();
    expect(cooldown?.accountLabel).toBe("flpgmopai@gmail.com");
    // 1 hour or more -> formatted in hours without minutes
    expect(cooldown?.formatted).toBe("2h");

    const reset4h = new Date(baseTime + 4 * 3600_000 + 15 * 60_000).toISOString();
    const accounts4h = {
      ...accounts,
      data: accounts.data.map((acc) => ({ ...acc, fiveHourResetAt: reset4h })),
    };
    const cooldown4h = computeCodexCooldown(accounts4h, null, baseTime);
    expect(cooldown4h?.formatted).toBe("4h");

    // 100 hours or more -> formatted in hours without minutes (matches rail indicator width)
    const reset100h = new Date(baseTime + 100 * 3600_000 + 14 * 60_000).toISOString();
    const accounts100h = {
      ...accounts,
      data: accounts.data.map((acc) => ({ ...acc, fiveHourResetAt: reset100h })),
    };
    const cooldown100h = computeCodexCooldown(accounts100h, null, baseTime);
    expect(cooldown100h?.formatted).toBe("100h");

    // formatResetCountdown minutes under 3 hours, hours/days above
    expect(formatResetCountdown(reset2h, baseTime)).toBe("Resets in 171m");
    expect(formatResetCountdown(reset4h, baseTime)).toBe("Resets in 4h 15m");
    expect(formatResetCountdown(new Date(baseTime + 26 * 3600_000).toISOString(), baseTime)).toBe("Resets in 1d 2h");

    // getReactivationCountdown only shows on exhausted accounts and < 3 hours
    expect(getReactivationCountdown({ fiveHourRemainingPercent: 100, fiveHourResetAt: reset2h }, baseTime)).toBeNull();
    expect(getReactivationCountdown({ fiveHourRemainingPercent: 97, fiveHourResetAt: reset2h }, baseTime)).toBeNull();
    expect(getReactivationCountdown({ fiveHourRemainingPercent: 0, fiveHourResetAt: new Date(baseTime + 24 * 60_000).toISOString() }, baseTime)).toBe("5h resets in 24m");
    expect(getReactivationCountdown({ fiveHourRemainingPercent: 0, fiveHourResetAt: reset4h }, baseTime)).toBeNull();
    expect(getReactivationCountdown({ fiveHourRemainingPercent: 0, fiveHourResetAt: new Date(baseTime + 30_000).toISOString() }, baseTime)).toBe("5h resets in <1m");
    expect(getReactivationCountdown({ fiveHourRemainingPercent: 100, weeklyRemainingPercent: 0, weeklyResetAt: new Date(baseTime + 45 * 60_000).toISOString() }, baseTime)).toBe("week resets in 45m");
  });

  it("calculates soonest reset in minutes (11m) when all accounts are exhausted", () => {
    const baseTime = Date.parse("2026-09-07T13:36:19Z");
    const reset11m = "2026-09-07T13:47:19Z"; // 11 minutes later
    const reset1h = "2026-09-07T14:58:38Z";

    const exhaustedAccounts = {
      data: [
        {
          id: "flpg",
          label: "flpgmopai@gmail.com",
          fiveHourRemainingPercent: 0,
          weeklyRemainingPercent: 10,
          fiveHourResetAt: reset1h,
          weeklyResetAt: "2026-09-12T14:38:32Z",
          sampledAt: null,
        },
        {
          id: "mesie",
          label: "mesienikolas@gmail.com",
          fiveHourRemainingPercent: 0,
          weeklyRemainingPercent: 84,
          fiveHourResetAt: reset11m,
          weeklyResetAt: "2026-09-14T08:47:19Z",
          sampledAt: null,
        },
        {
          id: "nigg",
          label: "niggmopai@gmail.com",
          fiveHourRemainingPercent: 100,
          weeklyRemainingPercent: 0, // weekly exceeded!
          fiveHourResetAt: null,
          weeklyResetAt: "2026-09-13T01:33:28Z",
          sampledAt: null,
        },
      ],
      pagination: { page: 1, pageSize: 3, totalItems: 3, totalPages: 1 },
      source: "space-gateway",
      isStale: false,
      error: null,
      checkedAt: new Date(baseTime).toISOString(),
    };

    const cooldown = computeCodexCooldown(exhaustedAccounts, null, baseTime);
    expect(cooldown).toEqual({
      isExhausted: true,
      minutesRemaining: 11,
      secondsRemaining: 660,
      formatted: "11m",
      accountLabel: "mesienikolas@gmail.com",
      resetAt: reset11m,
    });

    // Test scenario from screenshots: indgmopai has 5h reset in 40m, flpgmopai in 47m, niggmopai weekly in 5d
    const multiExhausted = {
      data: [
        {
          id: "flp",
          label: "flpgmopai@gmail.com",
          fiveHourRemainingPercent: 0,
          weeklyRemainingPercent: 10,
          fiveHourResetAt: new Date(baseTime + 47 * 60_000).toISOString(),
          weeklyResetAt: new Date(baseTime + 120 * 3600_000).toISOString(),
          sampledAt: null,
        },
        {
          id: "ind",
          label: "indgmopai@gmail.com",
          fiveHourRemainingPercent: 0,
          weeklyRemainingPercent: 40,
          fiveHourResetAt: new Date(baseTime + 40 * 60_000).toISOString(),
          weeklyResetAt: new Date(baseTime + 132 * 3600_000).toISOString(),
          sampledAt: null,
        },
        {
          id: "nigg",
          label: "niggmopai@gmail.com",
          fiveHourRemainingPercent: 100,
          weeklyRemainingPercent: 0,
          fiveHourResetAt: null,
          weeklyResetAt: new Date(baseTime + 131 * 3600_000).toISOString(),
          sampledAt: null,
        },
      ],
      pagination: { page: 1, pageSize: 3, totalItems: 3, totalPages: 1 },
      source: "space-gateway",
      isStale: false,
      error: null,
      checkedAt: new Date(baseTime).toISOString(),
    };

    const multiCooldown = computeCodexCooldown(multiExhausted, null, baseTime);
    expect(multiCooldown?.formatted).toBe("40m");
    expect(multiCooldown?.accountLabel).toBe("indgmopai@gmail.com");
  });

  it("formats cooldown under a minute and past reset properly", () => {
    const baseTime = 1000000;
    const accounts = {
      data: [{
        id: "a1",
        label: "one@test",
        fiveHourRemainingPercent: 0,
        weeklyRemainingPercent: 50,
        fiveHourResetAt: new Date(baseTime + 45000).toISOString(),
        sampledAt: null,
      }],
      pagination: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 },
      source: "test",
      isStale: false,
      error: null,
      checkedAt: new Date(baseTime).toISOString(),
    };

    const in45s = computeCodexCooldown(accounts, null, baseTime);
    expect(in45s?.formatted).toBe("45s");

    const passed = computeCodexCooldown(accounts, null, baseTime + 50000);
    expect(passed?.formatted).toBe("<1m");
  });
});
describe("shared health UI", () => {
  it("opens daily token history from AI & Sessions without replacing the room", async () => {
    vi.useRealTimers();
    const fixture = createDemoFixture();
    mocks.models.mockImplementation(async (range) => ({ ...fixture.systemAnalyticsModels, range }));
    render(<div className="space-shell"><textarea aria-label="Active terminal" /><SystemHealth userId="operator" railVisible environment={null} /></div>);
    const terminal = screen.getByRole("textbox", { name: "Active terminal" });
    act(() => window.dispatchEvent(new CustomEvent("space:system-health", { detail: { section: "ai" } })));
    fireEvent.change(screen.getByRole("combobox", { name: "Resource view" }), { target: { value: "usage" } });
    await waitFor(() => expect(mocks.models).toHaveBeenCalledWith("24h", "all"));
    expect(await screen.findByText("Tokens in / out / reasoning")).toBeTruthy();
    expect(terminal.isConnected).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close Resources" }));
    expect(screen.queryByRole("dialog", { name: "Resources" })).toBeNull();
    expect(terminal.isConnected).toBe(true);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    const fixture = createDemoFixture();
    mocks.health.mockImplementation(async () => demoHealthSnapshot());
    mocks.ping.mockResolvedValue({ ok: true });
    mocks.models.mockResolvedValue(fixture.systemAnalyticsModels);
    mocks.accounts.mockResolvedValue({
      data: [],
      checkedAt: new Date().toISOString(),
      isStale: false,
    });
    mocks.antigravityAccounts.mockResolvedValue({
      data: [],
      pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 1 },
      source: "vm207-antigravity",
      checkedAt: new Date().toISOString(),
      isStale: false,
      error: null,
    });
    mocks.claudeAccounts.mockResolvedValue({
      data: [],
      pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 },
      source: "space-claude-profiles",
      checkedAt: new Date().toISOString(),
      isStale: false,
      error: null,
    });
    mocks.apiProviderAccounts.mockResolvedValue({
      data: [],
      pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 1 },
      source: "api-credentials",
      checkedAt: new Date().toISOString(),
      isStale: false,
      error: null,
    });
    mocks.sessions.mockResolvedValue({
      summary: { running: 4, attached: 3, detached: 1 },
      sessions: [],
      sampledAt: new Date().toISOString(),
    });
    mocks.environment.mockResolvedValue(null);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it("shows unavailable account capacity when neither usage source reports a quota", async () => {
    render(<SystemHealth userId="operator" railVisible environment={null} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const rail = screen.getByRole("navigation", { name: "Resource indicators" });
    expect(within(rail).getByRole("button", { name: /^Account remaining: Codex Unavailable/ })).toBeTruthy();
  });
  it("opens resources and health with shared telemetry and stops hidden polling", async () => {
    render(<SystemHealth userId="operator" railVisible environment={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const rail = screen.getByRole("navigation", {
      name: "Resource indicators",
    });
    expect(within(rail).getAllByRole("button")).toHaveLength(6);
    expect(mocks.health).toHaveBeenCalledTimes(1);
    fireEvent.click(within(rail).getByRole("button", { name: /^CPU:/ }));
    expect(screen.getByRole("dialog", { name: "Resources" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand Resources" }));
    expect(screen.getByRole("dialog", { name: "Resources" })).toBeTruthy();
    expect(
      screen.getByRole("navigation", { name: "Performance metrics" }),
    ).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mocks.health).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(mocks.health).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });
  it("draws a level gauge only for percentage readings in the rail", async () => {
    render(<SystemHealth userId="operator" railVisible environment={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const rail = screen.getByRole("navigation", { name: "Resource indicators" });
    for (const name of [/^CPU:/, /^Memory:/]) {
      const button = within(rail).getByRole("button", { name });
      const shown = button.querySelector("strong")?.textContent ?? "";
      expect(shown).toMatch(/%$/);
      const fill = button.querySelector<HTMLElement>(".health-indicator-gauge > span");
      expect(fill?.style.width).toBe(`${Number.parseFloat(shown)}%`);
    }
    for (const name of [/^Connection latency:/, /^CLI sessions:/]) {
      expect(within(rail).getByRole("button", { name }).querySelector(".health-indicator-gauge")).toBeNull();
    }
  });
  it("consumes pending metadata across StrictMode and resource-to-health transitions", async () => {
    let resolveModels!: (
      value: ReturnType<typeof createDemoFixture>["systemAnalyticsModels"],
    ) => void;
    mocks.models.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveModels = resolve;
        }),
    );
    render(
      <StrictMode>
        <SystemHealth userId="operator" railVisible environment={null} />
      </StrictMode>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "Resource indicators" }),
      ).getByRole("button", { name: /^CPU:/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand Resources" }));
    const modelData = {
      ...createDemoFixture().systemAnalyticsModels,
      sampledAt: new Date().toISOString(),
    };
    await act(async () => {
      resolveModels(modelData);
    });
    fireEvent.click(screen.getByRole("button", { name: "Close Resources" }));
    expect(
      within(
        screen.getByRole("navigation", { name: "Resource indicators" }),
      ).queryByRole("button", {
        name: new RegExp(`^Active models:`),
      }),
    ).toBeNull();
    expect(
      within(
        screen.getByRole("navigation", { name: "Resource indicators" }),
      ).getByRole("button", {
        name: /^CPU:/,
      }),
    ).toBeTruthy();
    expect(mocks.models).toHaveBeenCalledTimes(1);
  });
  it("keeps the workspace mounted and restores keyboard access after Health closes", async () => {
    render(
      <div className="space-shell">
        <textarea
          aria-label="Terminal input"
          defaultValue="session stays mounted"
        />
        <SystemHealth userId="operator" railVisible environment={null} />
      </div>,
    );
    const terminal = screen.getByRole("textbox", { name: "Terminal input" });
    terminal.focus();
    act(() =>
      window.dispatchEvent(
        new CustomEvent("space:system-health", {
          detail: { section: "overview" },
        }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.querySelector<HTMLElement>(".space-shell")?.inert).toBe(
      true,
    );
    expect(screen.getByRole("textbox", { name: "Terminal input" })).toBe(
      terminal,
    );
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Resources" }), {
      key: "Escape",
    });
    expect(document.querySelector<HTMLElement>(".space-shell")?.inert).toBe(
      false,
    );
    expect(document.activeElement).toBe(terminal);
  });
  it("stores thresholds and applies the same warning to resources and rail", async () => {
    render(<SystemHealth userId="operator" railVisible environment={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() =>
      window.dispatchEvent(
        new CustomEvent("space:system-health", {
          detail: { section: "alerts" },
        }),
      ),
    );
    fireEvent.change(screen.getByRole("spinbutton", { name: "CPU warning" }), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "CPU critical" }), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save thresholds" }));
    expect(readHealthThresholds(localStorage, "operator").cpu).toEqual({
      warning: 20,
      critical: 30,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Close Resources" }));
    const cpu = within(
      screen.getByRole("navigation", { name: "Resource indicators" }),
    ).getByRole("button", { name: /^CPU:.*Critical/ });
    expect(cpu.className).toContain("is-critical");
    fireEvent.click(cpu);
    expect(
      screen
        .getByRole("dialog", { name: "Resources" })
        .querySelector(".is-critical"),
    ).toBeTruthy();
  });
  it("displays the real countdown timer in the rail only when accounts are exhausted and hides it when active", async () => {
    const resetTime = new Date(Date.now() + 11 * 60_000).toISOString();
    mocks.accounts.mockResolvedValue({
      data: [
        {
          id: "account:mesie",
          label: "mesienikolas@gmail.com",
          fiveHourRemainingPercent: 0,
          weeklyRemainingPercent: 84,
          fiveHourResetAt: resetTime,
          sampledAt: new Date().toISOString(),
        },
      ],
      pagination: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 },
      source: "space-gateway",
      isStale: false,
      error: null,
      checkedAt: new Date().toISOString(),
    });

    const { rerender } = render(<SystemHealth userId="operator" railVisible environment={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const rail = screen.getByRole("navigation", { name: "Resource indicators" });
    // Expect 7 buttons now (expander + 5 standard + 1 codex-reset)
    expect(within(rail).getAllByRole("button")).toHaveLength(7);
    const resetButton = within(rail).getByRole("button", { name: /Next token reset: 11m/ });
    expect(resetButton).toBeTruthy();
    expect(resetButton.className).toContain("is-warning");

    // Click it to open Resources dialog
    fireEvent.click(resetButton);
    expect(screen.getByRole("dialog", { name: "Resources" })).toBeTruthy();
    expect(screen.getByText(/Next Codex account available: mesienikolas@gmail.com in 11m/)).toBeTruthy();

    // Close Resources dialog
    fireEvent.click(screen.getByRole("button", { name: "Close Resources" }));

    // Now mock accounts becoming active again (> 0% in both windows)
    mocks.accounts.mockResolvedValue({
      data: [
        {
          id: "account:mesie",
          label: "mesienikolas@gmail.com",
          fiveHourRemainingPercent: 100,
          weeklyRemainingPercent: 84,
          fiveHourResetAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
          sampledAt: new Date().toISOString(),
        },
      ],
      pagination: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 },
      source: "space-gateway",
      isStale: false,
      error: null,
      checkedAt: new Date().toISOString(),
    });

    rerender(<SystemHealth userId="operator" railVisible environment={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    // Reset button must disappear from the remounted rail!
    const updatedRail = screen.getByRole("navigation", { name: "Resource indicators" });
    expect(within(updatedRail).queryByRole("button", { name: /Next token reset/ })).toBeNull();
  });

  it("renders Antigravity accounts with Gemini and Claude quota and filters by provider", async () => {
    const nowIso = new Date().toISOString();
    const resetTime = new Date(Date.now() + 4 * 3600_000).toISOString();
    mocks.models.mockResolvedValue({
      windowMinutes: 10,
      providers: [
        {
          providerId: "google",
          activeSessions: 2,
          modelCount: 4,
          completedTurns: 10,
          abortedTurns: 0,
        },
        {
          providerId: "codex",
          activeSessions: 1,
          modelCount: 2,
          completedTurns: 5,
          abortedTurns: 0,
        },
      ],
      models: [],
      totals: { activeSessions: 3, completedTurns: 15, abortedTurns: 0 },
    });
    mocks.antigravityAccounts.mockResolvedValue({
      data: [
        {
          id: "account:in1",
          label: "Profile in1",
          email: "d.pantazis@example.com",
          tier: "Google AI Pro",
          status: "CONNECTED",
          gemini: {
            displayName: "Gemini Models",
            fiveHourRemainingPercent: 96,
            fiveHourResetAt: resetTime,
            weeklyRemainingPercent: 90,
            weeklyResetAt: resetTime,
          },
          claude: {
            displayName: "Claude and GPT models",
            fiveHourRemainingPercent: 95,
            fiveHourResetAt: resetTime,
            weeklyRemainingPercent: 88,
            weeklyResetAt: resetTime,
          },
          sampledAt: nowIso,
        },
        {
          id: "account:8",
          label: "Profile 8",
          email: "otiumgr@gmail.com",
          tier: null,
          status: "UNLICENSED",
          error: "SUBSCRIPTION_REQUIRED",
          gemini: {
            displayName: "Gemini Models",
            fiveHourRemainingPercent: null,
            fiveHourResetAt: null,
            weeklyRemainingPercent: null,
            weeklyResetAt: null,
          },
          claude: {
            displayName: "Claude and GPT models",
            fiveHourRemainingPercent: null,
            fiveHourResetAt: null,
            weeklyRemainingPercent: null,
            weeklyResetAt: null,
          },
          sampledAt: nowIso,
        },
      ],
      pagination: { page: 1, pageSize: 2, totalItems: 2, totalPages: 1 },
      source: "vm207-antigravity",
      isStale: false,
      error: null,
      checkedAt: nowIso,
    });
    mocks.accounts.mockResolvedValue({
      data: [
        {
          id: "account:codex-1",
          label: "flpgmopai@gmail.com",
          fiveHourRemainingPercent: 75,
          weeklyRemainingPercent: 60,
          fiveHourResetAt: resetTime,
          weeklyResetAt: resetTime,
          sampledAt: nowIso,
        },
      ],
      pagination: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 },
      source: "space-gateway",
      isStale: false,
      error: null,
      checkedAt: nowIso,
    });

    render(<SystemHealth userId="operator" railVisible environment={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() =>
      window.dispatchEvent(
        new CustomEvent("space:system-health", {
          detail: { section: "ai" },
        }),
      ),
    );

    // Verify both Antigravity and Codex tables are present in All Providers view
    expect(screen.getAllByText("Antigravity (Google)")[0]).toBeTruthy();
    expect(screen.getByText("Codex usage")).toBeTruthy();

    // Verify Antigravity details
    expect(screen.getByText("Profile in1")).toBeTruthy();
    expect(screen.getByText("d.pantazis@example.com · Google AI Pro")).toBeTruthy();
    expect(screen.getByText("96%")).toBeTruthy();
    expect(screen.getByText("95%")).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();

    // Verify Unlicensed account
    expect(screen.getByText("Profile 8")).toBeTruthy();
    expect(screen.getByText("otiumgr@gmail.com")).toBeTruthy();
    expect(screen.getByText("Unlicensed")).toBeTruthy();
    expect(screen.getByText("No quota allocation for this profile.")).toBeTruthy();

    // Verify Codex details (75% renders as a healthy window above 30%)
    const codexCard = screen.getByText("flpgmopai@gmail.com").closest("li");
    expect(codexCard).toBeTruthy();
    const codexPill = within(codexCard as HTMLElement).getByText("75%");
    expect(codexPill.closest(".account-quota-cell")?.classList.contains("is-healthy")).toBe(true);

    // Filter to Antigravity only
    fireEvent.click(screen.getByRole("tab", { name: "Antigravity (Google)" }));
    expect(screen.getAllByText("Antigravity (Google)")[0]).toBeTruthy();
    expect(screen.queryByText("Codex usage")).toBeNull();
    expect(screen.queryByText("flpgmopai@gmail.com")).toBeNull();

    // Filter to Codex only
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.queryByText("Profile in1")).toBeNull();
    expect(screen.getByText("flpgmopai@gmail.com")).toBeTruthy();

    // Switch back to all providers
    fireEvent.click(screen.getByRole("tab", { name: "All Providers" }));
    expect(screen.getAllByText("Antigravity (Google)")[0]).toBeTruthy();
    expect(screen.getByText("Codex usage")).toBeTruthy();

    // Test clicking provider card in grid toggles filter
    fireEvent.click(screen.getByRole("tab", { name: "Antigravity (Google)" }));
    expect(screen.getAllByText("Antigravity (Google)")[0]).toBeTruthy();
    expect(screen.queryByText("Codex usage")).toBeNull();
  });

  it("filters accounts in flyout by provider and quota and saves preference to localStorage", async () => {
    const nowIso = new Date().toISOString();
    const storage = getSpaceRuntime().platform.localStorage;
    storage.removeItem("space:health-accounts:provider-filter");
    storage.removeItem("space:health-accounts:quota-filter");
    storage.removeItem("space:health-accounts:availability-filter");

    mocks.antigravityAccounts.mockResolvedValue({
      data: [
        {
          id: "bo",
          label: "bo",
          email: "bo@example.com",
          tier: "Google AI Pro",
          status: "CONNECTED",
          gemini: {
            displayName: "Gemini Models",
            fiveHourRemainingPercent: 100,
            weeklyRemainingPercent: 5,
          },
          claude: {
            displayName: "Claude and GPT models",
            fiveHourRemainingPercent: 100,
            weeklyRemainingPercent: 0,
          },
          sampledAt: nowIso,
        },
        {
          id: "exhausted",
          label: "exhausted-acc",
          email: "exhausted@example.com",
          tier: "Antigravity",
          status: "CONNECTED",
          gemini: {
            displayName: "Gemini Models",
            fiveHourRemainingPercent: 100,
            weeklyRemainingPercent: 0,
          },
          claude: {
            displayName: "Claude and GPT models",
            fiveHourRemainingPercent: 0,
            weeklyRemainingPercent: 0,
          },
          sampledAt: nowIso,
        },
      ],
      source: "space-gemini-profiles",
      isStale: false,
      error: null,
      checkedAt: nowIso,
    });

    mocks.accounts.mockResolvedValue({
      data: [
        {
          id: "codex-active",
          label: "active-codex@example.com",
          fiveHourRemainingPercent: 100,
          weeklyRemainingPercent: 4,
          sampledAt: nowIso,
        },
        {
          id: "codex-exhausted",
          label: "exhausted-codex@example.com",
          fiveHourRemainingPercent: 100,
          weeklyRemainingPercent: 0,
          sampledAt: nowIso,
        },
      ],
      pagination: { page: 1, pageSize: 2, totalItems: 2, totalPages: 1 },
      source: "space-gateway",
      isStale: false,
      error: null,
      checkedAt: nowIso,
    });

    render(<SystemHealth userId="operator" railVisible environment={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Open Resources dialog
    const rail = screen.getByRole("navigation", { name: "Resource indicators" });
    const accountsButton = within(rail).getByRole("button", { name: /Account remaining/ });
    fireEvent.click(accountsButton);

    const dialog = screen.getByRole("dialog", { name: "Resources" });
    expect(dialog).toBeTruthy();


    // Verify both active and exhausted accounts are visible initially
    expect(within(dialog).getByText("bo")).toBeTruthy();
    expect(within(dialog).getByText("exhausted-acc")).toBeTruthy();
    expect(within(dialog).getByText("active-codex@example.com")).toBeTruthy();
    expect(within(dialog).getByText("exhausted-codex@example.com")).toBeTruthy();

    expect(dialog.querySelectorAll(".toolbar-metric-account-card")).toHaveLength(4);
    expect(within(dialog).getByText("exhausted-acc").closest("li")?.dataset.availability).toBe("exhausted");
    expect(within(dialog).getByText("Week exhausted", { selector: "[data-provider='codex'] .account-availability-pill" })).toBeTruthy();

    // Show only accounts that can work right now
    fireEvent.click(within(dialog).getByRole("button", { name: "Available (2)" }));

    // Exhausted accounts should now be filtered out
    expect(within(dialog).getByText("bo")).toBeTruthy();
    expect(within(dialog).queryByText("exhausted-acc")).toBeNull();
    expect(within(dialog).getByText("active-codex@example.com")).toBeTruthy();
    expect(within(dialog).queryByText("exhausted-codex@example.com")).toBeNull();

    // bo stays available through Gemini; its used-up Claude · GPT week is still shown in red
    const boCard = within(dialog).getByText("bo").closest("li") as HTMLElement;
    expect(within(boCard).getByText("Gemini")).toBeTruthy();
    expect(within(boCard).getByText("Claude · GPT")).toBeTruthy();
    expect(within(boCard).getAllByTitle(/: Exhausted/).map((cell) => cell.textContent)).toEqual(["0%"]);

    // Verify saved to localStorage
    expect(storage.getItem("space:health-accounts:availability-filter")).toBe("available");

    // Filter by Antigravity only
    const antigravityTab = within(dialog).getByRole("tab", { name: "Antigravity (Google)" });
    fireEvent.click(antigravityTab);
    expect(within(dialog).getByText("bo")).toBeTruthy();
    expect(within(dialog).queryByText("active-codex@example.com")).toBeNull();
    expect(storage.getItem("space:health-accounts:provider-filter")).toBe("antigravity");

    // Filter by Codex only
    const codexTab = within(dialog).getByRole("tab", { name: "Codex" });
    fireEvent.click(codexTab);
    expect(within(dialog).queryByText("bo")).toBeNull();
    expect(within(dialog).getByText("active-codex@example.com")).toBeTruthy();
    // On Codex, Pro accounts and Gemini only filters are hidden
    expect(within(dialog).queryByRole("button", { name: "Pro accounts" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Gemini only" })).toBeNull();

    // Switch back to Antigravity
    fireEvent.click(antigravityTab);
    expect(within(dialog).getByText("bo")).toBeTruthy();
    expect(within(dialog).queryByText("active-codex@example.com")).toBeNull();
    expect(storage.getItem("space:health-accounts:provider-filter")).toBe("antigravity");

    // Toggle Gemini only filter
    const geminiToggle = within(dialog).getByRole("button", { name: "Gemini only" });
    fireEvent.click(geminiToggle);
    expect(storage.getItem("space:health-accounts:gemini-filter")).toBe("true");
    expect(within(dialog).getByText("bo")).toBeTruthy();
    expect(within(dialog).queryByText("active-codex@example.com")).toBeNull();
    expect(within(dialog).getByText("Gemini")).toBeTruthy();
    expect(within(dialog).queryByText("Claude · GPT")).toBeNull();

    // Toggle off
    fireEvent.click(geminiToggle);
    expect(storage.getItem("space:health-accounts:gemini-filter")).toBe("false");
    expect(within(dialog).getByText("bo")).toBeTruthy();
  });

  it("shows every Claude profile from shared telemetry under the Resources Claude tab", async () => {
    const nowIso = new Date().toISOString();
    const storage = getSpaceRuntime().platform.localStorage;
    storage.removeItem("space:health-accounts:provider-filter");
    storage.removeItem("space:health-accounts:quota-filter");
    storage.removeItem("space:health-accounts:availability-filter");
    const claudeAccount = { plan: "Team · Max 5x", fiveHourResetAt: null, weeklyResetAt: null, weeklyScope: "Fable", sampledAt: nowIso };
    mocks.claudeAccounts.mockResolvedValue({
      data: [
        { ...claudeAccount, id: "main", label: "ntheo", email: "ntheo@example.com", status: "CONNECTED", fiveHourRemainingPercent: 26, weeklyRemainingPercent: 100 },
        { ...claudeAccount, id: "dev", label: "dev", email: "dev@example.com", status: "CONNECTED", fiveHourRemainingPercent: 100, weeklyRemainingPercent: 100 },
        { ...claudeAccount, id: "api", label: "api", email: null, plan: null, status: "NOT_CONNECTED", fiveHourRemainingPercent: null, weeklyRemainingPercent: null, weeklyScope: null },
      ],
      pagination: { page: 1, pageSize: 100, totalItems: 3, totalPages: 1 },
      source: "space-claude-profiles",
      isStale: false,
      error: null,
      checkedAt: nowIso,
    });

    render(<SystemHealth userId="operator" railVisible environment={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const rail = screen.getByRole("navigation", { name: "Resource indicators" });
    fireEvent.click(within(rail).getByRole("button", { name: /Account remaining/ }));
    const dialog = screen.getByRole("dialog", { name: "Resources" });

    fireEvent.click(within(dialog).getByRole("tab", { name: "Claude" }));
    expect(storage.getItem("space:health-accounts:provider-filter")).toBe("claude");
    expect(dialog.querySelectorAll(".toolbar-metric-account-card")).toHaveLength(3);
    for (const label of ["ntheo", "dev", "api"]) expect(within(dialog).getByText(label)).toBeTruthy();
    expect(within(dialog).getAllByText("Week · Fable")).toHaveLength(2);
    expect(within(dialog).getAllByText("Available", { selector: ".account-availability-pill" })).toHaveLength(2);
    expect(within(dialog).getByText("Not signed in")).toBeTruthy();
    expect(mocks.claudeAccounts).toHaveBeenCalled();
  });

  it("renders resources detail navigation select with resources-detail-select class and groups", async () => {
    render(<SystemHealth userId="operator" railVisible environment={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const rail = screen.getByRole("navigation", {
      name: "Resource indicators",
    });
    fireEvent.click(within(rail).getByRole("button", { name: /^CPU:/ }));
    const dialog = screen.getByRole("dialog", { name: "Resources" });
    expect(dialog).toBeTruthy();

    const select = within(dialog).getByRole("combobox", { name: "Resource view" });
    expect(select).toBeTruthy();
    expect(select.classList.contains("resources-detail-select")).toBe(true);

    const optgroups = select.querySelectorAll("optgroup");
    expect(optgroups.length).toBeGreaterThanOrEqual(4);
    const options = select.querySelectorAll("option");
    expect(options.length).toBeGreaterThanOrEqual(10);
  });

  it("keeps only basic metrics and disables extended per-device disk and network metrics in Performance view", async () => {
    render(<SystemHealth userId="operator" railVisible environment={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const rail = screen.getByRole("navigation", {
      name: "Resource indicators",
    });
    fireEvent.click(within(rail).getByRole("button", { name: /^CPU:/ }));
    const dialog = screen.getByRole("dialog", { name: "Resources" });
    expect(dialog).toBeTruthy();

    const nav = within(dialog).getByRole("navigation", {
      name: "Performance metrics",
    });
    expect(within(nav).getByRole("button", { name: /^CPU/ })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: /^Memory/ })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: /^Swap/ })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: /^Root disk/ })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: /^Space disk/ })).toBeTruthy();

    // Extended per-device and per-interface metrics are disabled
    expect(within(nav).queryByRole("button", { name: /vda read/i })).toBeNull();
    expect(within(nav).queryByRole("button", { name: /vda write/i })).toBeNull();
    expect(within(nav).queryByRole("button", { name: /vda active/i })).toBeNull();
    expect(within(nav).queryByRole("button", { name: /eth0 receive/i })).toBeNull();
    expect(within(nav).queryByRole("button", { name: /eth0 send/i })).toBeNull();
  });

  it("disables intervals beyond 10m when viewing Connection latency (rtt)", async () => {
    render(<SystemHealth userId="operator" railVisible environment={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const rail = screen.getByRole("navigation", {
      name: "Resource indicators",
    });
    fireEvent.click(within(rail).getByRole("button", { name: /^Connection latency:/ }));
    const dialog = screen.getByRole("dialog", { name: "Resources" });
    expect(dialog).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Latency history" }));

    const rangeNav = within(dialog).getByLabelText("History range");
    expect((within(rangeNav).getByRole("button", { name: "Live · 60 sec" }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(rangeNav).getByRole("button", { name: "10 min" }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(rangeNav).getByRole("button", { name: "1 hour" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(rangeNav).getByRole("button", { name: "7 days" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(rangeNav).getByRole("button", { name: "30 days" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides agents rail icon when live badges are present and shows it when idle/no badges", async () => {
    const onOpen = vi.fn();
    const { rerender } = render(
      <SystemHealth
        userId="operator"
        railVisible
        environment={null}
        onOpenAgentsDashboard={onOpen}
        agentsSummary={{
          loaded: true,
          total: 7,
          working: 1,
          waiting: 5,
          done: 0,
          idle: 1,
        }}
      />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const rail = screen.getByRole("navigation", { name: "Resource indicators" });
    const agentsBtn = within(rail).getByRole("button", { name: /Open agents dashboard/i });
    expect(agentsBtn).toBeTruthy();

    // When badges exist (working: 1, waiting: 5), icon is hidden and badges are rendered
    expect(agentsBtn.querySelector(".agents-rail-icon")).toBeNull();
    expect(agentsBtn.querySelector(".agents-live-badge.is-working")).toBeTruthy();
    expect(agentsBtn.querySelector(".agents-live-badge.is-waiting")).toBeTruthy();

    // When only waiting badge exists, icon is still hidden
    rerender(
      <SystemHealth
        userId="operator"
        railVisible
        environment={null}
        onOpenAgentsDashboard={onOpen}
        agentsSummary={{
          loaded: true,
          total: 7,
          working: 0,
          waiting: 5,
          done: 0,
          idle: 2,
        }}
      />
    );
    expect(agentsBtn.querySelector(".agents-rail-icon")).toBeNull();
    expect(agentsBtn.querySelector(".agents-live-badge.is-waiting")).toBeTruthy();

    // When no badges exist (all idle or 0), icon is shown
    rerender(
      <SystemHealth
        userId="operator"
        railVisible
        environment={null}
        onOpenAgentsDashboard={onOpen}
        agentsSummary={{
          loaded: true,
          total: 7,
          working: 0,
          waiting: 0,
          done: 0,
          idle: 7,
        }}
      />
    );
    expect(agentsBtn.querySelector(".agents-rail-icon")).toBeTruthy();
    expect(agentsBtn.querySelector(".agents-live-badge")).toBeNull();
  });

  it("renders resources dialog header with heading and actions aligned at the end", async () => {
    render(
      <SystemHealth
        userId="operator"
        railVisible
        environment={null}
      />
    );
    const rail = screen.getByRole("navigation", {
      name: "Resource indicators",
    });
    await act(async () => {
      fireEvent.click(within(rail).getByRole("button", { name: /^CPU:/ }));
    });
    const dialog = screen.getByRole("dialog", { name: "Resources" });
    expect(dialog).toBeTruthy();

    const header = dialog.querySelector(".health-window-header");
    expect(header).toBeTruthy();
    expect(header?.querySelector(".health-brand-icon")).toBeTruthy();

    const heading = header?.querySelector(".health-window-heading");
    expect(heading).toBeTruthy();
    expect(heading?.querySelector("h1")?.textContent).toBe("Resources");

    const actions = header?.querySelector(".health-window-actions");
    expect(actions).toBeTruthy();
    expect(actions?.querySelector(".dock-fullscreen-toggle")).toBeTruthy();
    expect(actions?.querySelector(".health-window-close-btn")).toBeTruthy();
  });

  it("rotates Account remaining across providers every 20 seconds", async () => {
    const nowIso = new Date().toISOString();
    mocks.accounts.mockResolvedValue({
      data: [
        {
          id: "codex-1",
          label: "codex-active@example.com",
          fiveHourRemainingPercent: 100,
          weeklyRemainingPercent: 4,
          sampledAt: nowIso,
        },
      ],
      pagination: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 },
      source: "space-gateway",
      isStale: false,
      error: null,
      checkedAt: nowIso,
    });
    mocks.antigravityAccounts.mockResolvedValue({
      data: [
        {
          id: "agy-1",
          label: "agy-account",
          email: "agy@example.com",
          tier: "Antigravity",
          status: "CONNECTED",
          gemini: {
            displayName: "Gemini Models",
            fiveHourRemainingPercent: 52,
            weeklyRemainingPercent: 68,
          },
          claude: null,
          sampledAt: nowIso,
        },
      ],
      pagination: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 },
      source: "space-gemini-profiles",
      isStale: false,
      error: null,
      checkedAt: nowIso,
    });

    render(
      <SystemHealth
        userId="operator"
        railVisible
        environment={null}
      />
    );
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
    });

    const rail = screen.getByRole("navigation", {
      name: "Resource indicators",
    });
    const accountsButton = within(rail).getByRole("button", { name: /Account remaining/ });
    expect(accountsButton).toBeTruthy();
    expect(within(accountsButton).getByText("CODEX")).toBeTruthy();

    // Advance 20 seconds -> rotates to next provider (AGY)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(within(accountsButton).getByText("AGY")).toBeTruthy();

    // Advance 20 seconds -> rotates back to CODEX
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(within(accountsButton).getByText("CODEX")).toBeTruthy();
  });

  it("toggles data-resource-rail-expanded and is-expanded class when expander is clicked", async () => {
    vi.useRealTimers();
    mocks.health.mockImplementation(async () => demoHealthSnapshot());
    const view = render(
      <div className="space-shell" data-testid="shell">
        <SystemHealth userId="operator" railVisible environment={null} />
      </div>
    );
    const shell = screen.getByTestId("shell");
    expect(shell.dataset.resourceRailExpanded).toBeUndefined();

    const expander = screen.getByRole("button", { name: "Expand resource indicators" });
    const rail = expander.closest(".health-indicator-rail");
    expect(rail?.classList.contains("is-expanded")).toBe(false);

    fireEvent.click(expander);
    expect(rail?.classList.contains("is-expanded")).toBe(true);
    expect(shell.dataset.resourceRailExpanded).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Collapse resource indicators" }));
    expect(rail?.classList.contains("is-expanded")).toBe(false);
    expect(shell.dataset.resourceRailExpanded).toBeUndefined();

    view.unmount();
    expect(shell.dataset.resourceRailExpanded).toBeUndefined();
  });

  it("renders minimizedBarToggle at the very top of health-indicator-rail before expander, visible even when collapsed", async () => {
    vi.useRealTimers();
    mocks.health.mockImplementation(async () => demoHealthSnapshot());
    const toggle = (
      <button
        type="button"
        id="minimized-pane-bar-toggle"
        data-rail-id="minimized-bar"
        className="room-toolbar-visibility-button minimized-pane-bar-toggle"
        aria-label="Show minimized panes bar (2 minimized panes)"
      >
        <span>2</span>
      </button>
    );

    const view = render(
      <div className="space-shell" data-testid="shell">
        <SystemHealth
          userId="operator"
          railVisible
          environment={null}
          minimizedBarToggle={toggle}
        />
      </div>
    );

    const minBtn = screen.getByRole("button", { name: /Show minimized panes bar/ });
    expect(minBtn).toBeTruthy();

    const rail = minBtn.closest(".health-indicator-rail");
    expect(rail).toBeTruthy();

    // Verify minimizedBarToggle is the very first element inside health-indicator-rail
    expect(rail?.firstElementChild).toBe(minBtn);

    // Verify the second element is the expander
    const expander = rail?.querySelector(".health-rail-expander");
    expect(expander).toBeTruthy();
    expect(minBtn.nextElementSibling).toBe(expander);

    // Verify minimizedBarToggle is NOT inside .health-rail-items
    const healthRailItems = rail?.querySelector(".health-rail-items");
    expect(healthRailItems?.contains(minBtn)).toBe(false);

    // Rail is collapsed by default in test (<nav> does not have is-expanded class)
    expect(rail?.classList.contains("is-expanded")).toBe(false);
    // minimizedBarToggle remains rendered in the DOM
    expect(screen.getByRole("button", { name: /Show minimized panes bar/ })).toBeTruthy();

    view.unmount();
  });

  it("does not render health-indicator-rail when railVisible is false even if minimizedBarToggle is provided", () => {
    const toggle = (
      <button
        type="button"
        id="minimized-pane-bar-toggle"
        data-rail-id="minimized-bar"
      >
        <span>1</span>
      </button>
    );

    const view = render(
      <div className="space-shell">
        <SystemHealth
          userId="operator"
          railVisible={false}
          environment={null}
          minimizedBarToggle={toggle}
        />
      </div>
    );

    expect(view.container.querySelector(".health-indicator-rail")).toBeNull();
    view.unmount();
  });

  it("renders minimizedBarToggle in health-indicator-rail when indicatorsVisible is false, but hides resource indicators", () => {
    const toggle = (
      <button
        type="button"
        id="minimized-pane-bar-toggle"
        data-rail-id="minimized-bar"
      >
        <span>1</span>
      </button>
    );

    const view = render(
      <div className="space-shell">
        <SystemHealth
          userId="operator"
          railVisible={true}
          indicatorsVisible={false}
          environment={null}
          minimizedBarToggle={toggle}
        />
      </div>
    );

    const rail = view.container.querySelector(".health-indicator-rail");
    expect(rail).toBeTruthy();
    expect(rail?.contains(view.container.querySelector("#minimized-pane-bar-toggle"))).toBe(true);
    expect(view.container.querySelector(".health-rail-expander")).toBeNull();
    expect(view.container.querySelector(".health-rail-items")).toBeNull();
    view.unmount();
  });

  it("does not render health-indicator-rail when railVisible is true but indicatorsVisible is false and no minimizedBarToggle is present", () => {
    const view = render(
      <div className="space-shell">
        <SystemHealth
          userId="operator"
          railVisible={true}
          indicatorsVisible={false}
          environment={null}
        />
      </div>
    );

    expect(view.container.querySelector(".health-indicator-rail")).toBeNull();
    view.unmount();
  });
});


