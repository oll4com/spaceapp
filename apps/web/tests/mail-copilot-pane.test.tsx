import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, ConnectorAccountSummary, MailCopilotPaneMetadata, Pane } from "@space/contracts";
import { defaultMailCopilotPaneMetadata } from "@space/contracts";
import { MailCopilotPane } from "../src/features/mail-copilot-pane/MailCopilotPane.js";
import { MailCopilotSettingsCard } from "../src/features/mail-copilot-pane/MailCopilotSettingsCard.js";
import { gmailAccessLabel, paneAccounts } from "../src/features/mail-copilot-pane/AccountsView.js";
import { CopilotLaunchDialog } from "../src/features/copilot-kit/CopilotLaunchDialog.js";
import { JOB_COPILOT_KIND, MAIL_COPILOT_KIND, copilotKindForMode } from "../src/features/copilot-kit/copilot-kind.js";
import { copilotLaunchDecision, copilotRuntimeOptions, defaultCopilotRuntimeId } from "../src/features/copilot-kit/copilot-runtimes.js";

const apiMock = vi.hoisted(() => ({
  mailCopilotSettings: vi.fn(),
  updateMailCopilotSettings: vi.fn(),
  updateMailCopilotView: vi.fn(),
  connectors: vi.fn(),
  connectorConsentLink: vi.fn(async () => ({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=s", expiresAt: "2026-10-14T12:10:00.000Z" })),
  userSettings: vi.fn(),
  updateUserSettings: vi.fn(),
  cliRuntimes: vi.fn(),
  cliRuntimesSnapshot: vi.fn(),
  listCliAccountProfiles: vi.fn(),
  updatePane: vi.fn(),
  createCliSession: vi.fn(),
  activeCliSession: vi.fn(),
  mailAccounts: vi.fn(),
  mailLabels: vi.fn(),
  mailThreads: vi.fn(),
  mailThread: vi.fn(),
  modifyMailThread: vi.fn(),
  sendMail: vi.fn(),
  saveMailDraft: vi.fn(),
  mailCopilotRun: vi.fn(),
  startMailCopilotRun: vi.fn(),
  pauseMailCopilotRun: vi.fn(),
  stopMailCopilotRun: vi.fn(),
  mailCopilotEvents: vi.fn(),
  syncMailCopilot: vi.fn(),
  mailRules: vi.fn(),
  decideMailRule: vi.fn(),
  answerMailQuestion: vi.fn(),
  decideMailReview: vi.fn(),
  mailMemory: vi.fn(),
  rememberMailMemory: vi.fn(),
  updateMailMemory: vi.fn(),
  forgetMailMemory: vi.fn(),
  mailHabits: vi.fn(async (): Promise<{ habits: unknown[] }> => ({ habits: [] })),
  mailActions: vi.fn(async (): Promise<{ actions: unknown[] }> => ({ actions: [] })),
  mailFixRequests: vi.fn(async (): Promise<{ requests: unknown[] }> => ({ requests: [] })),
  forgetMailHabits: vi.fn(async () => ({ forgotten: 3, retired: 1 })),
  mailAttachmentUrl: () => "/attachment"
}));
vi.mock("../src/api.js", () => ({ api: apiMock }));
const clipboardWrite = vi.hoisted(() => vi.fn(async (_text: string) => undefined));
vi.mock("../src/runtime/SpaceRuntime.js", () => ({ getSpaceRuntime: () => ({ kind: "live", platform: { localStorage: window.localStorage, clipboard: { writeText: clipboardWrite } } }) }));

function runtime(id: string, displayName: string, ready = true): AgentRuntime {
  return {
    id, providerId: id.slice(4), providerName: displayName, agentId: id.slice(4), agentName: displayName, displayName, capabilities: ["CLI"],
    adapterStatus: "ENABLED", authMode: "BROWSER_OAUTH", authState: ready ? "READY" : "LOGIN_REQUIRED", authReason: ready ? "ok" : "login", canStartLogin: !ready,
    status: "ENABLED", statusReason: ready ? "Ready" : "Login required", commandName: null, detectedCommandPath: null, defaultModelId: null,
    supportedReasoningEfforts: [], checkedAt: "2026-10-13T08:00:00.000Z"
  } as AgentRuntime;
}
const registry = { data: [runtime("cli:opencode", "OpenCode CLI"), runtime("cli:codex", "Codex CLI"), runtime("cli:claude", "Claude Code CLI")], checkedAt: "2026-10-13T08:00:00.000Z" };

const pane: Pane = {
  id: "pane:mail00001", roomId: "room:mail00001", title: "Mail Copilot 1", titleSource: "auto", mode: "MAIL_COPILOT", status: "IDLE",
  providerId: null, modelId: null, reasoningEffort: "medium", cwd: null, order: 0, columnSpan: 1, isMaximized: false, isMinimized: false,
  isClosed: false, split: { parentId: null, direction: null, size: null }, categoryColor: null, vncTarget: null, terminalRuntimeId: "cli:claude",
  createdAt: "2026-10-13T08:00:00.000Z", updatedAt: "2026-10-13T08:00:00.000Z"
} as Pane;

const accounts: ConnectorAccountSummary[] = [
  { accountId: "connector:" + "a".repeat(32), provider: "GOOGLE", email: "me@gmail.com", capabilities: ["MAIL_READ", "MAIL_COMPOSE", "MAIL_ORGANIZE", "CALENDAR"], connectedAt: "2026-10-13T08:00:00.000Z" },
  { accountId: "connector:" + "b".repeat(32), provider: "GOOGLE", email: "work@gmail.com", capabilities: ["MAIL_READ"], connectedAt: "2026-10-13T08:00:00.000Z" },
  { accountId: "connector:" + "c".repeat(32), provider: "MICROSOFT", email: "me@outlook.com", capabilities: ["MAIL_READ"], connectedAt: "2026-10-13T08:00:00.000Z" }
];

function metadata(overrides: Partial<MailCopilotPaneMetadata["settings"]> = {}): MailCopilotPaneMetadata {
  const base = defaultMailCopilotPaneMetadata();
  return { ...base, settings: { ...base.settings, ...overrides } };
}

const profiles = { runtimeId: "cli:claude", profiles: [{ profileId: "main", displayName: "Main" }, { profileId: "space-gateway", displayName: "Space Gateway (pooled)" }],
  gatewayProfile: { profileId: "space-gateway", ready: true }, defaultProfileId: "main" };

describe("MailCopilotPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    apiMock.mailCopilotSettings.mockResolvedValue({ metadata: metadata() });
    apiMock.updateMailCopilotSettings.mockImplementation(async (_paneId: string, next: MailCopilotPaneMetadata) => ({ metadata: next }));
    apiMock.connectors.mockResolvedValue({ providers: [], accounts });
    apiMock.userSettings.mockResolvedValue({ mailCopilot: null, jobCopilot: null });
    apiMock.updateUserSettings.mockResolvedValue({});
    apiMock.cliRuntimes.mockResolvedValue(registry);
    apiMock.cliRuntimesSnapshot.mockReturnValue(registry);
    apiMock.listCliAccountProfiles.mockResolvedValue(profiles);
    apiMock.updatePane.mockResolvedValue(pane);
    apiMock.createCliSession.mockResolvedValue({});
    // The pane's CLI runs on the Space Gateway pool account; the pane row never holds it.
    apiMock.activeCliSession.mockResolvedValue({ session: { runtimeId: "cli:claude", accountProfileId: "space-gateway" } });
    apiMock.mailAccounts.mockResolvedValue({ accounts: [{ email: "me@gmail.com", access: "full", inPane: true, unread: 1, error: null }, { email: "work@gmail.com", access: "read", inPane: true, unread: 0, error: null }] });
    apiMock.mailLabels.mockResolvedValue({ labels: [{ id: "INBOX", name: "Inbox", type: "system", unread: 1 }] });
    apiMock.mailThreads.mockResolvedValue({ threads: [{ account: "me@gmail.com", threadId: "t1", messageId: "m1", from: { name: "Anna", address: "anna@acme.com" }, subject: "Invoice", snippet: "Please find", receivedAt: new Date().toISOString(), unread: true, starred: false, hasAttachment: false, messageCount: 1, labelIds: ["INBOX", "UNREAD"] }], nextPageToken: null, errors: [] });
    apiMock.updateMailCopilotView.mockResolvedValue({ view: null });
    apiMock.mailCopilotRun.mockResolvedValue({ run: null, status: "IDLE", pending: [], backlog: 0 });
    apiMock.mailCopilotEvents.mockResolvedValue({ events: [] });
    apiMock.mailMemory.mockResolvedValue({ memories: [] });
  });
  afterEach(() => cleanup());

  it("classifies Gmail access per account and resolves the accounts a pane works with", () => {
    expect(accounts.map(gmailAccessLabel)).toEqual(["full", "read", "read"]);
    const google = accounts.filter((account) => account.provider === "GOOGLE");
    expect(paneAccounts(metadata(), google).map((account) => account.email)).toEqual(["me@gmail.com", "work@gmail.com"]);
    expect(paneAccounts(metadata({ accounts: ["work@gmail.com"] }), google).map((account) => account.email)).toEqual(["work@gmail.com"]);
    expect(copilotKindForMode("MAIL_COPILOT")).toBe(MAIL_COPILOT_KIND);
    expect(copilotKindForMode("JOB_APPLY")).toBe(JOB_COPILOT_KIND);
    expect(copilotKindForMode("CHAT")).toBeNull();
  });

  it("shows the agent chip, the autonomy level, the accounts in use and the mailbox, and hosts the terminal", async () => {
    render(<MailCopilotPane pane={pane} isVisible terminal={<div data-testid="terminal">xterm</div>} />);
    await waitFor(() => expect(apiMock.mailCopilotSettings).toHaveBeenCalledWith(pane.id));
    expect(await screen.findByRole("button", { name: "Unread: Anna: Invoice" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copilot agent: Claude Code CLI/ })).toBeTruthy();
    expect(screen.getByText("Idle · Assist")).toBeTruthy();
    expect(screen.getByText("2/2 accounts")).toBeTruthy();
    expect(apiMock.mailThreads).toHaveBeenCalledWith(pane.id, { account: "all", labelId: "INBOX", q: undefined });
    expect(screen.getByTestId("terminal")).toBeTruthy();
    // Paused toggle saves the pane settings.
    fireEvent.click(screen.getByRole("switch", { name: "Paused" }));
    await waitFor(() => expect(apiMock.updateMailCopilotSettings).toHaveBeenCalledWith(pane.id, expect.objectContaining({ settings: expect.objectContaining({ paused: true }) })));
  });

  it("shows the Google accounts with their access and consent links while none allows reading mail", async () => {
    apiMock.connectors.mockResolvedValue({ providers: [], accounts: accounts.map((account) => ({ ...account, capabilities: account.email === "me@gmail.com" ? ["CALENDAR"] : [] })) });
    render(<MailCopilotPane pane={pane} isVisible terminal={<div data-testid="terminal">xterm</div>} />);
    await screen.findAllByText("me@gmail.com");
    // Only Google accounts, with what Space may do with each; every one gets the gmail.modify consent link.
    expect(screen.queryAllByText("me@outlook.com")).toHaveLength(0);
    expect(apiMock.mailThreads).not.toHaveBeenCalled();
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("No Gmail access")).toBeTruthy();
    const consent = within(rows[1]!).getByRole("link", { name: "Allow full Gmail access" }) as HTMLAnchorElement;
    expect(consent.getAttribute("href")).toBe("/api/connectors/google/start?capabilities=MAIL_READ%2CMAIL_COMPOSE%2CCALENDAR%2CMAIL_ORGANIZE&source=mail-copilot&loginHint=work%40gmail.com");
    // The same consent as a one-use link for the browser profile where that account is signed in.
    fireEvent.click(within(rows[1]!).getByRole("button", { name: /Copy link/ }));
    await within(rows[1]!).findByText("Copied. Open it within 10 minutes in a browser signed in to work@gmail.com.");
    expect(apiMock.connectorConsentLink).toHaveBeenCalledWith(consent.getAttribute("href"));
    expect(clipboardWrite).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=s");
    expect(screen.getByTestId("terminal")).toBeTruthy();
  });

  it("switches the copilot agent: pane runtime patch, forced CLI restart on the account, terminal remount", async () => {
    render(<MailCopilotPane pane={pane} isVisible terminal={<div data-testid="terminal">xterm</div>} />);
    await screen.findByRole("button", { name: /Copilot agent: Claude Code CLI/ });
    fireEvent.click(screen.getByRole("button", { name: /Copilot agent: Claude Code CLI/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Codex CLI/ }));
    await waitFor(() => expect(apiMock.updatePane).toHaveBeenCalledWith(pane.id, { terminalRuntimeId: "cli:codex" }));
    expect(apiMock.createCliSession).toHaveBeenCalledWith(pane.id, expect.objectContaining({ runtimeId: "cli:codex", forceRestart: true }));
  });

  it("saves the pane's agent and the account its CLI runs on as the default for new Mail Copilot panes from the agent menu", async () => {
    render(<MailCopilotPane pane={pane} isVisible terminal={<div />} />);
    await screen.findByRole("button", { name: /Copilot agent: Claude Code CLI/ });
    fireEvent.click(screen.getByRole("button", { name: /Copilot agent: Claude Code CLI/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Set as default for new Mail Copilot panes/ }));
    await waitFor(() => expect(apiMock.updateUserSettings).toHaveBeenCalledWith({ mailCopilot: { runtimeId: "cli:claude", accountProfileId: "space-gateway", askOnLaunch: false } }));
    expect(await screen.findByText(/New Mail Copilot panes open with Claude Code \(space-gateway account\) from now on\./)).toBeTruthy();
  });

  it("changes autonomy, accounts and notifications from Setup, saved on the pane", async () => {
    render(<MailCopilotPane pane={pane} isVisible terminal={<div />} />);
    await screen.findByRole("tab", { name: "Setup" });
    fireEvent.click(screen.getByRole("tab", { name: "Setup" }));
    // Accounts step: turning one account off keeps the other as the pane's explicit choice.
    fireEvent.click(await screen.findByRole("switch", { name: "Show work@gmail.com in this pane" }));
    await waitFor(() => expect(apiMock.updateMailCopilotSettings).toHaveBeenLastCalledWith(pane.id, expect.objectContaining({ settings: expect.objectContaining({ accounts: ["me@gmail.com"] }) })));
    // The account no longer shown cannot notify; the bell of a shown one mutes just that account.
    expect((screen.getByRole("button", { name: "New mail notifications from work@gmail.com" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "New mail notifications from me@gmail.com" }));
    await waitFor(() => expect(apiMock.updateMailCopilotSettings).toHaveBeenLastCalledWith(pane.id, expect.objectContaining({ settings: expect.objectContaining({ notifications: expect.objectContaining({ newMail: true, mutedAccounts: ["me@gmail.com"] }) }) })));
    expect(screen.getByText(/On for 0 of 1 account\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Autonomy$/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Rules" }));
    await waitFor(() => expect(apiMock.updateMailCopilotSettings).toHaveBeenLastCalledWith(pane.id, expect.objectContaining({ settings: expect.objectContaining({ autonomy: "RULES" }) })));
    expect(screen.getByText(/Acts alone only under rules you approved/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Telegram" }));
    await waitFor(() => expect(apiMock.updateMailCopilotSettings).toHaveBeenLastCalledWith(pane.id, expect.objectContaining({ settings: expect.objectContaining({ notifications: expect.objectContaining({ telegram: true }) }) })));
    // The pane row never carries the CLI account (the Browser Host parses pane rows with its start-up contracts).
    expect(apiMock.updateMailCopilotSettings.mock.lastCall?.[1]).not.toHaveProperty("agent");
  });
});

describe("MailCopilotPane rail", () => {
  const run = { id: "mailrun:run00001", ownerUserId: "user:1", paneId: pane.id, status: "RUNNING", counters: { taken: 2, replied: 1, drafted: 0, archived: 1, labeled: 0, skipped: 0, needsUser: 1 }, currentEventId: null,
    kickoffSentAt: "2026-10-13T08:00:00.000Z", startedAt: "2026-10-13T08:00:00.000Z", pausedAt: null, stoppedAt: null, lastActivityAt: "2026-10-13T08:00:00.000Z" };
  const draft = { account: "me@gmail.com", to: ["anna@acme.com"], subject: "Re: Invoice", text: "Hi Anna, attached again.", threadId: "t1", inReplyToMessageId: "m1" };
  const review = { id: "mailrev:rev00001", kind: "REVIEW", eventId: "mailevt:e1", accountEmail: "me@gmail.com", threadId: "t1", message: "Review: reply resending the invoice", payload: { reviewId: "mailrev:rev00001", draft, reasoning: "Anna asked for it" }, createdAt: "2026-10-13T08:01:00.000Z" };
  const events = [
    { id: "mailevt:e2", ownerUserId: "user:1", paneId: pane.id, runId: run.id, accountEmail: "me@gmail.com", threadId: "t1", messageId: "m1", type: "REVIEW_REQUESTED", status: null, message: "Review: reply resending the invoice", payload: review.payload, createdAt: "2026-10-13T08:01:00.000Z" },
    { id: "mailevt:e1", ownerUserId: "user:1", paneId: pane.id, runId: run.id, accountEmail: "me@gmail.com", threadId: "t1", messageId: "m1", type: "TRIAGE", status: "TAKEN", message: "Triage: Invoice from Anna", payload: {}, createdAt: "2026-10-13T08:00:30.000Z" }
  ];
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    apiMock.mailCopilotSettings.mockResolvedValue({ metadata: metadata() });
    apiMock.connectors.mockResolvedValue({ providers: [], accounts });
    apiMock.cliRuntimes.mockResolvedValue(registry);
    apiMock.cliRuntimesSnapshot.mockReturnValue(registry);
    apiMock.listCliAccountProfiles.mockResolvedValue(profiles);
    apiMock.activeCliSession.mockResolvedValue({ session: { runtimeId: "cli:claude", accountProfileId: "space-gateway" } });
    apiMock.mailAccounts.mockResolvedValue({ accounts: [{ email: "me@gmail.com", access: "full", inPane: true, unread: 1, error: null }] });
    apiMock.mailLabels.mockResolvedValue({ labels: [{ id: "INBOX", name: "Inbox", type: "system", unread: 1 }] });
    apiMock.mailThreads.mockResolvedValue({ threads: [], nextPageToken: null, errors: [] });
    apiMock.updateMailCopilotView.mockResolvedValue({ view: null });
    apiMock.mailCopilotRun.mockResolvedValue({ run, status: "RUNNING", pending: [review], backlog: 1 });
    apiMock.mailCopilotEvents.mockResolvedValue({ events });
    apiMock.mailMemory.mockResolvedValue({ memories: [{ id: "mailmem:m1", ownerUserId: "user:1", kind: "STYLE", key: "sign-off", text: "Signs off with 'Best, Me'", contactEmail: null, domain: null, accountEmail: null, tags: [], source: "LEARNED", confidence: 0.8, uses: 3, pinned: false, lastUsedAt: null, createdAt: "2026-10-13T08:00:00.000Z", updatedAt: "2026-10-13T08:00:00.000Z" }] });
    apiMock.decideMailReview.mockResolvedValue({ decision: "edit", sent: { messageId: "sent-1", threadId: "t1" } });
    apiMock.pauseMailCopilotRun.mockResolvedValue({ run: { ...run, status: "PAUSED" }, status: "PAUSED", pending: [review], backlog: 1 });
    apiMock.forgetMailMemory.mockResolvedValue({ forgotten: true });
  });
  afterEach(() => cleanup());

  it("shows each mail sent to the AI with the request, the copilot's questions, the answers and the result", async () => {
    apiMock.mailFixRequests.mockResolvedValue({ requests: [
      { id: "mailevt:fix00001", account: "operator@example.invalid", threadId: "t1", subject: "vzdump backup failed", from: "root@pve.example", note: "Check and fix it", by: "operator", status: "DONE", requestedAt: "2026-10-14T15:26:48.000Z",
        exchanges: [{ question: "Disable the duplicate job?", askedAt: "2026-10-14T15:30:03.000Z", answer: "Yes, disable the job", answeredAt: "2026-10-14T15:33:10.000Z" }],
        outcome: { type: "FIXED", summary: "The job was disabled and the backup ran again.", at: "2026-10-14T15:33:40.000Z" }, memoryId: "mailmem:lesson01" },
      { id: "mailevt:fix00002", account: "operator@example.invalid", threadId: "t2", subject: "New packages", from: "root@pve.example", note: null, by: "rule", status: "PENDING", requestedAt: "2026-10-14T16:00:00.000Z", exchanges: [], outcome: null, memoryId: null }
    ] });
    render(<MailCopilotPane pane={pane} isVisible terminal={<div data-testid="terminal">xterm</div>} />);
    fireEvent.click(await screen.findByRole("radio", { name: "Sent to AI" }));
    const list = await screen.findByRole("list", { name: "Sent to AI" });
    expect(apiMock.mailFixRequests).toHaveBeenCalledWith(pane.id);
    const [fixed, queued] = within(list).getAllByRole("listitem");
    expect(within(fixed!).getByText("Fixed")).toBeTruthy();
    expect(within(fixed!).getByText("Check and fix it")).toBeTruthy();
    expect(within(fixed!).getByText(/Disable the duplicate job\?/)).toBeTruthy();
    expect(within(fixed!).getByText(/Yes, disable the job/)).toBeTruthy();
    expect(within(fixed!).getByText("The job was disabled and the backup ran again.")).toBeTruthy();
    expect(within(fixed!).getByText("Remembered for the next mail like this.")).toBeTruthy();
    expect(within(queued!).getByText("Queued")).toBeTruthy();
    expect(within(queued!).getByText(/sent by a rule/)).toBeTruthy();
  });

  it("shows where each mail sent to the AI stands in the copilot's queue", async () => {
    const fixEvent = (id: string, status: string, subject: string) => ({ id, ownerUserId: "user:1", paneId: pane.id, runId: null, accountEmail: "me@gmail.com", threadId: `t-${id}`, messageId: null, type: "FIX_REQUESTED", status,
      message: `You sent to the copilot to check and fix: ${subject}`, payload: { by: "operator" }, createdAt: "2026-10-14T15:26:48.000Z" });
    apiMock.mailCopilotEvents.mockResolvedValue({ events: [fixEvent("mailevt:fix00002", "PENDING", "New packages"), fixEvent("mailevt:fix00001", "TAKEN", "Backup failed")] });
    render(<MailCopilotPane pane={pane} isVisible terminal={<div data-testid="terminal">xterm</div>} />);
    const timeline = await screen.findByRole("list", { name: "Activity" });
    expect(within(timeline).getByText("Queued")).toBeTruthy();
    expect(within(timeline).getByText("In progress")).toBeTruthy();
  });

  it("lists the recorded actions under Activity → Your actions: who did what to which mail, on which account, where", async () => {
    const base = { ownerUserId: "user:1", messageId: null, subjectKey: null, ruleId: null, labelIds: [] as string[], labelNames: [] as string[], fromDomain: null };
    apiMock.mailActions.mockResolvedValue({ actions: [
      { ...base, id: "mailact:a00001", accountEmail: "info@example.invalid", threadId: "t1", action: "MOVE", labelIds: ["Label_3"], labelNames: ["Λογιστήριο INV"], fromAddress: "noreply@skroutz.gr", subject: "Invoice 42", actor: "OPERATOR", source: "GMAIL", occurredAt: "2026-10-14T18:00:00.000Z" },
      { ...base, id: "mailact:a00002", accountEmail: "operator@example.invalid", threadId: "t2", action: "FIX", fromAddress: "root@pve.example", subject: "vzdump backup failed", actor: "OPERATOR", source: "PANE", occurredAt: "2026-10-14T19:00:00.000Z" }
    ] });
    render(<MailCopilotPane pane={pane} isVisible terminal={<div data-testid="terminal">xterm</div>} />);
    fireEvent.click(await screen.findByRole("radio", { name: "Your actions" }));
    const list = await screen.findByRole("list", { name: "Recorded actions" });
    expect(apiMock.mailActions).toHaveBeenCalledWith(pane.id, { limit: 200 });
    expect(within(list).getByText("You moved “Invoice 42” to Λογιστήριο INV from noreply@skroutz.gr")).toBeTruthy();
    expect(within(list).getByText("info@example.invalid · in Gmail")).toBeTruthy();
    expect(within(list).getByText("You sent to the copilot to fix “vzdump backup failed” from root@pve.example")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Review a reply" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Activity" }));
    expect(await screen.findByRole("region", { name: "Review a reply" })).toBeTruthy();
  });

  it("shows the run, the review waiting for the operator, sends the operator's edit, and pauses the run", async () => {
    render(<MailCopilotPane pane={pane} isVisible terminal={<div data-testid="terminal">xterm</div>} />);
    await waitFor(() => expect(apiMock.mailCopilotRun).toHaveBeenCalledWith(pane.id));
    expect(await screen.findByText("Running · Assist")).toBeTruthy();
    expect(screen.getByText("1 needs you")).toBeTruthy();
    expect(screen.getByText("Triage: Invoice from Anna")).toBeTruthy();
    const card = within(screen.getByRole("region", { name: "Review a reply" }));
    expect(card.getByText("Anna asked for it")).toBeTruthy();
    // Show this mail: the list narrows to the reviewed conversation (a Message-ID search) and the conversation opens.
    apiMock.mailThread.mockResolvedValue({ thread: { account: "me@gmail.com", threadId: "t1", subject: "Invoice", messages: [{
      account: "me@gmail.com", threadId: "t1", messageId: "m1", from: { name: "Anna", address: "anna@acme.com" }, to: [], cc: [], replyTo: [], subject: "Invoice", receivedAt: "2026-10-13T08:00:00.000Z",
      rfcMessageId: "<inv-1@acme.com>", references: null, labelIds: ["INBOX"], unread: false, starred: false, text: "Please find the invoice", html: null, blockedImages: false, attachments: [] }] } });
    fireEvent.click(card.getByRole("button", { name: "Show this mail" }));
    await waitFor(() => expect(apiMock.mailThreads).toHaveBeenCalledWith(pane.id, expect.objectContaining({ account: "me@gmail.com", labelId: "ALL", q: "rfc822msgid:inv-1@acme.com" })));
    expect(apiMock.mailThread).toHaveBeenCalledWith(pane.id, "me@gmail.com", "t1", false);
    expect((screen.getByRole("searchbox", { name: "Search mail" }) as HTMLInputElement).value).toBe("rfc822msgid:inv-1@acme.com");
    expect(await screen.findByText("Please find the invoice")).toBeTruthy();
    fireEvent.change(card.getByRole("textbox", { name: "Reply text" }), { target: { value: "Hi Anna, here it is again." } });
    fireEvent.click(card.getByRole("button", { name: "Send my version" }));
    await waitFor(() => expect(apiMock.decideMailReview).toHaveBeenCalledWith(pane.id, { reviewId: "mailrev:rev00001", decision: "edit", text: "Hi Anna, here it is again." }));
    // Pause: the pane shows the paused view it gets back (and the refresh that follows agrees).
    apiMock.mailCopilotRun.mockResolvedValue({ run: { ...run, status: "PAUSED" }, status: "PAUSED", pending: [review], backlog: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(apiMock.pauseMailCopilotRun).toHaveBeenCalledWith(pane.id));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("lists proposed and approved rules in the Rules tab and approves a proposal", async () => {
    const rule = { id: "mailrule:rule0001", ownerUserId: "user:1", accountEmail: "me@gmail.com", name: "Archive Acme invoices", condition: { domain: "acme.com", subjectPattern: "invoice" }, action: { type: "ARCHIVE" }, status: "PROPOSED",
      confidence: 0.8, evidence: ["You archived Invoice 41"], proposedBy: "AGENT", decidedAt: null, appliedCount: 0, lastAppliedAt: null, createdAt: "2026-10-13T08:00:00.000Z", updatedAt: "2026-10-13T08:00:00.000Z" };
    apiMock.mailRules.mockResolvedValue({ rules: [{ ...rule, id: "mailrule:rule0002", name: "Star the boss", status: "APPROVED", condition: { fromContains: "boss@" }, action: { type: "STAR" }, appliedCount: 3, proposedBy: "USER" }, rule] });
    apiMock.decideMailRule.mockResolvedValue({ rule: { ...rule, status: "APPROVED", decidedAt: "2026-10-13T08:05:00.000Z" } });
    render(<MailCopilotPane pane={pane} isVisible terminal={<div data-testid="terminal">xterm</div>} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Rules" }));
    const list = within(await screen.findByRole("list", { name: "Rules" }));
    // Proposals come first.
    expect([...document.querySelectorAll(".jc-rule .jc-rule-name")].map((name) => name.textContent)).toEqual(["Archive Acme invoices", "Star the boss"]);
    expect(list.getByText(/from acme\.com, subject matches \/invoice\//)).toBeTruthy();
    expect(list.getByText("applied 3 times")).toBeTruthy();
    fireEvent.click(list.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(apiMock.decideMailRule).toHaveBeenCalledWith("mailrule:rule0001", { decision: "approve" }));
    await waitFor(() => expect(list.getAllByRole("button", { name: "Retire" })).toHaveLength(2));
    expect(list.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("lists the copilot's memory in the Memory tab and forgets an entry", async () => {
    render(<MailCopilotPane pane={pane} isVisible terminal={<div data-testid="terminal">xterm</div>} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Memory" }));
    expect(await screen.findByText("Signs off with 'Best, Me'")).toBeTruthy();
    expect(screen.getByText("used 3 times")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Forget memory" }));
    await waitFor(() => expect(apiMock.forgetMailMemory).toHaveBeenCalledWith("mailmem:m1"));
    expect(screen.queryByText("Signs off with 'Best, Me'")).toBeNull();
  });

  it("shows what the copilot learned from the operator's actions per account and forgets a sender", async () => {
    const level = { level: "sender", key: "deals@shop.example", decisions: 4, actions: [] };
    apiMock.mailHabits.mockResolvedValue({ habits: [
      { account: "info@example.invalid", sender: "deals@shop.example", summary: "archived 4 of 4 (100%)", level, lastAt: "2026-10-14T08:00:00.000Z" },
      { account: "me@gmail.com", sender: "billing@acme.com", summary: "moved to Invoices 3 of 3 (100%)", level: { ...level, key: "billing@acme.com" }, lastAt: "2026-10-14T09:00:00.000Z" }
    ] });
    render(<MailCopilotPane pane={pane} isVisible terminal={<div data-testid="terminal">xterm</div>} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Memory" }));
    const section = await screen.findByRole("region", { name: "Learned habits" });
    expect(apiMock.mailHabits).toHaveBeenCalledWith(pane.id);
    expect(within(section).getByText("info@example.invalid")).toBeTruthy();
    expect(within(section).getByText("archived 4 of 4 (100%)")).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "Forget the habit for billing@acme.com on me@gmail.com" }));
    await waitFor(() => expect(apiMock.forgetMailHabits).toHaveBeenCalledWith(pane.id, "me@gmail.com", "billing@acme.com"));
    await waitFor(() => expect(within(section).queryByText("billing@acme.com")).toBeNull());
  });
});

describe("copilot kit for Mail Copilot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.cliRuntimes.mockResolvedValue(registry);
    apiMock.cliRuntimesSnapshot.mockReturnValue(registry);
    apiMock.listCliAccountProfiles.mockResolvedValue(profiles);
    apiMock.userSettings.mockResolvedValue({ mailCopilot: null, jobCopilot: null });
    apiMock.updateUserSettings.mockResolvedValue({});
  });
  afterEach(() => cleanup());

  it("recommends Claude Code and decides a launch from the remembered Mail Copilot default", () => {
    const options = copilotRuntimeOptions(registry, MAIL_COPILOT_KIND);
    expect(options.map((option) => [option.runtime.id, option.recommended])).toEqual([["cli:opencode", false], ["cli:codex", false], ["cli:claude", true]]);
    expect(defaultCopilotRuntimeId(options)).toBe("cli:claude");
    expect(copilotLaunchDecision({ runtimeId: "cli:claude", accountProfileId: "space-gateway", askOnLaunch: false }, options))
      .toEqual({ open: true, label: "Claude Code", choice: { terminalRuntimeId: "cli:claude", accountProfileId: "space-gateway" } });
    expect(copilotLaunchDecision({ runtimeId: "cli:claude", accountProfileId: null, askOnLaunch: true }, options)).toMatchObject({ open: false, notice: null });
    expect(copilotLaunchDecision(null, options)).toEqual({ open: false, preselect: null, notice: null });
  });

  it("opens the Mail Copilot launch dialog on Claude Code and the gateway pool, remembers under settings.mailCopilot and creates the pane", async () => {
    const onCreate = vi.fn(async () => undefined);
    render(<CopilotLaunchDialog kind={MAIL_COPILOT_KIND} onClose={() => undefined} onCreate={onCreate} />);
    expect(screen.getByRole("dialog", { name: "New Mail Copilot" })).toBeTruthy();
    expect(screen.getByText("Choose the agent that handles your mail")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Claude Code CLI/ }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.queryByRole("combobox", { name: "Claude Code account" })).toBeNull();
    await waitFor(() => expect((screen.getByRole("button", { name: "Open with Claude Code" }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open with Claude Code" })); });
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ terminalRuntimeId: "cli:claude", accountProfileId: "space-gateway" }));
    expect(apiMock.updateUserSettings).toHaveBeenCalledWith({ mailCopilot: { runtimeId: "cli:claude", accountProfileId: "space-gateway", askOnLaunch: false } });
  });

  it("changes the Mail Copilot default agent from its settings card", async () => {
    render(<MailCopilotSettingsCard />);
    await waitFor(() => expect(apiMock.userSettings).toHaveBeenCalled());
    const select = await screen.findByRole("combobox", { name: "Default Mail Copilot agent" }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: "cli:codex" } });
    await waitFor(() => expect(apiMock.updateUserSettings).toHaveBeenCalledWith({ mailCopilot: { runtimeId: "cli:codex", accountProfileId: null, askOnLaunch: false } }));
    expect(screen.getByRole("region", { name: "Mail Copilot settings" })).toBeTruthy();
  });
});
