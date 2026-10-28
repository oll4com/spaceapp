import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, MonitoringCopilotPaneMetadata, MonitoringEvent, Pane } from "@space/contracts";
import { defaultMonitoringCopilotPaneMetadata } from "@space/contracts";
import { MonitoringCopilotPane, tabsForLayout } from "../src/features/monitoring-copilot-pane/MonitoringCopilotPane.js";
import { MONITORING_COPILOT_KIND, copilotKindForMode } from "../src/features/copilot-kit/copilot-kind.js";
import type { MonitoringAlertView, MonitoringCopilotState } from "../src/features/monitoring-copilot-pane/types.js";

const apiMock = vi.hoisted(() => ({
  monitoringCopilotState: vi.fn(),
  monitoringCopilotTargets: vi.fn(),
  updateMonitoringCopilotSettings: vi.fn(),
  createMonitoringCopilotBrief: vi.fn(),
  answerMonitoringCopilotQuestion: vi.fn(),
  decideMonitoringCopilotReview: vi.fn(),
  monitoringCopilotMemory: vi.fn(),
  createMonitoringCopilotMemory: vi.fn(),
  deleteMonitoringCopilotMemory: vi.fn(),
  checkMonitoringCopilotNow: vi.fn(),
  monitoringCopilotRun: vi.fn(),
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
  detectedCommandPath: null, defaultModelId: null, supportedReasoningEfforts: [], checkedAt: "2026-10-25T08:00:00.000Z"
}) as unknown as AgentRuntime;
const registry = { data: [runtime("cli:claude", "Claude Code CLI")], checkedAt: "2026-10-25T08:00:00.000Z" };
const at = "2026-10-25T08:00:00.000Z";
const pane = { id: "pane:monitoring01", roomId: "room:monitoring01", title: "Monitoring Copilot", titleSource: "auto", mode: "MONITORING_COPILOT", status: "IDLE",
  providerId: null, modelId: null, reasoningEffort: "medium", cwd: null, order: 0, columnSpan: 1, isMaximized: false, isMinimized: false, isClosed: false,
  split: { parentId: null, direction: null, size: null }, categoryColor: null, vncTarget: null, terminalRuntimeId: "cli:claude", createdAt: at, updatedAt: at } as unknown as Pane;
const event = (id: string, type: MonitoringEvent["type"], status: MonitoringEvent["status"], message: string, payload: Record<string, unknown> = {}): MonitoringEvent =>
  ({ id, ownerUserId: "user:operator", paneId: pane.id, type, status, message, payload, createdAt: at, updatedAt: at });
const alert = (id: string, alertname: string, severity: MonitoringAlertView["severity"], state: MonitoringAlertView["state"] = "FIRING"): MonitoringAlertView => ({
  id, alertname, severity, source: "PROMETHEUS", instance: "192.168.10.1:443", job: "static_blackbox_tcp", summary: `${alertname} summary`, description: `${alertname} description`,
  labels: { alertname, severity: severity.toLowerCase(), team: "netops" }, state, startsAt: at, endsAt: state === "RESOLVED" ? at : null, lastSeenAt: at
});
function state(metadata: MonitoringCopilotPaneMetadata = defaultMonitoringCopilotPaneMetadata()): MonitoringCopilotState {
  return {
    metadata, run: { status: "IDLE", paused: false, autonomy: metadata.settings.autonomy, openQuestions: 1, openReviews: 0, pendingBriefs: 0 },
    summary: { firing: { CRITICAL: 1, WARNING: 1, INFO: 0 }, top: [], collector: { reachable: true, lastOkAt: at, lastError: null, downSince: null } },
    actions: [],
    alerts: [alert("monalert:crit0001", "OpenwrtHttpsProbeDown", "CRITICAL"), alert("monalert:warn0001", "ThailandPathHighLatency", "WARNING"), alert("monalert:old00001", "TargetDown", "CRITICAL", "RESOLVED")],
    events: [
      event("monevt:question1", "QUESTION", "OPEN", "Silence the RDP probe alerts tonight?", { options: ["Yes", "No"] }),
      event("monevt:guardian1", "GUARDIAN", null, "OVPN DOWN (office-mikrotik) reason=degraded_session", { level: "ALERT" }),
      event("monevt:alert0001", "ALERT", null, "Firing: OpenwrtHttpsProbeDown on 192.168.10.1:443")
    ]
  };
}

describe("MonitoringCopilotPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    apiMock.monitoringCopilotState.mockResolvedValue(state());
    apiMock.monitoringCopilotTargets.mockResolvedValue({ targets: [
      { job: "proxmox_host", instance: "192.0.2.1:9100", health: "up", lastError: "", lastScrape: at, scrapeSeconds: 0.01 },
      { job: "static_blackbox_tcp", instance: "192.0.2.20:3389", health: "down", lastError: "context deadline exceeded", lastScrape: at, scrapeSeconds: 5 }] });
    apiMock.updateMonitoringCopilotSettings.mockImplementation(async (_paneId: string, next: MonitoringCopilotPaneMetadata) => ({ metadata: next }));
    apiMock.answerMonitoringCopilotQuestion.mockResolvedValue({ question: event("monevt:question1", "QUESTION", "ANSWERED", "x") });
    apiMock.decideMonitoringCopilotReview.mockResolvedValue({ review: event("monevt:review001", "REVIEW", "APPROVED", "x") });
    apiMock.createMonitoringCopilotBrief.mockResolvedValue({ brief: event("monevt:brief0001", "BRIEF", "PENDING", "x"), kickoffSent: false });
    apiMock.monitoringCopilotMemory.mockResolvedValue({ memories: [] });
    apiMock.checkMonitoringCopilotNow.mockResolvedValue({ owners: 1, fired: 0, resolved: 0, guardian: 0 });
    apiMock.userSettings.mockResolvedValue({ monitoringCopilot: null });
    apiMock.cliRuntimes.mockResolvedValue(registry);
    apiMock.cliRuntimesSnapshot.mockReturnValue(registry);
    apiMock.listCliAccountProfiles.mockResolvedValue({ runtimeId: "cli:claude", profiles: [{ profileId: "main", displayName: "Main" }], gatewayProfile: null, defaultProfileId: "main" });
    apiMock.activeCliSession.mockResolvedValue({ session: { runtimeId: "cli:claude", accountProfileId: "main" } });
  });
  afterEach(() => cleanup());

  it("is a copilot kind on Claude Code with the alerts as its main surface", () => {
    expect(copilotKindForMode("MONITORING_COPILOT")).toBe(MONITORING_COPILOT_KIND);
    expect(MONITORING_COPILOT_KIND).toMatchObject({ label: "Monitoring Copilot", preferredRuntimeId: "cli:claude", settingsKey: "monitoringCopilot", controlPrefix: "monitoring-copilot" });
    expect(tabsForLayout("split")).toEqual(["activity", "targets", "memory", "setup", "terminal"]);
    expect(tabsForLayout("stacked")[0]).toBe("alerts");
  });

  it("shows firing alerts by severity, the 30-day history on request, and answers a question", async () => {
    render(<MonitoringCopilotPane pane={pane} isVisible terminal={<div data-testid="terminal" />} />);
    const firing = await screen.findByRole("list", { name: "Firing alerts" });
    expect(within(firing).getByText("OpenwrtHttpsProbeDown")).toBeTruthy();
    expect(within(firing).getByText("ThailandPathHighLatency")).toBeTruthy();
    expect(within(firing).queryByText("TargetDown")).toBeNull();
    expect(screen.getByText("1 critical · 1 warnings")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Critical$/ }));
    expect(within(screen.getByRole("list", { name: "Firing alerts" })).queryByText("ThailandPathHighLatency")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Resolved \(30 days\)/ }));
    expect(within(screen.getByRole("list", { name: "Resolved alerts" })).getByText("TargetDown")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Yes" }));
    await waitFor(() => expect(apiMock.answerMonitoringCopilotQuestion).toHaveBeenCalledWith(pane.id, "monevt:question1", "Yes"));
    expect(screen.getByText("OVPN DOWN (office-mikrotik) reason=degraded_session")).toBeTruthy();
  });

  it("lists the targets that are not up and keeps the collector on the private bridge in Setup", async () => {
    render(<MonitoringCopilotPane pane={pane} isVisible terminal={<div />} />);
    await screen.findByRole("list", { name: "Firing alerts" });
    fireEvent.click(screen.getByRole("tab", { name: /Targets/ }));
    const targets = await screen.findByRole("list", { name: "Collector targets" });
    expect(within(targets).getByText("192.0.2.20:3389")).toBeTruthy();
    expect(within(targets).queryByText("192.0.2.1:9100")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /Setup/ }));
    const loki = await screen.findByLabelText(/^Loki/);
    fireEvent.change(loki, { target: { value: "http://169.254.169.254:80" } });
    expect((screen.getByRole("button", { name: "Save collector" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(loki, { target: { value: "http://192.0.2.202:3100" } });
    fireEvent.click(screen.getByRole("button", { name: "Save collector" }));
    await waitFor(() => expect(apiMock.updateMonitoringCopilotSettings).toHaveBeenCalledWith(pane.id, expect.objectContaining({
      settings: expect.objectContaining({ collector: expect.objectContaining({ lokiUrl: "http://192.0.2.202:3100" }) }) })));
  });

  it("asks the operator about a held change, shows what the copilot changed, and sets its autonomy in Setup", async () => {
    const held = state();
    held.run.openReviews = 1;
    held.events.unshift(event("monevt:review001", "REVIEW", "OPEN", "SERVICE_RESTART on vm100: Restart LiteSpeed", {
      target: "vm100", commands: "ssh vm100 systemctl restart lshttpd", rollback: "ask the operator", reason: "The pane is on Assist: every change waits for the operator." }));
    held.actions = [{ id: "monact:failed001", ownerUserId: "user:operator", paneId: pane.id, target: "qm:100", alertIds: [], kind: "GUEST_START", summary: "Start public-host",
      commands: "ssh pve qm start 100", backup: "", rollback: "qm stop 100", gate: "GO", reason: null, status: "FAILED", verification: "public-host did not answer on http://192.0.2.2",
      reviewEventId: null, startedAt: at, finishedAt: at }];
    apiMock.monitoringCopilotState.mockResolvedValue(held);
    render(<MonitoringCopilotPane pane={pane} isVisible terminal={<div />} />);
    const card = await screen.findByRole("region", { name: "A change waiting for your approval" });
    expect(within(card).getByText("ssh vm100 systemctl restart lshttpd")).toBeTruthy();
    expect(within(card).getByText("vm100")).toBeTruthy();
    fireEvent.change(within(card).getByLabelText(/Note/), { target: { value: "only after 23:00" } });
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(apiMock.decideMonitoringCopilotReview).toHaveBeenCalledWith(pane.id, "monevt:review001", true, "only after 23:00"));
    const changes = screen.getByRole("region", { name: "Changes the watch officer made" });
    expect(within(changes).getByText("Guest start on qm:100")).toBeTruthy();
    expect(within(changes).getByText("Failed")).toBeTruthy();
    expect(within(changes).getByText("public-host did not answer on http://192.0.2.2")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Setup/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Autonomy/ }));
    const toggle = await screen.findByRole("switch", { name: /Fix on its own/ });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(apiMock.updateMonitoringCopilotSettings).toHaveBeenCalledWith(pane.id, expect.objectContaining({ settings: expect.objectContaining({ autonomy: "FULL" }) })));
  });
});
