import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, FreelanceCopilotPaneMetadata, FreelanceLead, FreelanceMessage, Pane } from "@space/contracts";
import { defaultFreelanceCopilotPaneMetadata } from "@space/contracts";
import { FreelanceCopilotPane, resolveActiveTab, tabsForLayout } from "../src/features/freelance-copilot-pane/FreelanceCopilotPane.js";
import { FREELANCE_COPILOT_KIND, copilotKindForMode } from "../src/features/copilot-kit/copilot-kind.js";

const apiMock = vi.hoisted(() => ({
  freelanceCopilotSettings: vi.fn(),
  updateFreelanceCopilotSettings: vi.fn(),
  userSettings: vi.fn(),
  updateUserSettings: vi.fn(),
  cliRuntimes: vi.fn(),
  cliRuntimesSnapshot: vi.fn(),
  listCliAccountProfiles: vi.fn(),
  updatePane: vi.fn(),
  createCliSession: vi.fn(),
  activeCliSession: vi.fn(),
  freelanceCopilotRun: vi.fn(),
  freelanceCopilotRunAction: vi.fn(),
  freelanceEvents: vi.fn(),
  freelanceLeads: vi.fn(),
  freelanceFunnel: vi.fn(),
  freelanceAccounts: vi.fn(),
  updateFreelanceAccount: vi.fn(),
  freelanceMailbox: vi.fn(),
  connectFreelanceMailbox: vi.fn(),
  createFreelanceBrief: vi.fn(),
  decideFreelanceMessage: vi.fn(),
  decideFreelanceLead: vi.fn(),
  freelanceMemory: vi.fn(),
  browserHandoff: vi.fn(),
  navigateBrowser: vi.fn(),
  cliGlobalEgress: vi.fn(),
  marketingBookmarks: vi.fn(),
  openMarketingBookmark: vi.fn(),
  browserAccounts: vi.fn()
}));
vi.mock("../src/api.js", () => ({ api: apiMock }));
vi.mock("../src/runtime/SpaceRuntime.js", () => ({ getSpaceRuntime: () => ({ platform: { localStorage: window.localStorage } }) }));

function runtime(id: string, displayName: string): AgentRuntime {
  return {
    id, providerId: id.slice(4), providerName: displayName, agentId: id.slice(4), agentName: displayName, displayName, capabilities: ["CLI"],
    adapterStatus: "ENABLED", authMode: "BROWSER_OAUTH", authState: "READY", authReason: "ok", canStartLogin: false,
    status: "ENABLED", statusReason: "Ready", commandName: null, detectedCommandPath: null, defaultModelId: null,
    supportedReasoningEfforts: [], checkedAt: "2026-10-14T08:00:00.000Z"
  } as AgentRuntime;
}
const registry = { data: [runtime("cli:opencode", "OpenCode CLI"), runtime("cli:claude", "Claude Code CLI")], checkedAt: "2026-10-14T08:00:00.000Z" };
const pane: Pane = {
  id: "pane:fl0000001", roomId: "room:fl0000001", title: "Freelance Copilot 1", titleSource: "auto", mode: "FREELANCE_COPILOT", status: "IDLE",
  providerId: null, modelId: null, reasoningEffort: "medium", cwd: null, order: 0, columnSpan: 1, isMaximized: false, isMinimized: false,
  isClosed: false, split: { parentId: null, direction: null, size: null }, categoryColor: null, vncTarget: null, terminalRuntimeId: "cli:claude",
  createdAt: "2026-10-14T08:00:00.000Z", updatedAt: "2026-10-14T08:00:00.000Z"
} as Pane;
const at = "2026-10-14T08:00:00.000Z";
const lead = { id: "fllead:abc123", ownerUserId: "user:operator", paneId: pane.id, channel: "UPWORK", url: "https://www.upwork.com/jobs/~01", externalId: "~01", title: "MCP server for Shopify",
  client: "Acme", description: null, budget: "$2,000 fixed", score: 82, status: "CLIENT_READY", nextActionAt: null, contractValue: null, notes: null,
  payload: { clientReadySummary: "Offer coming: $2,000 fixed, start Monday." }, createdAt: at, updatedAt: at } as FreelanceLead;
const message = { id: "flmsg:abc123", ownerUserId: "user:operator", paneId: pane.id, leadId: "fllead:def456", channel: "FIVERR", direction: "OUT", kind: "MESSAGE", body: "Happy to help with the integration.",
  bid: null, connects: null, status: "IN_REVIEW", reviewNote: null, ruleId: null, sentUrl: null, sentAt: null, evidence: {}, createdAt: at, updatedAt: at } as FreelanceMessage;

describe("FreelanceCopilotPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    apiMock.freelanceCopilotSettings.mockResolvedValue({ metadata: defaultFreelanceCopilotPaneMetadata() });
    apiMock.updateFreelanceCopilotSettings.mockImplementation(async (_paneId: string, next: FreelanceCopilotPaneMetadata) => ({ metadata: next }));
    apiMock.userSettings.mockResolvedValue({ freelanceCopilot: null });
    apiMock.cliRuntimes.mockResolvedValue(registry);
    apiMock.cliRuntimesSnapshot.mockReturnValue(registry);
    apiMock.listCliAccountProfiles.mockResolvedValue({ runtimeId: "cli:claude", profiles: [{ profileId: "main", displayName: "Main" }], gatewayProfile: null, defaultProfileId: "main" });
    apiMock.activeCliSession.mockResolvedValue({ session: { runtimeId: "cli:claude", accountProfileId: "main" } });
    apiMock.freelanceCopilotRun.mockResolvedValue({ run: null, status: "IDLE", pending: [], backlog: 0 });
    apiMock.freelanceCopilotRunAction.mockResolvedValue({ run: null, status: "RUNNING", pending: [], backlog: 1 });
    apiMock.freelanceEvents.mockResolvedValue({ events: [] });
    apiMock.freelanceLeads.mockResolvedValue({ leads: [] });
    apiMock.freelanceFunnel.mockResolvedValue({ channels: { UPWORK: { leads: 1, proposed: 1, talking: 1, clientReady: 1, won: 0, lost: 0, sent: 3 } }, connectsToday: 16, connectsMonth: 48, revenue: 0, firstSentAt: at });
    apiMock.freelanceAccounts.mockResolvedValue({ accounts: [{ ownerUserId: "user:operator", channel: "UPWORK", status: "NEEDS_OPERATOR", email: "upwork@example.invalid", profileUrl: null, notes: "Identity check", updatedAt: at }] });
    apiMock.updateFreelanceAccount.mockImplementation(async (_paneId: string, input: { channel: string; status: string }) => ({ account: { ownerUserId: "user:operator", channel: input.channel, status: input.status, email: null, profileUrl: null, notes: null, updatedAt: at } }));
    apiMock.freelanceMailbox.mockResolvedValue({ connected: false, config: null, lastUid: null, updatedAt: null });
    apiMock.connectFreelanceMailbox.mockResolvedValue({ connected: true });
    apiMock.createFreelanceBrief.mockResolvedValue({ brief: {} });
    apiMock.decideFreelanceMessage.mockResolvedValue({ message: {} });
    apiMock.decideFreelanceLead.mockResolvedValue({ lead: {} });
    apiMock.freelanceMemory.mockResolvedValue({ memories: [] });
    apiMock.browserHandoff.mockResolvedValue({ handoff: null });
    apiMock.navigateBrowser.mockResolvedValue({});
    const connection = (status: string, ip: string | null) => ({ status, egressIpv4: ip });
    apiMock.cliGlobalEgress.mockResolvedValue({ profiles: { greece: connection("CONNECTED", "9.246.61.89"), thailand: connection("CONNECTED", "186.247.190.68"), mullvad: connection("DISCONNECTED", null), nord: connection("CONNECTED", "187.13.6.25") } });
  });
  afterEach(() => cleanup());

  it("is a copilot kind of its own with Leads first and the browser as a tab only when stacked", () => {
    expect(copilotKindForMode("FREELANCE_COPILOT")).toBe(FREELANCE_COPILOT_KIND);
    expect(tabsForLayout("split")).toEqual(["leads", "platforms", "activity", "memory", "bookmarks", "setup", "terminal"]);
    expect(tabsForLayout("stacked")).toEqual(["browser", "leads", "platforms", "activity", "memory", "bookmarks", "setup", "terminal"]);
    expect(resolveActiveTab("posts", "split")).toBe("leads");
  });

  it("hosts the browser and the terminal, shows the funnel, and hands a ready client to the operator", async () => {
    apiMock.freelanceLeads.mockResolvedValue({ leads: [lead] });
    const { container } = render(<FreelanceCopilotPane pane={pane} isVisible terminal={<div data-testid="terminal">xterm</div>} browser={<div data-testid="browser">chrome</div>} />);
    await waitFor(() => expect(apiMock.freelanceCopilotSettings).toHaveBeenCalledWith(pane.id));
    expect(screen.getByTestId("browser")).toBeTruthy();
    expect(screen.getByTestId("terminal")).toBeTruthy();
    expect(await screen.findByText("Idle · Full")).toBeTruthy();
    expect(screen.getByText("6/6 platforms")).toBeTruthy();
    const ready = await screen.findByRole("region", { name: "Clients ready for you" });
    expect(within(ready).getByText("Offer coming: $2,000 fixed, start Monday.")).toBeTruthy();
    fireEvent.change(within(ready).getByRole("spinbutton", { name: "Contract value in USD" }), { target: { value: "2000" } });
    fireEvent.click(within(ready).getByRole("button", { name: /Won/ }));
    await waitFor(() => expect(apiMock.decideFreelanceLead).toHaveBeenCalledWith(pane.id, lead.id, { decision: "won", contractValue: 2000 }));
    expect(container.querySelector(".fl-funnel")?.textContent).toContain("48 Connects in 30 days");
    fireEvent.change(screen.getByRole("textbox", { name: "Brief for the copilot" }), { target: { value: "Find MCP jobs on Upwork" } });
    fireEvent.click(screen.getByRole("button", { name: /Ask/ }));
    await waitFor(() => expect(apiMock.createFreelanceBrief).toHaveBeenCalledWith(pane.id, { text: "Find MCP jobs on Upwork" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(apiMock.freelanceCopilotRunAction).toHaveBeenCalledWith(pane.id, "start"));
  });

  it("shows each platform with its account, numbers and jobs in Platforms", async () => {
    const skipped = { ...lead, id: "fllead:skip01", title: "Cheap scraping fix", status: "SKIPPED", payload: {} } as FreelanceLead;
    apiMock.freelanceLeads.mockResolvedValue({ leads: [skipped, { ...lead, status: "PROPOSED", payload: {} }] });
    render(<FreelanceCopilotPane pane={pane} isVisible terminal={<div>xterm</div>} browser={<div>chrome</div>} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Platforms/ }));
    const upwork = await screen.findByRole("region", { name: "Upwork" });
    expect(within(upwork).getByText("Needs you")).toBeTruthy();
    expect(await within(upwork).findByText("Identity check")).toBeTruthy();
    expect(upwork.querySelector(".fl-funnel")?.textContent).toContain("2 jobs3 sent1 conversations");
    const titles = within(upwork).getAllByRole("link").map((link) => link.textContent);
    expect(titles).toEqual(["MCP server for Shopify", "Cheap scraping fix"]);
    expect(within(screen.getByRole("region", { name: "Fiverr" })).getByText("No jobs or proposals yet.")).toBeTruthy();
  });

  it("lists the operator's bookmarks and opens one in the pane browser", async () => {
    apiMock.marketingBookmarks.mockResolvedValue({ bookmarks: [{ id: "mktbm:abc123", ownerUserId: "user:operator", title: "Upwork profile", url: "https://www.upwork.com/freelancers/~01", profileId: null, accountLabel: null, createdAt: at }] });
    apiMock.openMarketingBookmark.mockResolvedValue({});
    apiMock.browserAccounts.mockRejectedValue(new Error("unavailable"));
    const actions: unknown[] = [];
    const onAction = (event: Event) => actions.push((event as CustomEvent).detail);
    window.addEventListener("space:browser-pane-action", onAction);
    const { registerBrowserPaneEventTarget } = await import("../src/features/browser-pane/events.js");
    const unregister = registerBrowserPaneEventTarget(pane.id);
    render(<FreelanceCopilotPane pane={pane} isVisible terminal={<div />} browser={<div />} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Bookmarks/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Upwork profile" }));
    await waitFor(() => expect(apiMock.openMarketingBookmark).toHaveBeenCalledWith(pane.id, "mktbm:abc123"));
    // The browser refreshes its tab strip to show the new tab.
    await waitFor(() => expect(actions).toEqual([expect.objectContaining({ paneId: pane.id, action: "tabs" })]));
    unregister();
    window.removeEventListener("space:browser-pane-action", onAction);
  });

  it("decides a message in review: approve, or approve the operator's edit", async () => {
    apiMock.freelanceCopilotRun.mockResolvedValue({ run: null, status: "IDLE", backlog: 0, pending: [{ kind: "REVIEW", id: message.id, message: "Review", payload: { message, lead: null, wordingIssues: ["messenger"] }, createdAt: at }] });
    render(<FreelanceCopilotPane pane={pane} isVisible terminal={<div />} browser={<div />} />);
    const review = await screen.findByRole("region", { name: "Needs your review" });
    expect(within(review).getByRole("note").textContent).toContain("messenger");
    fireEvent.click(within(review).getByRole("button", { name: /^Approve$/ }));
    await waitFor(() => expect(apiMock.decideFreelanceMessage).toHaveBeenCalledWith(pane.id, message.id, { decision: "approve" }));
    fireEvent.change(within(review).getByRole("textbox", { name: "Message text" }), { target: { value: "Happy to help: first milestone $300." } });
    fireEvent.click(within(review).getByRole("button", { name: "Approve my version" }));
    await waitFor(() => expect(apiMock.decideFreelanceMessage).toHaveBeenLastCalledWith(pane.id, message.id, { decision: "edit", body: "Happy to help: first milestone $300." }));
    expect((within(review).getByRole("button", { name: /Send back/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sets up platforms (account status, login page, caps) and connects the mailbox", async () => {
    render(<FreelanceCopilotPane pane={pane} isVisible terminal={<div />} browser={<div />} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Setup/ }));
    const list = await screen.findByRole("list", { name: "Platforms" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Upwork account status" }) as HTMLSelectElement).value).toBe("NEEDS_OPERATOR"));
    expect(within(list).getByText("Identity check")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Upwork account status" }), { target: { value: "ACTIVE" } });
    await waitFor(() => expect(apiMock.updateFreelanceAccount).toHaveBeenCalledWith(pane.id, { channel: "UPWORK", status: "ACTIVE" }));
    fireEvent.click(within(list).getByRole("button", { name: "Log in to Contra" }));
    await waitFor(() => expect(apiMock.navigateBrowser).toHaveBeenCalledWith(pane.id, "https://contra.com/log-in"));
    fireEvent.change(screen.getByRole("combobox", { name: "Fiverr highest autonomy" }), { target: { value: "ASSIST" } });
    await waitFor(() => expect(apiMock.updateFreelanceCopilotSettings).toHaveBeenCalledWith(pane.id, expect.objectContaining({
      settings: expect.objectContaining({ channels: expect.objectContaining({ FIVERR: expect.objectContaining({ autonomyCap: "ASSIST" }) }) })
    })));
    // Each platform leaves from a VPN route; changing one restarts the pane browser with the new routes.
    const upworkRoute = screen.getByRole("combobox", { name: "Upwork leaves from" }) as HTMLSelectElement;
    expect(upworkRoute.value).toBe("pane");
    await waitFor(() => expect(within(upworkRoute).getByRole("option", { name: "Thailand · connected 186.247.190.68" })).toBeTruthy());
    const restarts: unknown[] = [];
    const onAction = (event: Event) => restarts.push((event as CustomEvent).detail);
    window.addEventListener("space:browser-pane-action", onAction);
    const { registerBrowserPaneEventTarget } = await import("../src/features/browser-pane/events.js");
    const unregister = registerBrowserPaneEventTarget(pane.id);
    fireEvent.change(upworkRoute, { target: { value: "nord" } });
    await waitFor(() => expect(apiMock.updateFreelanceCopilotSettings).toHaveBeenCalledWith(pane.id, expect.objectContaining({
      settings: expect.objectContaining({ channels: expect.objectContaining({ UPWORK: expect.objectContaining({ egress: "nord" }) }) })
    })));
    await waitFor(() => expect(restarts).toEqual([expect.objectContaining({ paneId: pane.id, action: "restart" })]));
    unregister();
    window.removeEventListener("space:browser-pane-action", onAction);
    fireEvent.click(screen.getByRole("button", { name: /Mailbox/ }));
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(apiMock.connectFreelanceMailbox).toHaveBeenCalledWith({ host: "mail.spaceapp.dev", port: 993, secure: true, user: "work@example.invalid", password: "secret" }));
  });
});
