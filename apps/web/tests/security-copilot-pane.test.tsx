import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, Pane, SecurityCopilotPaneMetadata, SecurityEvent } from "@space/contracts";
import { defaultSecurityCopilotPaneMetadata } from "@space/contracts";
import { SecurityCopilotPane, tabsForLayout } from "../src/features/security-copilot-pane/SecurityCopilotPane.js";
import { SECURITY_COPILOT_KIND, copilotKindForMode } from "../src/features/copilot-kit/copilot-kind.js";
import type { SecurityCopilotState } from "../src/features/security-copilot-pane/types.js";

const apiMock = vi.hoisted(() => ({
  securityCopilotState: vi.fn(),
  updateSecurityCopilotSettings: vi.fn(),
  createSecurityCopilotBrief: vi.fn(),
  answerSecurityCopilotQuestion: vi.fn(),
  decideSecurityCopilotReview: vi.fn(),
  updateSecurityCopilotFinding: vi.fn(),
  securityCopilotMemory: vi.fn(),
  createSecurityCopilotMemory: vi.fn(),
  deleteSecurityCopilotMemory: vi.fn(),
  checkSecurityCopilotNow: vi.fn(),
  securityCopilotRun: vi.fn(),
  userSettings: vi.fn(),
  updateUserSettings: vi.fn(),
  cliRuntimes: vi.fn(),
  cliRuntimesSnapshot: vi.fn(),
  listCliAccountProfiles: vi.fn(),
  activeCliSession: vi.fn()
}));
vi.mock("../src/api.js", () => ({ api: apiMock }));
vi.mock("../src/runtime/SpaceRuntime.js", () => ({ getSpaceRuntime: () => ({ platform: { localStorage: window.localStorage } }) }));

const runtime = (id: string, displayName: string) => ({
  id, providerId: id.slice(4), providerName: displayName, agentId: id.slice(4), agentName: displayName, displayName, capabilities: ["CLI"], adapterStatus: "ENABLED",
  authMode: "BROWSER_OAUTH", authState: "READY", authReason: "ok", canStartLogin: false, status: "ENABLED", statusReason: "Ready", commandName: null,
  detectedCommandPath: null, defaultModelId: null, supportedReasoningEfforts: [], checkedAt: "2026-10-24T08:00:00.000Z"
}) as unknown as AgentRuntime;
const registry = { data: [runtime("cli:claude", "Claude Code CLI")], checkedAt: "2026-10-24T08:00:00.000Z" };
const at = "2026-10-24T08:00:00.000Z";
const pane = { id: "pane:security0001", roomId: "room:security0001", title: "Security Copilot", titleSource: "auto", mode: "SECURITY_COPILOT", status: "IDLE",
  providerId: null, modelId: null, reasoningEffort: "medium", cwd: null, order: 0, columnSpan: 1, isMaximized: false, isMinimized: false, isClosed: false,
  split: { parentId: null, direction: null, size: null }, categoryColor: null, vncTarget: null, terminalRuntimeId: "cli:claude", createdAt: at, updatedAt: at } as unknown as Pane;
const event = (id: string, type: SecurityEvent["type"], status: SecurityEvent["status"], message: string, payload: Record<string, unknown> = {}): SecurityEvent =>
  ({ id, ownerUserId: "user:operator", paneId: pane.id, type, status, message, payload, createdAt: at, updatedAt: at });
const host = { id: "sechost:vm100abc", ownerUserId: "user:operator", alias: "vm100", label: "public-host almalinux8-plesk", reach: "SSH", osFamily: "ALMALINUX", osVersion: "8.10", kernel: "4.18",
  status: "ACTIVE", inventoryAt: at, note: null, createdAt: at, updatedAt: at, packages: 1298, pendingSecurity: 90, rebootRequired: true, openFindings: 2 } as const;
const finding = (id: string, priority: "P0" | "P2", advisoryId: string, kev: boolean) => ({ id, hostId: host.id, advisoryId, package: "kernel", installedVersion: "4.18.0-553.159", fixedVersion: "4.18.0-553.177",
  priority, status: "NEW" as const, sources: kev ? ["DISTRO", "KEV"] : ["DISTRO"], severity: "HIGH", cvss: null, kev, aliases: ["CVE-2026-1111"], title: "AlmaLinux security update for kernel", references: [], confirmedBy: null, firstSeenAt: at });
function state(metadata: SecurityCopilotPaneMetadata = defaultSecurityCopilotPaneMetadata()): SecurityCopilotState {
  return {
    metadata, run: { status: "IDLE", paused: false, autonomy: metadata.settings.autonomy, openQuestions: 0, openReviews: 1, pendingBriefs: 0 },
    summary: { openFindings: { P0: 1, P1: 0, P2: 1, P3: 0 }, hosts: { total: 1, active: 1, inventoried: 1, rebootRequired: ["public-host almalinux8-plesk"] }, feeds: { KEV: { lastOkAt: at, lastError: null } } },
    hosts: [host as unknown as SecurityCopilotState["hosts"][number]], actions: [],
    findings: [finding("secfind:kev00001", "P0", "ALSA-2026:70402", true), finding("secfind:plain001", "P2", "ALSA-2026:87375", false)],
    events: [event("secevt:review001", "REVIEW", "OPEN", "HOST_REBOOT on public-host almalinux8-plesk: reboot into the patched kernel",
      { actionId: "secact:reboot01", commands: "reboot", rollback: "boot the previous kernel", reason: "HOST_REBOOT always waits for the operator." })]
  };
}

describe("SecurityCopilotPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    apiMock.securityCopilotState.mockResolvedValue(state());
    apiMock.updateSecurityCopilotSettings.mockImplementation(async (_paneId: string, next: SecurityCopilotPaneMetadata) => ({ metadata: next }));
    apiMock.decideSecurityCopilotReview.mockResolvedValue({ review: event("secevt:review001", "REVIEW", "APPROVED", "x") });
    apiMock.updateSecurityCopilotFinding.mockResolvedValue({ finding: finding("secfind:plain001", "P2", "ALSA-2026:87375", false) });
    apiMock.securityCopilotMemory.mockResolvedValue({ memories: [] });
    apiMock.checkSecurityCopilotNow.mockResolvedValue({ owners: 1, newFindings: 0, kicked: 0 });
    apiMock.userSettings.mockResolvedValue({ securityCopilot: null });
    apiMock.cliRuntimes.mockResolvedValue(registry);
    apiMock.cliRuntimesSnapshot.mockReturnValue(registry);
    apiMock.listCliAccountProfiles.mockResolvedValue({ runtimeId: "cli:claude", profiles: [{ profileId: "main", displayName: "Main" }], gatewayProfile: null, defaultProfileId: "main" });
    apiMock.activeCliSession.mockResolvedValue({ session: { runtimeId: "cli:claude", accountProfileId: "main" } });
  });
  afterEach(() => cleanup());

  it("is a copilot kind on Claude Code with the findings as its main surface", () => {
    expect(copilotKindForMode("SECURITY_COPILOT")).toBe(SECURITY_COPILOT_KIND);
    expect(SECURITY_COPILOT_KIND).toMatchObject({ label: "Security Copilot", preferredRuntimeId: "cli:claude", settingsKey: "securityCopilot" });
    expect(tabsForLayout("split")).toEqual(["activity", "hosts", "memory", "setup", "terminal"]);
    expect(tabsForLayout("stacked")[0]).toBe("findings");
  });

  it("shows the findings by priority, the reboot warning and the held change, and approves it", async () => {
    render(<SecurityCopilotPane pane={pane} isVisible terminal={<div data-testid="terminal" />} />);
    const findings = await screen.findByRole("list", { name: "Open findings" });
    expect(within(findings).getByText("ALSA-2026:70402")).toBeTruthy();
    expect(within(findings).getByText("Exploited")).toBeTruthy();
    expect(screen.getByText(/Reboot pending on public-host/)).toBeTruthy();
    expect(screen.getByText("Fully autonomous")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /P2 · High/ }));
    expect(within(screen.getByRole("list", { name: "Open findings" })).queryByText("ALSA-2026:70402")).toBeNull();

    const review = await screen.findByRole("region", { name: "A change waiting for your approval" });
    expect(within(review).getByText("reboot")).toBeTruthy();
    fireEvent.click(within(review).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(apiMock.decideSecurityCopilotReview).toHaveBeenCalledWith(pane.id, "secevt:review001", true, undefined));
  });

  it("needs a reason before the operator changes a finding's status", async () => {
    render(<SecurityCopilotPane pane={pane} isVisible terminal={<div />} />);
    fireEvent.click(await screen.findByText("ALSA-2026:87375"));
    const accept = screen.getByRole("button", { name: "Accept the risk" });
    expect((accept as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Your decision and why"), { target: { value: "Test VM, rebuilt weekly" } });
    fireEvent.click(accept);
    await waitFor(() => expect(apiMock.updateSecurityCopilotFinding).toHaveBeenCalledWith(pane.id, "secfind:plain001", "ACCEPTED", "Test VM, rebuilt weekly"));
  });

  it("starts the run from the command bar and then offers Pause and Stop", async () => {
    apiMock.securityCopilotRun.mockResolvedValue({ ...state().run, status: "RUNNING", kickoffSent: true });
    render(<SecurityCopilotPane pane={pane} isVisible terminal={<div />} />);
    await screen.findByRole("list", { name: "Open findings" });
    apiMock.securityCopilotState.mockResolvedValue({ ...state(), run: { ...state().run, status: "RUNNING" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(apiMock.securityCopilotRun).toHaveBeenCalledWith(pane.id, "start"));
    expect(await screen.findByText("Run started: the agent got its kickoff.")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("switches the pane to Assist from Setup", async () => {
    render(<SecurityCopilotPane pane={pane} isVisible terminal={<div />} />);
    await screen.findByRole("list", { name: "Open findings" });
    fireEvent.click(screen.getByRole("tab", { name: /Setup/ }));
    fireEvent.click(await screen.findByRole("switch", { name: /Fully autonomous/ }));
    await waitFor(() => expect(apiMock.updateSecurityCopilotSettings).toHaveBeenCalled());
    expect(apiMock.updateSecurityCopilotSettings.mock.calls.at(-1)![1].settings.autonomy).toBe("ASSIST");
  });
});
