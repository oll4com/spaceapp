import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexEnvironment, SystemAnalyticsModelsResponse, ToolbarModelStats } from "@space/contracts";
import { SpaceApiError } from "../src/api.js";
import { AccountQuotaCard } from "../src/features/toolbar-metrics/AccountQuotaCards.js";
import {
  formatAccountReset,
  getToolbarMetricsSnapshot,
  getToolbarRttPresentation,
  QuotaIndicator,
  ToolbarMetrics,
  ToolbarMetricsSummary,
  type ToolbarMetricsClient,
} from "../src/features/toolbar-metrics/ToolbarMetrics.js";

const sampledAt = "2026-07-14T12:00:00.000Z";
it("opens Resources on click without hover work or cleanup, and stops polling when closed", async () => {
  const intervals = vi.spyOn(window, "setInterval");
  const clearInterval = vi.spyOn(window, "clearInterval");
  const client = createClient();
  render(<ToolbarMetrics presentation="drawer" environment={environment} client={client} canManage />);
  const trigger = screen.getByRole("button", { name: "Resources" });
  fireEvent.mouseEnter(trigger);
  expect(client.roundTrip).not.toHaveBeenCalled();
  expect(client.modelStats).not.toHaveBeenCalled();
  expect(screen.queryByRole("complementary")).toBeNull();
  fireEvent.click(trigger);
  await waitFor(() => expect(client.roundTrip).toHaveBeenCalledTimes(1));
  const drawer = screen.getByRole("complementary", { name: "Resources" });
  fireEvent.click(within(drawer).getByRole("button", { name: /^CLI / }));
  await waitFor(() => expect(client.cliSessions).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("dialog", { name: "Clean detached CLI sessions" })).toBeNull();
  expect(client.reapCliSessions).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close Resources" }));
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  for (const result of intervals.mock.results) {
    if (result.type === "return") expect(clearInterval).toHaveBeenCalledWith(result.value);
  }
  intervals.mockRestore();
  clearInterval.mockRestore();
});
const weeklyResetAt = "2026-07-20T09:30:00.000Z";
const gib = 1024 * 1024 * 1024;

const environment: CodexEnvironment = {
  codexHome: "/home/space/.codex",
  stateDbPath: "/home/space/.codex/state.sqlite",
  config: { modelProvider: "space-gateway", model: "gpt-5.5", reasoningEffort: "high" },
  mcpServers: [],
  skillCount: 0,
  pluginCount: 0,
  memories: { generateMemories: null, useMemories: null },
  features: { plugins: null, memories: null },
  lbUsage: {
    allAccountsRemainingPercent: 62,
    activeAccountsRemainingPercent: 44,
    routeMode: "headroom",
    routeTargetMode: null,
    upstream: "headroom",
    source: "test",
    error: null,
    checkedAt: sampledAt,
  },
  hostStats: {
    cliSessions: { active: 3, attached: 2, detached: 1, status: "OK" },
    cpu: { usagePercent: 24, coreCount: 16 },
    memory: { usedBytes: 6 * gib, totalBytes: 8 * gib, usagePercent: 75 },
    swap: { usedBytes: 1 * gib, totalBytes: 4 * gib, usagePercent: 25 },
    apiStartedAt: sampledAt,
    sampledAt,
  },
  checkedAt: sampledAt,
};

function createClient(rttMs: number | null = 210): ToolbarMetricsClient {
  return {
    roundTrip: vi.fn(async () => rttMs),
    modelStats: vi.fn(async (): Promise<ToolbarModelStats> => ({
      windowMinutes: 10,
      sampledAt,
      sources: ["opencode", "codex"] as Array<"opencode" | "codex">,
      errors: [],
      models: [
        { modelId: "opencode/deepseek-v4-flash-free", providerId: "opencode", source: "opencode" as const, turns: 2, avgTtftMs: null, avgTokPerSec: 38.2, avgDurationMs: 12_400, tokensIn: 30_000, tokensOut: 6_000, tokensReasoning: 0 },
        { modelId: "gpt-5.4-mini", providerId: "openai", source: "codex" as const, turns: 1, avgTtftMs: 1_850, avgTokPerSec: 112.4, avgDurationMs: 9_600, tokensIn: 18_500, tokensOut: 2_130, tokensReasoning: 0 },
      ],
    })),
    usageAccounts: vi.fn(async () => ({
      data: [
        { id: "account:one", label: "one@example.test", fiveHourRemainingPercent: 70, weeklyRemainingPercent: 60, weeklyResetAt, sampledAt },
        { id: "account:two", label: "two@example.test", fiveHourRemainingPercent: 40, weeklyRemainingPercent: 30, weeklyResetAt: null, sampledAt },
      ],
      pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
      source: "codex-usage-host",
      isStale: false,
      error: null,
      checkedAt: sampledAt,
    })),
    antigravityAccounts: vi.fn(async () => ({
      data: [],
      pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 },
      source: "space-gemini-profiles",
      isStale: false,
      error: null,
      checkedAt: sampledAt,
    })),
    claudeAccounts: vi.fn(async () => ({
      data: [],
      pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 },
      source: "space-claude-profiles",
      isStale: false,
      error: null,
      checkedAt: sampledAt,
    })),
    apiProviderAccounts: vi.fn(async () => ({
      data: [],
      pagination: { page: 1, pageSize: 0, totalItems: 0, totalPages: 0 },
      isStale: false,
      error: null,
      source: "mock" as const,
      checkedAt: sampledAt,
    })),
    resetCredits: vi.fn(async () => ({
      data: [
        { accountId: "account:one", availableCreditCount: 2 },
        { accountId: "account:two", availableCreditCount: 0 },
      ],
      source: "space-gateway" as const,
      isStale: false,
      error: null,
      checkedAt: sampledAt,
    })),
    redeemResetCredit: vi.fn(async (accountId: string) => ({
      accountId,
      outcome: "RESET" as const,
      completedAt: sampledAt,
    })),
    cliSessions: vi.fn(async () => ({
      summary: { running: 2, attached: 1, detached: 1, cleanupEligible: 1 },
      sessions: [{
        sessionId: "cli_session:eligible",
        hostId: "main" as const,
        runtimeId: "cli:codex",
        roomId: "room:one",
        paneId: "pane:one",
        pid: 101,
        status: "RUNNING" as const,
        attachmentCount: 0,
        startedAt: sampledAt,
        detachedAt: sampledAt,
        rssBytes: 64 * 1024 * 1024,
        cleanupEligible: true,
      }],
      sampledAt,
    })),
    reapCliSessions: vi.fn(async () => ({
      status: "COMPLETED" as const,
      killedSessionIds: ["cli_session:eligible"],
      skippedCount: 0,
      estimatedReclaimedBytes: 64 * 1024 * 1024,
      completedAt: sampledAt,
    })),
    hostMemory: vi.fn(async () => ({
      memory: {
        totalBytes: 8 * gib,
        usedBytes: 7 * gib,
        availableBytes: 1 * gib,
        usagePercent: 87.5,
        pageCacheBytes: 512 * 1024 * 1024,
        reclaimableBytes: 512 * 1024 * 1024,
      },
      swap: { totalBytes: 4 * gib, usedBytes: 1 * gib, usagePercent: 25 },
      pressure: { isUnderPressure: true, availablePercent: 12.5, canDropPageCache: true },
      topProcesses: [{
        pid: 202,
        name: "codex",
        taskTitle: "Fix the toolbar",
        rssBytes: 512 * 1024 * 1024,
        cpuPercent: 5,
        state: "S",
        isSpaceManaged: true,
        cleanupEligible: false,
      }],
      topCpuProcesses: [
        {
          pid: 303,
          name: "postgres",
          taskTitle: null,
          rssBytes: 64 * 1024 * 1024,
          cpuPercent: 42,
          state: "R",
          isSpaceManaged: false,
          cleanupEligible: false,
        },
        {
          pid: 202,
          name: "codex",
          taskTitle: "Fix the toolbar",
          rssBytes: 512 * 1024 * 1024,
          cpuPercent: 5,
          state: "S",
          isSpaceManaged: true,
          cleanupEligible: false,
        },
      ],
      sampledAt,
    })),
    reclaimMemory: vi.fn(async () => ({
      status: "COMPLETED" as const,
      cli: { killedSessionIds: ["cli_session:eligible"], estimatedReclaimedBytes: 64 * 1024 * 1024, protectedSessionCount: 2 },
      kernelCache: { status: "CLEARED" as const, reclaimedBytes: 128 * 1024 * 1024, message: null },
      before: {
        totalBytes: 8 * gib,
        usedBytes: 7 * gib,
        availableBytes: 1 * gib,
        usagePercent: 87.5,
        pageCacheBytes: 512 * 1024 * 1024,
        reclaimableBytes: 512 * 1024 * 1024,
      },
      after: {
        totalBytes: 8 * gib,
        usedBytes: 6.75 * gib,
        availableBytes: 1.25 * gib,
        usagePercent: 84.4,
        pageCacheBytes: 384 * 1024 * 1024,
        reclaimableBytes: 384 * 1024 * 1024,
      },
      completedAt: sampledAt,
    })),
  };
}

describe("ToolbarMetrics", () => {
  beforeEach(() => vi.clearAllMocks());

  it("classifies RTT thresholds without hiding the measured value", () => {
    expect(getToolbarRttPresentation(null, false)).toEqual({ status: "measuring", tone: "muted", value: "--" });
    expect(getToolbarRttPresentation(299, false)).toEqual({ status: "good", tone: "muted", value: "299" });
    expect(getToolbarRttPresentation(300, false)).toEqual({ status: "warning", tone: "warn", value: "300" });
    expect(getToolbarRttPresentation(424, false)).toEqual({ status: "warning", tone: "warn", value: "424" });
    expect(getToolbarRttPresentation(425, false)).toEqual({ status: "critical", tone: "bad", value: "425" });
    expect(getToolbarRttPresentation(null, true)).toEqual({ status: "critical", tone: "bad", value: "ERR" });
  });

  it("shows the live RTT as an orange warning with a textual accessible state", async () => {
    const client = createClient(318);
    render(<ToolbarMetrics environment={environment} client={client} />);

    const rtt = await screen.findByLabelText("RTT 318 milliseconds, warning");
    expect(rtt.classList.contains("tone-warn")).toBe(true);
    expect(within(rtt).getByText("RTT")).toBeTruthy();
    expect(within(rtt).getByText("318")).toBeTruthy();
    expect(client.roundTrip).toHaveBeenCalledTimes(1);
  });

  it("opens a live RTT details panel from the toolbar metric", async () => {
    const client = createClient(242);
    render(<ToolbarMetrics environment={environment} client={client} canManage={false} />);

    const rtt = await screen.findByRole("button", { name: "RTT 242 milliseconds, good" });
    expect(rtt.getAttribute("aria-expanded")).toBe("false");
    fireEvent.mouseEnter(rtt);

    const panel = await screen.findByRole("region", { name: "RTT details" });
    expect(rtt.getAttribute("aria-expanded")).toBe("true");
    expect(within(panel).getByText("Current").nextSibling?.textContent).toBe("242 ms");
    expect(within(panel).getByText("Status").nextSibling?.textContent).toBe("Good");
    expect(within(panel).getByText("Warning at").nextSibling?.textContent).toBe("300 ms");
    expect(within(panel).getByText("Alert at").nextSibling?.textContent).toBe("425 ms");
    expect(within(panel).getByText("Probe").nextSibling?.textContent).toBe("Browser → API");
    expect(within(panel).getByText("Refresh").nextSibling?.textContent).toBe("Every 10 sec");
  });

  it("shows a red RTT error state when the browser probe fails", async () => {
    const client = createClient();
    client.roundTrip = vi.fn(async () => { throw new Error("offline"); });
    render(<ToolbarMetrics environment={environment} client={client} />);

    const rtt = await screen.findByLabelText("RTT unavailable, alert");
    expect(rtt.classList.contains("tone-bad")).toBe(true);
    expect(within(rtt).getByText("ERR")).toBeTruthy();
  });

  it("keeps an intentionally disabled RTT probe neutral for deterministic surfaces", async () => {
    render(<ToolbarMetrics environment={environment} client={createClient(null)} />);

    const rtt = await screen.findByLabelText("RTT measuring");
    expect(rtt.classList.contains("tone-bad")).toBe(false);
    expect(within(rtt).getByText("--")).toBeTruthy();
  });

  it("reuses the toolbar values in a compact six-item system metrics summary", () => {
    expect(getToolbarMetricsSnapshot(environment)).toEqual({
      all: "62%",
      cli: "3",
      cpu: "24%",
      provider: "GW",
      ram: "75%",
      swap: "25%",
    });

    render(<ToolbarMetricsSummary environment={environment} />);

    const summary = screen.getByRole("region", { name: "System metrics" });
    expect(within(summary).getAllByRole("listitem")).toHaveLength(6);
    expect(within(summary).getByText("ALL").nextSibling?.textContent).toBe("62%");
    expect(within(summary).getByText("CLI").nextSibling?.textContent).toBe("3");
    expect(within(summary).getByText("RAM").nextSibling?.textContent).toBe("75%");
    expect(within(summary).getByText("CPU").nextSibling?.textContent).toBe("24%");
    expect(within(summary).getByText("SWP").nextSibling?.textContent).toBe("25%");
    expect(within(summary).getByText("Provider").nextSibling?.textContent).toBe("GW");
  });

  it("shows GW when Codex runs through Space Gateway, whatever the old codex-lb route says", () => {
    const gateway = { ...environment, config: { ...environment.config, modelProvider: "space-gateway" } };
    expect(getToolbarMetricsSnapshot(gateway).provider).toBe("GW");
  });

  it("keeps protected telemetry idle for non-admin users", async () => {
    const client = createClient();
    render(<ToolbarMetrics environment={environment} client={client} canManage={false} />);

    const all = screen.getByRole("button", { name: "ALL 62%" });
    fireEvent.mouseEnter(all);
    const panel = await screen.findByRole("region", { name: "Account usage details" });
    expect(within(panel).getByText(/ADMIN access is required/)).toBeTruthy();
    expect(client.usageAccounts).not.toHaveBeenCalled();
  });

  it("keeps only ALL and lazily reveals all, active, and per-account usage on hover or focus", async () => {
    const client = createClient();
    render(<ToolbarMetrics environment={environment} client={client} />);

    expect(screen.getByText("ALL")).toBeTruthy();
    expect(screen.queryByText("ACT")).toBeNull();
    expect(client.usageAccounts).not.toHaveBeenCalled();
    expect(client.cliSessions).not.toHaveBeenCalled();
    expect(client.hostMemory).not.toHaveBeenCalled();

    const all = screen.getByRole("button", { name: "ALL 62%" });
    fireEvent.mouseEnter(all);
    const panel = await screen.findByRole("region", { name: "Account usage details" });
    expect(within(panel).getByText("Routing capacity · all accounts").nextSibling?.textContent).toBe("62%");
    expect(within(panel).getByText("Routing capacity · active accounts").nextSibling?.textContent).toBe("44%");
    const oneCard = within(panel).getByText("one@example.test").closest("li") as HTMLElement;
    const twoCard = within(panel).getByText("two@example.test").closest("li") as HTMLElement;
    expect(within(oneCard).getByRole("meter", { name: "5h remaining" }).getAttribute("aria-valuenow")).toBe("70");
    expect(within(oneCard).getByRole("meter", { name: "Week remaining" }).getAttribute("aria-valuenow")).toBe("60");
    expect(within(twoCard).getByRole("meter", { name: "Week remaining" }).getAttribute("aria-valuenow")).toBe("30");
    expect(within(oneCard).getByText("Available")).toBeTruthy();
    expect(client.usageAccounts).toHaveBeenCalledTimes(1);
    expect(client.resetCredits).toHaveBeenCalledTimes(1);

    fireEvent.focus(all);
    expect(client.usageAccounts).toHaveBeenCalledTimes(1);
    expect(client.resetCredits).toHaveBeenCalledTimes(1);
  });

  it("loads reset availability independently without blocking account percentages", async () => {
    let resolveCredits!: (value: Awaited<ReturnType<ToolbarMetricsClient["resetCredits"]>>) => void;
    const client = createClient();
    client.resetCredits = vi.fn(() => new Promise<Awaited<ReturnType<ToolbarMetricsClient["resetCredits"]>>>(
      (resolve) => { resolveCredits = resolve; }
    ));
    render(<ToolbarMetrics environment={environment} client={client} />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "ALL 62%" }));

    const panel = await screen.findByRole("region", { name: "Account usage details" });
    const oneCard = (await within(panel).findByText("one@example.test")).closest("li") as HTMLElement;
    expect(oneCard).toBeTruthy();
    expect(within(oneCard).getByRole("meter", { name: "5h remaining" }).getAttribute("aria-valuenow")).toBe("70");
    expect(within(oneCard).getByText("70%")).toBeTruthy();
    expect(within(panel).getAllByRole("button", { name: "Resets …" })).toHaveLength(2);
    expect(client.usageAccounts).toHaveBeenCalledTimes(1);
    expect(client.resetCredits).toHaveBeenCalledTimes(1);

    resolveCredits({
      data: [
        { accountId: "account:one", availableCreditCount: 2 },
        { accountId: "account:two", availableCreditCount: 0 },
      ],
      source: "space-gateway",
      isStale: false,
      error: null,
      checkedAt: sampledAt,
    });

    expect(await within(panel).findByRole("button", { name: "Resets 2" })).toBeTruthy();
    expect((within(panel).getByRole("button", { name: "Resets 0" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("redeems with one click, locks duplicate clicks, and refreshes real provider samples", async () => {
    let resolveRedemption!: (value: Awaited<ReturnType<ToolbarMetricsClient["redeemResetCredit"]>>) => void;
    const client = createClient();
    client.redeemResetCredit = vi.fn(() => new Promise<Awaited<ReturnType<ToolbarMetricsClient["redeemResetCredit"]>>>(
      (resolve) => { resolveRedemption = resolve; }
    ));
    render(<ToolbarMetrics environment={environment} client={client} />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "ALL 62%" }));
    const panel = await screen.findByRole("region", { name: "Account usage details" });
    const reset = await within(panel).findByRole("button", { name: "Resets 2" });
    fireEvent.click(reset);
    fireEvent.click(reset);

    expect(await within(panel).findByRole("button", { name: "Resetting…" })).toBeTruthy();
    expect(client.redeemResetCredit).toHaveBeenCalledTimes(1);
    expect(client.redeemResetCredit).toHaveBeenCalledWith("account:one", expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    ));

    resolveRedemption({ accountId: "account:one", outcome: "RESET", completedAt: sampledAt });

    expect(await within(panel).findByText("Reset credit applied. Usage and credits were refreshed.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Account usage details" })).toBe(panel);
    await waitFor(() => expect(client.usageAccounts).toHaveBeenCalledTimes(2));
    expect(client.resetCredits).toHaveBeenCalledTimes(2);
  });

  it("stays locked until post-redemption usage and credit refreshes finish", async () => {
    let resolveCreditRefresh!: (value: Awaited<ReturnType<ToolbarMetricsClient["resetCredits"]>>) => void;
    const client = createClient();
    const availability = await client.resetCredits();
    client.resetCredits = vi.fn()
      .mockResolvedValueOnce(availability)
      .mockImplementationOnce(() => new Promise<Awaited<ReturnType<ToolbarMetricsClient["resetCredits"]>>>(
        (resolve) => { resolveCreditRefresh = resolve; }
      ));
    render(<ToolbarMetrics environment={environment} client={client} />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "ALL 62%" }));
    const panel = await screen.findByRole("region", { name: "Account usage details" });
    fireEvent.click(await within(panel).findByRole("button", { name: "Resets 2" }));

    await waitFor(() => expect(client.resetCredits).toHaveBeenCalledTimes(2));
    expect(within(panel).getByRole("button", { name: "Resetting…" })).toHaveProperty("disabled", true);

    resolveCreditRefresh(availability);
    expect(await within(panel).findByRole("button", { name: "Resets 2" })).toHaveProperty("disabled", false);
  });

  it("retries an unknown reset outcome with the exact same idempotency key", async () => {
    const client = createClient();
    client.redeemResetCredit = vi.fn()
      .mockRejectedValueOnce(new SpaceApiError("Unknown outcome", {
        code: "CODEX_RESET_OUTCOME_UNKNOWN",
        status: 503,
      }))
      .mockResolvedValueOnce({ accountId: "account:one", outcome: "ALREADY_REDEEMED", completedAt: sampledAt });
    render(<ToolbarMetrics environment={environment} client={client} />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "ALL 62%" }));
    const panel = await screen.findByRole("region", { name: "Account usage details" });
    fireEvent.click(await within(panel).findByRole("button", { name: "Resets 2" }));

    const retry = await within(panel).findByRole("button", { name: "Retry reset" });
    const firstKey = vi.mocked(client.redeemResetCredit).mock.calls[0]?.[1];
    fireEvent.click(retry);

    await waitFor(() => expect(client.redeemResetCredit).toHaveBeenCalledTimes(2));
    expect(vi.mocked(client.redeemResetCredit).mock.calls[1]?.[1]).toBe(firstKey);
    expect(await within(panel).findByText("Reset was already applied. Usage and credits were refreshed.")).toBeTruthy();
  });

  it("keeps Codex metrics visible but OFF and skips their protected fetches", () => {
    const client = createClient();
    const disabledEnvironment = { ...environment, isCodexEnabled: false };

    expect(getToolbarMetricsSnapshot(disabledEnvironment)).toMatchObject({ all: "OFF", provider: "OFF", cli: "3" });
    render(<>
      <ToolbarMetrics environment={disabledEnvironment} client={client} />
      <ToolbarMetricsSummary environment={disabledEnvironment} />
    </>);

    const all = screen.getByRole("button", { name: "ALL OFF" });
    const provider = screen.getByRole("button", { name: "Provider OFF" });
    expect((all as HTMLButtonElement).disabled).toBe(true);
    expect((provider as HTMLButtonElement).disabled).toBe(true);
    expect(all.getAttribute("title")).toBe("Enable Codex in Settings");
    expect(provider.getAttribute("title")).toBe("Enable Codex in Settings");
    expect(screen.getAllByText("OFF")).toHaveLength(4);
    expect(screen.getByRole("button", { name: /CLI 3 running/ })).toBeTruthy();
    expect(client.usageAccounts).not.toHaveBeenCalled();
    expect(client.resetCredits).not.toHaveBeenCalled();
  });

  it("loads account telemetry from keyboard focus without an earlier hover", async () => {
    const client = createClient();
    render(<ToolbarMetrics environment={environment} client={client} />);

    fireEvent.focus(screen.getByRole("button", { name: "ALL 62%" }));

    expect(await screen.findByRole("region", { name: "Account usage details" })).toBeTruthy();
    await waitFor(() => expect(client.usageAccounts).toHaveBeenCalledTimes(1));
  });

  it("shows CLI telemetry and requires confirmation before server-authoritative cleanup", async () => {
    const client = createClient();
    render(<ToolbarMetrics environment={environment} client={client} />);
    const cli = screen.getByRole("button", { name: /CLI 3 running, 2 attached, 1 detached/ });
    fireEvent.mouseEnter(cli);
    const panel = await screen.findByRole("region", { name: "CLI session details" });
    expect(within(panel).getByText("Cleanup eligible").nextSibling?.textContent).toBe("1");
    expect(within(panel).getByText(/64 MiB/)).toBeTruthy();

    fireEvent.click(cli);
    const dialog = await screen.findByRole("dialog", { name: "Clean detached CLI sessions" });
    expect(within(dialog).getByText(/detached for at least 5 minutes/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm CLI cleanup" }));
    await waitFor(() => expect(client.reapCliSessions).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole("status")).textContent).toMatch(/1 detached CLI session cleaned/i);
  });

  it("shows safe memory/process telemetry and confirms bounded reclaim", async () => {
    const client = createClient();
    render(<ToolbarMetrics environment={environment} client={client} />);
    const ram = screen.getByRole("button", { name: /RAM 75%/ });
    fireEvent.mouseEnter(ram);
    const panel = await screen.findByRole("region", { name: "Memory details" });
    expect(within(panel).getByText("codex · Fix the toolbar")).toBeTruthy();
    expect(within(panel).getAllByText(/512 MiB/)).toHaveLength(2);
    expect(within(panel).getByText(/Pressure/).nextSibling?.textContent).toBe("Yes");
    expect(within(panel).getByText("Swap").nextSibling?.textContent).toMatch(/25% · 1\.0 GiB of 4\.0 GiB/);
    expect(within(panel).getByText(/7% of used/)).toBeTruthy();
    expect(within(panel).queryByText(/CPU 5%/)).toBeNull();

    fireEvent.click(ram);
    const dialog = await screen.findByRole("dialog", { name: "Reclaim safe memory" });
    expect(within(dialog).getByText(/never kills arbitrary processes/i)).toBeTruthy();
    expect(within(dialog).getByText(/CLIs of open panes keep running/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm memory reclaim" }));
    await waitFor(() => expect(client.reclaimMemory).toHaveBeenCalledTimes(1));
    const message = (await screen.findByRole("status")).textContent;
    expect(message).toMatch(/memory reclaim completed: 1 leftover CLI session of closed panes stopped/i);
    expect(message).toMatch(/2 CLIs of open panes kept running/);
  });

  it("shows per-process CPU analysis in the CPU panel (click-opened), ordered by usage", async () => {
    const client = createClient();
    render(<ToolbarMetrics environment={environment} client={client} />);
    const cpu = screen.getByRole("button", { name: /CPU 24%/ });
    expect(cpu.getAttribute("aria-expanded")).toBe("false");
    fireEvent.mouseEnter(cpu);
    expect(screen.queryByRole("region", { name: "CPU details" })).toBeNull();
    fireEvent.click(cpu);
    const panel = await screen.findByRole("region", { name: "CPU details" });
    expect(within(panel).getByText("Usage").nextSibling?.textContent).toBe("24%");
    expect(within(panel).getByText("Cores").nextSibling?.textContent).toBe("16");
    expect(within(panel).getByText("Top processes by CPU")).toBeTruthy();
    const rows = within(panel).getAllByRole("listitem");
    expect(rows[0]?.textContent).toMatch(/postgres/);
    expect(within(rows[0]!).getByText(/CPU 42% · 64 MiB · R/)).toBeTruthy();
    expect(within(rows[1]!).getByText(/CPU 5% · 512 MiB · S/)).toBeTruthy();
    expect(client.hostMemory).toHaveBeenCalledTimes(1);
  });

  it("explains on hover that Codex runs through Space Gateway, with nothing to switch", async () => {
    const client = createClient();
    render(<ToolbarMetrics environment={environment} client={client} />);
    const provider = screen.getByRole("button", { name: "Provider GW" });
    fireEvent.mouseEnter(provider);

    const panel = await screen.findByRole("region", { name: "Provider details" });
    expect(panel.textContent).toContain("Codex runs through Space Gateway");
    expect(within(panel).queryByRole("menu")).toBeNull();
  });

  it("closes the provider details with Escape and restores focus to its trigger", async () => {
    const client = createClient();
    render(<ToolbarMetrics environment={environment} client={client} />);
    const provider = screen.getByRole("button", { name: "Provider GW" });
    expect(provider.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(provider);
    expect(provider.getAttribute("aria-expanded")).toBe("true");
    const panel = await screen.findByRole("region", { name: "Provider details" });
    panel.focus();

    fireEvent.keyDown(panel, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("region", { name: "Provider details" })).toBeNull());
    expect(provider.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(provider);
  });
});

describe("model stats MDL badge", () => {
  it("loads global model activity eagerly without requiring a selected room", async () => {
    const client = createClient();
    render(<ToolbarMetrics environment={environment} client={client} />);
    const mdl = screen.getByRole("button", { name: /global active models/i });
    expect(mdl.hasAttribute("disabled")).toBe(false);
    await waitFor(() => expect(client.modelStats).toHaveBeenCalledWith("global", 10));
    expect(mdl.textContent).toContain("2");
  });

  it("prefers the global analytics model inventory so session-only runtimes remain visible", async () => {
    const client = createClient();
    client.analyticsModels = vi.fn(async (): Promise<SystemAnalyticsModelsResponse> => ({
      range: "10m",
      sampledAt,
      providers: [{
        providerId: "anthropic",
        modelCount: 1,
        activeSessions: 1,
        completedTurns: 0,
        tokensIn: null,
        tokensOut: null,
        lastActivityAt: sampledAt
      }],
      models: [{
        providerId: "anthropic",
        modelId: "claude-sonnet-4",
        runtimeIds: ["cli:claude"],
        coverage: "SESSION_ONLY",
        activeSessions: 1,
        activeTurns: 0,
        completedTurns: 0,
        abortedTurns: 0,
        tokensIn: null,
        tokensOut: null,
        tokensReasoning: null,
        avgTtftMs: null,
        avgDurationMs: null,
        avgTokPerSec: null,
        firstActivityAt: sampledAt,
        lastActivityAt: sampledAt
      }],
      backfill: { status: "COMPLETE", earliestAt: null, latestAt: null, errors: [] }
    }));
    render(<ToolbarMetrics environment={environment} client={client} />);

    await waitFor(() => expect(client.analyticsModels).toHaveBeenCalledTimes(1));
    const mdl = screen.getByRole("button", { name: "Global active models 1" });
    fireEvent.click(mdl);
    const panel = await screen.findByRole("region", { name: "Active model details" });
    expect(within(panel).getByText("claude-sonnet-4")).toBeTruthy();
    expect(within(panel).getByText(/anthropic · SESSION ONLY · 1 session/)).toBeTruthy();
    expect(client.modelStats).not.toHaveBeenCalled();
  });

  it("loads legacy model statistics when detailed analytics fails", async () => {
    const client = createClient();
    client.analyticsModels = vi.fn(async () => { throw new Error("Analytics unavailable"); });
    render(<ToolbarMetrics environment={environment} client={client} />);
    await waitFor(() => expect(client.modelStats).toHaveBeenCalledWith("global", 10));
    expect(screen.getByRole("button", { name: /global active models/i }).textContent).toContain("2");
  });

  it("loads and renders per-model averages when a room is selected", async () => {
    const client = createClient();
    render(<ToolbarMetrics environment={environment} client={client} roomId="room:test" />);
    const mdl = screen.getByRole("button", { name: /global active models/i });
    expect(mdl.hasAttribute("disabled")).toBe(false);
    fireEvent.click(mdl);
    const panel = await screen.findByRole("region", { name: "Active model details" });
    expect(client.modelStats).toHaveBeenCalledWith("room:test", 10);
    expect(within(panel).getByText("Active models")).toBeTruthy();
    expect(within(panel).getByText("opencode/deepseek-v4-flash-free")).toBeTruthy();
    expect(within(panel).getByText("gpt-5.4-mini")).toBeTruthy();
    expect(within(panel).getByText(/2 turns · TTFT — · 38.2 tok\/s/)).toBeTruthy();
    expect(within(panel).getByText(/1 turn · TTFT 1850 ms · 112.4 tok\/s/)).toBeTruthy();
    expect(mdl.textContent).toContain("2");
  });

  it("renders red indicators for exhausted quotas, yellow for near exhaustion, and plain for safe", () => {
    const { container: c1 } = render(<QuotaIndicator value={0} label="Gemini 5h" />);
    const exhausted = c1.querySelector("strong.toolbar-metric-quota-val.is-critical");
    expect(exhausted).toBeTruthy();
    expect(exhausted?.textContent).toBe("0%");
    expect(exhausted?.querySelector(".toolbar-metric-quota-dot")).toBeTruthy();
    expect(exhausted?.getAttribute("title")).toBe("Gemini 5h: Exhausted (0%)");

    const { container: c2 } = render(<QuotaIndicator value={25} label="Gemini 5h" />);
    const warning = c2.querySelector("strong.toolbar-metric-quota-val.is-warning");
    expect(warning).toBeTruthy();
    expect(warning?.textContent).toBe("25%");
    expect(warning?.querySelector(".toolbar-metric-quota-dot")).toBeTruthy();
    expect(warning?.getAttribute("title")).toBe("Gemini 5h: Near exhaustion (25%)");

    const { container: c3 } = render(<QuotaIndicator value={100} label="Claude 5h" />);
    expect(c3.querySelector(".is-critical")).toBeNull();
    expect(c3.querySelector(".is-warning")).toBeNull();
    expect(c3.textContent).toBe("100%");
  });

  it("classifies Antigravity accounts as available, back soon or week exhausted", async () => {
    const now = Date.now();
    const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
    const group = (displayName: string, fiveHourRemainingPercent: number | null, weeklyRemainingPercent: number | null, fiveHourResetAt: string | null = null, weeklyResetAt: string | null = null) =>
      ({ displayName, fiveHourRemainingPercent, weeklyRemainingPercent, fiveHourResetAt, weeklyResetAt });
    const client = createClient();
    client.antigravityAccounts = vi.fn(async () => ({
      data: [
        { id: "account:wk", email: "wk@example.com", label: "wk", tier: "Google AI Pro", status: "CONNECTED" as const,
          gemini: group("Gemini Models", 100, 0, null, at(3 * 24 * 60)), claude: group("Claude and GPT models", 100, 0, null, at(4 * 24 * 60)), sampledAt },
        { id: "account:pir", email: "pir@example.com", label: "pir", tier: "Google AI Pro", status: "CONNECTED" as const,
          gemini: group("Gemini Models", 100, 0, null, at(3 * 24 * 60)), claude: group("Claude and GPT models", 0, 25, at(120)), sampledAt },
        { id: "account:in1", email: "in1@example.com", label: "in1", tier: "Google AI Pro", status: "CONNECTED" as const,
          gemini: group("Gemini Models", 25, 89, at(95)), claude: group("Claude and GPT models", null, null), sampledAt },
        { id: "account:bo", email: "bo@example.com", label: "bo", tier: "Google AI Pro", status: "CONNECTED" as const,
          gemini: group("Gemini Models", 0, 83, at(52)), claude: group("Claude and GPT models", 100, 100), sampledAt },
      ],
      pagination: { page: 1, pageSize: 100, totalItems: 4, totalPages: 1 },
      source: "space-gemini-profiles",
      isStale: false,
      error: null,
      checkedAt: sampledAt,
    }));

    render(<ToolbarMetrics environment={environment} client={client} />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "ALL 62%" }));
    const panel = await screen.findByRole("region", { name: "Account usage details" });
    await waitFor(() => expect(client.antigravityAccounts).toHaveBeenCalledTimes(1));
    fireEvent.click(within(panel).getByRole("tab", { name: "Antigravity (Google)" }));

    const section = within(panel).getAllByText("Antigravity (Google)").find((el) => el.tagName === "STRONG")!
      .closest(".toolbar-metric-provider-section") as HTMLElement;
    const cards = () => [...section.querySelectorAll<HTMLElement>(".account-quota-card")];
    expect(cards().map((card) => card.querySelector(".account-quota-title")?.textContent)).toEqual(["bo", "in1", "pir", "wk"]);
    expect(cards().map((card) => card.dataset.availability)).toEqual(["available", "available", "soon", "exhausted"]);
    const card = (label: string) => within(section).getByText(label, { selector: ".account-quota-title" }).closest("li") as HTMLElement;
    expect(within(card("bo")).getByText("Available")).toBeTruthy();
    expect(within(card("pir")).getByText("Back in 2h")).toBeTruthy();
    expect(within(card("wk")).getByText("Week exhausted")).toBeTruthy();
    expect(within(card("bo")).getByText("back in 52m")).toBeTruthy();
    expect(within(card("in1")).getByText("resets in 1h 35m")).toBeTruthy();

    // Both windows are always visible, each with its own tone.
    expect(within(section).getAllByTitle(/: Exhausted/).map((cell) => cell.textContent)).toEqual(["0%", "0%", "0%", "0%", "0%"]);
    expect(within(section).getAllByTitle(/: Near exhaustion/).map((cell) => cell.textContent)).toEqual(["25%", "25%"]);

    expect(within(panel).getByRole("button", { name: "All (4)" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Available (2)" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Back soon (1)" })).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Exhausted (1)" }));
    expect(cards().map((card) => card.querySelector(".account-quota-title")?.textContent)).toEqual(["wk"]);
    fireEvent.click(within(panel).getByRole("button", { name: "Back soon (1)" }));
    expect(cards().map((card) => card.querySelector(".account-quota-title")?.textContent)).toEqual(["pir"]);

    // Codex accounts use the same cards; a 30% weekly window is near exhaustion.
    fireEvent.click(within(panel).getByRole("button", { name: "All (4)" }));
    fireEvent.click(within(panel).getByRole("tab", { name: "Codex" }));
    const codexSection = within(panel).getByText("Codex usage").closest(".toolbar-metric-provider-section") as HTMLElement;
    expect(within(codexSection).getAllByTitle(/: Near exhaustion/).map((cell) => cell.textContent)).toEqual(["30%"]);
  });

  it("raises a rail alert when Space Gateway sends Claude requests through the paid API key", async () => {
    localStorage.removeItem("space:claude-api-key:announced-use-at");
    localStorage.removeItem("space:ai-quota:alarm-log");
    const client = createClient();
    const use = { fallbackEnabled: true, checkedAt: sampledAt, account: { id: `gw_account:${"d".repeat(32)}`, label: "Claude API key …kkkk", status: "ACTIVE" as const,
      createdAt: sampledAt, lastUsedAt: new Date(Date.now() - 4 * 60_000).toISOString(), requests: 2, costUsd: 0.42 } };
    client.claudeApiKeyUse = vi.fn(async () => use);
    render(<ToolbarMetrics environment={environment} client={client} />);
    await waitFor(() => expect(client.claudeApiKeyUse).toHaveBeenCalledTimes(1));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/^Claude API key in use: Space Gateway sent 2 requests through the paid key \(\$0\.42\), last 4m ago\./);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Claude API key alert" }));
    expect(screen.queryByRole("alert")).toBeNull();
    localStorage.removeItem("space:claude-api-key:announced-use-at");
    localStorage.removeItem("space:ai-quota:alarm-log");
  });

  it("stays quiet while the Claude API key was never used, and does not poll it for non-admins", async () => {
    localStorage.removeItem("space:claude-api-key:announced-use-at");
    const client = createClient();
    client.claudeApiKeyUse = vi.fn(async () => ({ fallbackEnabled: true, checkedAt: sampledAt, account: { id: `gw_account:${"d".repeat(32)}`, label: "Claude API key …kkkk",
      status: "ACTIVE" as const, createdAt: sampledAt, lastUsedAt: null, requests: 0, costUsd: 0 } }));
    const view = render(<ToolbarMetrics environment={environment} client={client} />);
    await waitFor(() => expect(client.claudeApiKeyUse).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
    view.unmount();
    render(<ToolbarMetrics environment={environment} client={client} canManage={false} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.claudeApiKeyUse).toHaveBeenCalledTimes(1);
  });

  it("lists every Claude account profile under its own provider tab", async () => {
    const now = Date.now();
    const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
    const client = createClient();
    const claudeAccount = {
      plan: "Team · Max 5x",
      fiveHourResetAt: null,
      weeklyResetAt: null,
      weeklyScope: "Fable",
      sampledAt,
    };
    client.claudeAccounts = vi.fn(async () => ({
      data: [
        { ...claudeAccount, id: "main", label: "ntheo", email: "ntheo@example.test", status: "CONNECTED" as const, fiveHourRemainingPercent: 0, fiveHourResetAt: at(47), weeklyRemainingPercent: 97, weeklyResetAt: at(4 * 24 * 60) },
        { ...claudeAccount, id: "lab", label: "lab", email: "lab@example.test", status: "CONNECTED" as const, fiveHourRemainingPercent: 20, weeklyRemainingPercent: 92 },
        { ...claudeAccount, id: "dev", label: "dev", email: "dev@example.test", status: "CONNECTED" as const, fiveHourRemainingPercent: 100, weeklyRemainingPercent: 0, weeklyResetAt: at(3 * 24 * 60) },
        { ...claudeAccount, id: "ops", label: "ops", email: "ops@example.test", status: "EXPIRED" as const, fiveHourRemainingPercent: null, weeklyRemainingPercent: null },
        { ...claudeAccount, id: "api", label: "api", email: null, plan: null, status: "NOT_CONNECTED" as const, fiveHourRemainingPercent: null, weeklyRemainingPercent: null, weeklyScope: null },
      ],
      pagination: { page: 1, pageSize: 100, totalItems: 5, totalPages: 1 },
      source: "space-claude-profiles",
      isStale: false,
      error: null,
      checkedAt: sampledAt,
    }));

    render(<ToolbarMetrics environment={environment} client={client} />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "ALL 62%" }));
    const panel = await screen.findByRole("region", { name: "Account usage details" });
    await waitFor(() => expect(client.claudeAccounts).toHaveBeenCalledTimes(1));

    fireEvent.click(within(panel).getByRole("tab", { name: "Claude" }));
    expect(within(panel).getByRole("tab", { name: "Claude" }).getAttribute("aria-selected")).toBe("true");
    expect(within(panel).queryByText("Codex usage")).toBeNull();
    const section = within(panel).getAllByText("Claude").find((el) => el.tagName === "STRONG")!
      .closest(".toolbar-metric-provider-section") as HTMLElement;
    const titles = () => [...section.querySelectorAll(".account-quota-title")].map((title) => title.textContent);
    expect(titles()).toEqual(["lab", "ntheo", "dev", "api", "ops"]);
    const card = (label: string) => within(section).getByText(label, { selector: ".account-quota-title" }).closest("li") as HTMLElement;
    expect(within(card("lab")).getByText("lab@example.test · Team · Max 5x")).toBeTruthy();
    expect(within(card("lab")).getByText("Available")).toBeTruthy();
    expect(within(card("lab")).getByText("Week · Fable")).toBeTruthy();
    expect(within(card("lab")).getByRole("meter", { name: "5h remaining" }).getAttribute("aria-valuenow")).toBe("20");
    expect(within(card("ntheo")).getByText("Back in 47m")).toBeTruthy();
    expect(within(card("dev")).getByText("Week exhausted")).toBeTruthy();
    expect(within(card("ops")).getByText("Sign-in expired")).toBeTruthy();
    expect(within(card("api")).getByText("Not signed in")).toBeTruthy();
    expect(within(card("api")).getByText("Sign in from a Claude pane that uses this profile.")).toBeTruthy();
    expect(within(section).getByTitle("1 available")).toBeTruthy();
    expect(within(section).getByTitle("1 back soon")).toBeTruthy();
    expect(within(section).getByTitle("1 exhausted")).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: "Available (1)" }));
    expect(titles()).toEqual(["lab"]);
  });

  it("shows Anthropic's bill and the last sync on the Claude API key's card", async () => {
    const client = createClient();
    client.claudeAccounts = vi.fn(async () => ({
      data: [{ id: "api", label: "api", email: null, plan: null, status: "API_KEY" as const, fiveHourRemainingPercent: null, fiveHourResetAt: null,
        weeklyRemainingPercent: null, weeklyResetAt: null, weeklyScope: null, sampledAt: null, apiKeyVerified: true, gatewayFallback: "ON" as const,
        apiKeyUsage: { requests: 2542, costUsd: 215.08, lastUsedAt: new Date(Date.now() - 8 * 3_600_000).toISOString() } }],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }, source: "space-claude-profiles", isStale: false, error: null, checkedAt: sampledAt,
    }));
    const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const row = (daysAgo: number, reported: boolean, organizationUsd: number, gatewayEstimateUsd: number) =>
      ({ day: day(daysAgo), reported, organizationUsd, workspaceUsd: organizationUsd, gatewayEstimateUsd, gatewayBilledUsd: gatewayEstimateUsd, models: [] });
    client.anthropicBilling = vi.fn(async () => ({
      status: { configured: true, keyHint: "…pgAA", savedAt: sampledAt, lastSyncAt: new Date().toISOString(), lastError: "anthropic_http_429", upstream: [] },
      days: [row(0, false, 0, 1.6864), row(1, true, 128.61, 130.65), row(20, true, 58.42, 0)],
    }));

    render(<ToolbarMetrics environment={environment} client={client} />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "ALL 62%" }));
    const panel = await screen.findByRole("region", { name: "Account usage details" });
    await waitFor(() => expect(client.anthropicBilling).toHaveBeenCalledTimes(1));
    fireEvent.click(within(panel).getByRole("tab", { name: "Claude" }));
    const card = (await within(panel).findByText("api", { selector: ".account-quota-title" })).closest("li") as HTMLElement;
    // The existing line stays; the bill and the sync follow it.
    expect(within(card).getByText(/Used 2542 times through Space Gateway \(\$215\.08\), last 8h ago\./)).toBeTruthy();
    await waitFor(() => expect(within(card).getByText(/^Anthropic bill: today \$1\.69 \(estimate\) · 7 days \$130\.30 · this month \$\d+\.\d\d · 31 days \$188\.72\.$/)).toBeTruthy());
    expect(within(card).getByText(/^Synced \d\d:\d\d /)).toBeTruthy();
    expect(within(card).getByText("The last sync failed (anthropic_http_429).")).toBeTruthy();
  });

  it("lists the Claude API's spend and every provider's balance, credit meter and details on the API tab", async () => {
    const client = createClient();
    client.apiProviderAccounts = vi.fn(async () => ({
      data: [
        { id: "anthropic", providerId: "anthropic", label: "Claude API (Anthropic)", status: "CONNECTED" as const, balance: null, currency: "USD",
          usage: "$363.10", limit: null, remainingPercent: null, detail: "Today $61.18 (estimate) · 7 days $93.27 · 31 days $363.10", sampledAt },
        { id: "openrouter", providerId: "openrouter", label: "OpenRouter", status: "CONNECTED" as const, balance: "$0.00", currency: "USD",
          usage: "$15.23", limit: "$15.00", remainingPercent: 0, detail: "Credits: $15.00 · Used: $15.23", sampledAt },
        { id: "deepseek", providerId: "deepseek", label: "DeepSeek", status: "UNCONFIGURED" as const, balance: null, currency: null, detail: "No DEEPSEEK_API_KEY found", sampledAt: null },
      ],
      pagination: { page: 1, pageSize: 3, totalItems: 3, totalPages: 1 }, isStale: false, error: null, source: "mock" as const, checkedAt: sampledAt,
    }));

    render(<ToolbarMetrics environment={environment} client={client} />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "ALL 62%" }));
    const panel = await screen.findByRole("region", { name: "Account usage details" });
    fireEvent.click(within(panel).getByRole("tab", { name: "API Providers" }));
    const claude = (await within(panel).findByText("Claude API (Anthropic)")).closest("li") as HTMLElement;
    expect(claude.className).toContain("is-available");
    expect(within(claude).getByText("$363.10")).toBeTruthy();
    expect(within(claude).getByText("Spent this month")).toBeTruthy();
    expect(within(claude).getByText("Today $61.18 (estimate)")).toBeTruthy();
    expect(within(claude).queryByRole("meter")).toBeNull();
    const openRouter = within(panel).getByText("OpenRouter").closest("li") as HTMLElement;
    expect(within(openRouter).getByText("Balance")).toBeTruthy();
    expect(within(openRouter).getByRole("meter", { name: "Left of $15.00 remaining" }).getAttribute("aria-valuenow")).toBe("0");
    expect(within(panel).getByText("DeepSeek").closest("li")!.className).toContain("is-offline");
    expect(within(panel).getByText("Not set up")).toBeTruthy();
  });

  it("leaves out the 5h cell of an account that has only a weekly limit", () => {
    const entry = (fiveHourRemainingPercent: number | null) => ({
      id: "a", title: "prolite@example.test", details: [], capacity: 100, availability: { state: "available" as const, backAt: null },
      rows: [{ key: "codex", label: null, threshold: 1, quota: { fiveHourRemainingPercent, weeklyRemainingPercent: 100, weeklyResetAt: null } }],
    });
    const { container, rerender } = render(<ul><AccountQuotaCard entry={entry(null)} clock={0} /></ul>);
    expect(screen.queryByRole("meter", { name: "5h remaining" })).toBeNull();
    expect(screen.getByRole("meter", { name: "Week remaining" })).toBeTruthy();
    expect(container.querySelector(".account-quota-cells")?.children).toHaveLength(1);
    rerender(<ul><AccountQuotaCard entry={entry(40)} clock={0} /></ul>);
    expect(screen.getByRole("meter", { name: "5h remaining" }).getAttribute("aria-valuenow")).toBe("40");
  });

  it("formats account reset countdown in minutes when reactivating in less than 3 hours", () => {
    const base = Date.parse("2026-09-21T10:00:00Z");
    const in45m = new Date(base + 45 * 60_000).toISOString();
    const in171m = new Date(base + 171 * 60_000).toISOString();
    const in4h = new Date(base + 4 * 3600_000).toISOString();

    expect(formatAccountReset(in45m, base, "5h resets")).toBe("5h resets: in 45m");
    expect(formatAccountReset(in171m, base, "5h resets")).toBe("5h resets: in 171m");
    expect(formatAccountReset(in4h, base, "5h resets")).toContain("5h resets: ");
    expect(formatAccountReset(in4h, base, "5h resets")).not.toContain("in 240m");
    expect(formatAccountReset(new Date(base - 1000).toISOString(), base, "5h resets")).toBe("5h resets: ready");
    expect(formatAccountReset(null, base, "5h resets")).toBe("5h resets unavailable");
  });

  it("filters to show only pro accounts when Pro accounts filter is toggled", async () => {
    const sampledAt = new Date().toISOString();
    const client = createClient();
    client.antigravityAccounts = vi.fn(async () => ({
      data: [
        {
          id: "account:pro1",
          email: "pro1@example.com",
          label: "Pro Account",
          tier: "Google AI Pro",
          status: "CONNECTED" as const,
          gemini: { displayName: "Gemini", fiveHourRemainingPercent: 80, weeklyRemainingPercent: 90, fiveHourResetAt: null, weeklyResetAt: null },
          claude: { displayName: "Claude", fiveHourRemainingPercent: 80, weeklyRemainingPercent: 90, fiveHourResetAt: null, weeklyResetAt: null },
          sampledAt,
        },
        {
          id: "account:free1",
          email: "free1@example.com",
          label: "Free Account",
          tier: "Antigravity",
          status: "CONNECTED" as const,
          gemini: { displayName: "Gemini", fiveHourRemainingPercent: 80, weeklyRemainingPercent: 90, fiveHourResetAt: null, weeklyResetAt: null },
          claude: { displayName: "Claude", fiveHourRemainingPercent: 80, weeklyRemainingPercent: 90, fiveHourResetAt: null, weeklyResetAt: null },
          sampledAt,
        },
      ],
      pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
      source: "space-gemini-profiles",
      isStale: false,
      error: null,
      checkedAt: sampledAt,
    }));

    render(<ToolbarMetrics environment={environment} client={client} />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "ALL 62%" }));
    const panel = await screen.findByRole("region", { name: "Account usage details" });
    await waitFor(() => expect(client.antigravityAccounts).toHaveBeenCalledTimes(1));

    const getAntigravitySection = () =>
      within(panel)
        .getAllByText("Antigravity (Google)")
        .find((el) => el.tagName === "STRONG")!
        .closest(".toolbar-metric-provider-section") as HTMLElement;

    // Initially both accounts are visible
    expect(within(getAntigravitySection()).getByText("Pro Account")).toBeTruthy();
    // On non-Antigravity providers (Codex), Pro accounts and Gemini only filters are hidden
    const codexTab = within(panel).getByRole("tab", { name: "Codex" });
    fireEvent.click(codexTab);
    expect(within(panel).queryByRole("button", { name: "Pro accounts" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Gemini only" })).toBeNull();

    // Switch to Antigravity tab
    const antigravityTab = within(panel).getByRole("tab", { name: "Antigravity (Google)" });
    fireEvent.click(antigravityTab);

    const proBtn = within(panel).getByRole("button", { name: "Pro accounts" });
    expect(proBtn.getAttribute("aria-pressed")).toBe("false");

    // Click Pro accounts filter
    fireEvent.click(proBtn);
    expect(proBtn.getAttribute("aria-pressed")).toBe("true");

    // Only Pro Account should remain visible
    expect(within(getAntigravitySection()).getByText("Pro Account")).toBeTruthy();
    expect(within(getAntigravitySection()).queryByText("Free Account")).toBeNull();

    // Toggle off restores Free Account
    fireEvent.click(proBtn);
    expect(proBtn.getAttribute("aria-pressed")).toBe("false");
    expect(within(getAntigravitySection()).getByText("Pro Account")).toBeTruthy();
    expect(within(getAntigravitySection()).getByText("Free Account")).toBeTruthy();
  });

  it("filters to show only accounts with Gemini and hides Claude when Gemini only filter is toggled", async () => {
    const sampledAt = new Date().toISOString();
    const client = createClient();
    client.antigravityAccounts = vi.fn(async () => ({
      data: [
        {
          id: "account:gemini-and-claude",
          email: "both@example.com",
          label: "Both Provider Account",
          tier: "Google AI Pro",
          status: "CONNECTED" as const,
          gemini: { displayName: "Gemini", fiveHourRemainingPercent: 80, weeklyRemainingPercent: 90, fiveHourResetAt: null, weeklyResetAt: null },
          claude: { displayName: "Claude", fiveHourRemainingPercent: 80, weeklyRemainingPercent: 90, fiveHourResetAt: null, weeklyResetAt: null },
          sampledAt,
        },
        {
          id: "account:claude-only",
          email: "claude@example.com",
          label: "Claude Only Account",
          tier: "Google AI Pro",
          status: "CONNECTED" as const,
          gemini: { displayName: "Gemini", fiveHourRemainingPercent: null, weeklyRemainingPercent: null, fiveHourResetAt: null, weeklyResetAt: null },
          claude: { displayName: "Claude", fiveHourRemainingPercent: 80, weeklyRemainingPercent: 90, fiveHourResetAt: null, weeklyResetAt: null },
          sampledAt,
        },
      ],
      pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
      source: "space-gemini-profiles",
      isStale: false,
      error: null,
      checkedAt: sampledAt,
    }));

    render(<ToolbarMetrics environment={environment} client={client} />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "ALL 62%" }));
    const panel = await screen.findByRole("region", { name: "Account usage details" });
    await waitFor(() => expect(client.antigravityAccounts).toHaveBeenCalledTimes(1));

    const getAntigravitySection = () =>
      within(panel)
        .getAllByText("Antigravity (Google)")
        .find((el) => el.tagName === "STRONG")!
        .closest(".toolbar-metric-provider-section") as HTMLElement;

    // Both accounts visible initially, with both Gemini and Claude
    expect(within(getAntigravitySection()).getByText("Both Provider Account")).toBeTruthy();
    expect(within(getAntigravitySection()).getByText("Claude Only Account")).toBeTruthy();
    expect(within(getAntigravitySection()).getAllByText("Claude · GPT")).toHaveLength(2);

    // On non-Antigravity providers (Codex), Pro accounts and Gemini only filters are hidden
    const codexTab = within(panel).getByRole("tab", { name: "Codex" });
    fireEvent.click(codexTab);
    expect(within(panel).queryByRole("button", { name: "Pro accounts" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Gemini only" })).toBeNull();

    // Switch to Antigravity tab
    const antigravityTab = within(panel).getByRole("tab", { name: "Antigravity (Google)" });
    fireEvent.click(antigravityTab);

    const geminiBtn = within(panel).getByRole("button", { name: "Gemini only" });
    expect(geminiBtn.getAttribute("aria-pressed")).toBe("false");
    expect(geminiBtn.classList.contains("is-active")).toBe(false);

    // Click Gemini only filter
    fireEvent.click(geminiBtn);
    expect(geminiBtn.getAttribute("aria-pressed")).toBe("true");
    expect(geminiBtn.classList.contains("is-active")).toBe(true);

    // Only Both Provider Account should remain visible; Claude Only Account is filtered out
    expect(within(getAntigravitySection()).getByText("Both Provider Account")).toBeTruthy();
    expect(within(getAntigravitySection()).queryByText("Claude Only Account")).toBeNull();

    // Inside Both Provider Account, Claude quota item must be hidden
    expect(within(getAntigravitySection()).getByText("Gemini")).toBeTruthy();
    expect(within(getAntigravitySection()).queryByText("Claude · GPT")).toBeNull();

    // Toggle off restores Claude Only Account and Claude quota display
    fireEvent.click(geminiBtn);
    expect(geminiBtn.getAttribute("aria-pressed")).toBe("false");
    expect(geminiBtn.classList.contains("is-active")).toBe(false);
    expect(within(getAntigravitySection()).getByText("Both Provider Account")).toBeTruthy();
    expect(within(getAntigravitySection()).getByText("Claude Only Account")).toBeTruthy();
    expect(within(getAntigravitySection()).getAllByText("Claude · GPT")).toHaveLength(2);
  });
});
