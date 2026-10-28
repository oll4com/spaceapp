import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, JobApplication, JobApplyPaneMetadata, JobApplyProfile, Pane } from "@space/contracts";
import { JobCopilotPane } from "../src/features/job-apply-pane/JobCopilotPane.js";
import { JobCopilotLaunchDialog } from "../src/features/job-apply-pane/JobCopilotLaunchDialog.js";
import { JobCopilotSettingsCard } from "../src/features/job-apply-pane/JobCopilotSettingsCard.js";
import { defaultJobCopilotRuntimeId, jobCopilotLaunchDecision, jobCopilotRuntimeOptions } from "../src/features/job-apply-pane/agent-runtimes.js";
import { applicationWhen, postingsFromText, QueueTab } from "../src/features/job-apply-pane/QueueTab.js";
import { profileCompleteness } from "../src/features/job-apply-pane/SetupWizard.js";
import { StartOver } from "../src/features/job-apply-pane/StartOver.js";
import { handoffPostingFor, todayCounts } from "../src/features/job-apply-pane/useJobApply.js";
import { SpaceToggle } from "../src/features/ui-controls/SpaceToggle.js";

const apiMock = vi.hoisted(() => ({
  jobApplyProfile: vi.fn(),
  updateJobApplyProfile: vi.fn(),
  importJobApplyCv: vi.fn(),
  setJobApplyMailbox: vi.fn(),
  testJobApplyMailbox: vi.fn(),
  clearJobApplyMailbox: vi.fn(),
  checkJobApplyMail: vi.fn(),
  browserAccounts: vi.fn(),
  userSettings: vi.fn(),
  updateUserSettings: vi.fn(),
  jobApplications: vi.fn(),
  jobApplyStats: vi.fn(),
  resetJobApply: vi.fn(),
  createJobApplication: vi.fn(),
  jobApplySettings: vi.fn(),
  updateJobApplySettings: vi.fn(),
  importJobApplyCsv: vi.fn(),
  browserHandoff: vi.fn(),
  browserSession: vi.fn(),
  startBrowserSession: vi.fn(),
  artifacts: vi.fn(),
  cliRuntimes: vi.fn(),
  cliRuntimesSnapshot: vi.fn(),
  listCliAccountProfiles: vi.fn(),
  updatePane: vi.fn(),
  createCliSession: vi.fn(),
  activeCliSession: vi.fn(),
  jobApplyRun: vi.fn(),
  startJobApplyRun: vi.fn(),
  pauseJobApplyRun: vi.fn(),
  stopJobApplyRun: vi.fn(),
  jobApplyEvents: vi.fn(),
  jobApplyFields: vi.fn(),
  editJobApplyField: vi.fn(),
  jobApplyMemory: vi.fn(),
  rememberJobApplyMemory: vi.fn(),
  updateJobApplyMemory: vi.fn(),
  forgetJobApplyMemory: vi.fn(),
  answerJobApplyQuestion: vi.fn(),
  decideJobApplyReview: vi.fn(),
  discoverJobApplyPostings: vi.fn(),
  addJobApplyQueue: vi.fn(),
  agentFilePreviewUrl: (id: string) => `/api/artifacts/${id}/preview`,
  agentFileDownloadUrl: (id: string) => `/api/artifacts/${id}/download`
}));
vi.mock("../src/api.js", () => ({ api: apiMock }));
const eventsMock = vi.hoisted(() => ({ dispatchBrowserPaneActionEvent: vi.fn(), BROWSER_PANE_ACCOUNT_SELECTED_EVENT: "space:browser-pane-account-selected",
  BROWSER_PANE_CONTROL_EVENT: "space:browser-pane-control", browserPaneControlHeld: vi.fn(() => false) }));
vi.mock("../src/features/browser-pane/events.js", () => eventsMock);
vi.mock("../src/runtime/SpaceRuntime.js", () => ({ getSpaceRuntime: () => ({ platform: { localStorage: window.localStorage } }) }));

function runtime(id: string, displayName: string, ready = true): AgentRuntime {
  return {
    id, providerId: id.slice(4), providerName: displayName, agentId: id.slice(4), agentName: displayName, displayName, capabilities: ["CLI"],
    adapterStatus: "ENABLED", authMode: "BROWSER_OAUTH", authState: ready ? "READY" : "LOGIN_REQUIRED", authReason: ready ? "ok" : "login", canStartLogin: !ready,
    status: "ENABLED", statusReason: ready ? "Ready" : "Login required", commandName: null, detectedCommandPath: null, defaultModelId: null,
    supportedReasoningEfforts: [], checkedAt: "2026-10-12T08:00:00.000Z"
  } as AgentRuntime;
}
const registry = { data: [runtime("cli:opencode", "OpenCode CLI"), runtime("cli:codex", "Codex CLI"), runtime("cli:claude", "Claude Code CLI")], checkedAt: "2026-10-12T08:00:00.000Z" };

const pane: Pane = {
  id: "pane:jobs0001", roomId: "room:jobs0001", title: "Job Copilot 1", titleSource: "auto", mode: "JOB_APPLY", status: "IDLE",
  providerId: null, modelId: null, reasoningEffort: "medium", cwd: null, order: 0, columnSpan: 1, isMaximized: false, isMinimized: false,
  isClosed: false, split: { parentId: null, direction: null, size: null }, categoryColor: null, vncTarget: null, terminalRuntimeId: "cli:claude",
  createdAt: "2026-10-12T08:00:00.000Z", updatedAt: "2026-10-12T08:00:00.000Z"
} as Pane;

const now = new Date().toISOString();
const profile: JobApplyProfile = {
  ownerUserId: "user:1", campaignStartedAt: null, candidate: { fullName: "Nikolaos Theodoropoulos", email: null, phone: null, address: null, location: null, country: null, linkedinUrl: null, githubUrl: null,
    websiteUrl: null, headline: null, summary: null, workAuthorization: null, needsSponsorship: true, willingToRelocate: null, salaryExpectation: null, salaryBelowMarketPercent: 10, noticePeriod: null,
    yearsOfExperience: null, skills: [], languages: [], experience: [], education: [], extra: {} },
  qaBank: [], cvArtifactId: "artifact:cv000001", coverLetterArtifactId: null, cvTextChars: 4200, mailbox: null, mailboxVerifiedAt: null, google: null, googleAccounts: [], googleAvailable: true, updatedAt: now
};
const googleAccounts = { selectedProfileId: null, effectiveProfileId: "google_account:me", profiles: [
  { profileId: "google_account:me", displayName: "Google account · Me", label: "Me", email: "me@gmail.com", browserStatus: "CONNECTED" as const },
  { profileId: "gemini:work", displayName: "Gemini account · work", label: "work", email: "work@example.com", browserStatus: "SIGNED_IN" as const }
] };
const settings: JobApplyPaneMetadata = { version: 1, settings: { submitMode: "AUTO", dailyCaps: { linkedin: 25, greenhouse: 60, ashby: 60, lever: 60, workday: 40, indeed: 40, other: 40 }, minDelayMs: 120000, maxDelayMs: 240000, paused: false, notifications: { inApp: true, telegram: false } } };
const applications: JobApplication[] = [
  { id: "jobapp:a00001", ownerUserId: "user:1", paneId: pane.id, company: "Acme", role: "Backend Engineer", ats: "greenhouse", url: "https://boards.greenhouse.io/acme/jobs/1",
    status: "VERIFIED", evidenceArtifactIds: ["artifact:shot0001"], externalConfirmation: "code AB12cd34", notes: null, appliedAt: now, queuePosition: null, createdAt: now, updatedAt: now },
  { id: "jobapp:a00002", ownerUserId: "user:1", paneId: pane.id, company: "Globex", role: "Platform Engineer", ats: "ashby", url: "https://jobs.ashbyhq.com/globex/2",
    status: "NEEDS_USER", evidenceArtifactIds: [], externalConfirmation: null, notes: "CAPTCHA on step 2", appliedAt: null, queuePosition: null, createdAt: now, updatedAt: now },
  { id: "jobapp:a00003", ownerUserId: "user:1", paneId: pane.id, company: "Initech", role: "Posting 77", ats: "lever", url: "https://jobs.lever.co/initech/77",
    status: "QUEUED", evidenceArtifactIds: [], externalConfirmation: null, notes: null, appliedAt: null, queuePosition: null, createdAt: now, updatedAt: now }
];

const idleRun = { run: null, status: "IDLE" as const, queue: [applications[2]!], current: null, pending: [] };
const events = [
  { id: "jobevt:e00003", ownerUserId: "user:1", paneId: pane.id, applicationId: "jobapp:a00001", runId: "jobrun:r00001", type: "VERIFIED" as const, message: "Verified Acme · Backend Engineer (code AB12cd34)", payload: {}, artifactId: "artifact:shot0001", createdAt: now },
  { id: "jobevt:e00002", ownerUserId: "user:1", paneId: pane.id, applicationId: "jobapp:a00001", runId: "jobrun:r00001", type: "FIELD_FILLED" as const, message: "Filled 4 fields on Application", payload: { count: 4 }, artifactId: null, createdAt: now },
  { id: "jobevt:e00001", ownerUserId: "user:1", paneId: pane.id, applicationId: null, runId: "jobrun:r00001", type: "RUN_STARTED" as const, message: "Run started: 2 queued", payload: {}, artifactId: null, createdAt: now }
];
const handoffRequest = { handoffRequestId: "handoff:1", sessionId: "browser_session:1", paneId: pane.id, roomId: pane.roomId, requestedByType: "AGENT", requestedById: "cli",
  reason: "CAPTCHA on the Globex Ashby form", status: "REQUESTED", operatorUserId: null, operatorEmail: null, operatorRole: null, controlLeaseId: null,
  requestedAt: now, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), acceptedAt: null, completedAt: null, expiredAt: null, cancelledAt: null, updatedAt: now };

function renderPane() {
  return render(<JobCopilotPane pane={pane} isVisible terminal={<div data-testid="terminal">terminal</div>} browser={<div data-testid="browser">browser</div>} />);
}

describe("JobCopilotPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    apiMock.jobApplyProfile.mockResolvedValue({ profile });
    apiMock.jobApplications.mockResolvedValue({ applications });
    apiMock.jobApplyStats.mockResolvedValue({ stats: {
      campaignStartedAt: null, firstDay: "2026-10-13",
      today: { applied: 24, verified: 24, failed: 0 },
      totals: { applied: 71, verified: 71, failed: 0, needsUser: 1 },
      days: [{ day: "2026-10-14", applied: 24, verified: 24, failed: 0 }, { day: "2026-10-13", applied: 47, verified: 47, failed: 0 }],
      earlier: { imported: { sent: 500, failed: 27 }, archived: { sent: 0, failed: 0 } }
    } });
    apiMock.jobApplySettings.mockResolvedValue({ metadata: settings });
    apiMock.userSettings.mockResolvedValue({});
    apiMock.updateUserSettings.mockResolvedValue({});
    apiMock.activeCliSession.mockResolvedValue(null);
    apiMock.browserHandoff.mockRejectedValue(new Error("no handoff"));
    apiMock.browserSession.mockResolvedValue({ session: { sessionId: "browser_session:1", status: "RUNNING" }, frame: null, websocket: null });
    apiMock.artifacts.mockResolvedValue({ data: [] });
    apiMock.cliRuntimes.mockResolvedValue(registry);
    apiMock.cliRuntimesSnapshot.mockReturnValue(registry);
    apiMock.listCliAccountProfiles.mockResolvedValue({ profiles: [] });
    apiMock.browserAccounts.mockResolvedValue(googleAccounts);
    apiMock.updateJobApplySettings.mockImplementation(async (_paneId: string, metadata: JobApplyPaneMetadata) => ({ metadata }));
    apiMock.setJobApplyMailbox.mockResolvedValue({ profile: { ...profile, mailbox: { host: "imap.gmail.com", port: 993, secure: true, user: "me@gmail.com" }, mailboxVerifiedAt: now } });
    apiMock.createJobApplication.mockImplementation(async (input: { url: string; company: string; role: string; ats: JobApplication["ats"] }) => ({
      created: true, application: { ...applications[2]!, id: `jobapp:${input.url.length}x${Math.random().toString(36).slice(2, 8)}`, ...input, status: "QUEUED" }
    }));
    apiMock.updatePane.mockResolvedValue({ ...pane, terminalRuntimeId: "cli:codex" });
    apiMock.createCliSession.mockResolvedValue({ session: { runtimeId: "cli:codex" } });
    apiMock.jobApplyRun.mockResolvedValue(idleRun);
    apiMock.jobApplyEvents.mockResolvedValue({ events });
    apiMock.jobApplyFields.mockResolvedValue({ fields: [] });
    apiMock.jobApplyMemory.mockResolvedValue({ memories: [], total: 0 });
    apiMock.startJobApplyRun.mockResolvedValue({ ...idleRun, status: "RUNNING", kickoffSent: true, run: { id: "jobrun:r00002", ownerUserId: "user:1", paneId: pane.id, status: "RUNNING", counters: { taken: 0, submitted: 0, verified: 0, failed: 0, needsUser: 0 }, currentApplicationId: null, kickoffSentAt: now, startedAt: now, pausedAt: null, stoppedAt: null, lastActivityAt: now, createdAt: now, updatedAt: now } });
    apiMock.pauseJobApplyRun.mockResolvedValue({ ...idleRun, status: "PAUSED" });
    apiMock.answerJobApplyQuestion.mockResolvedValue({ memory: { id: "jobmem:m00001" } });
  });
  afterEach(() => cleanup());

  it("counts today's applications by status and prefers Claude Code when ready", () => {
    expect(todayCounts(applications)).toEqual({ applied: 1, verified: 1, failed: 0, needsUser: 1, queued: 1, deferred: 0, nextFreeAt: null });
    // A posting waiting for an employer limit is not something Start can take.
    const deferred = { ...applications[2]!, notBefore: "2099-11-28T00:00:00.000Z" };
    expect(todayCounts([...applications.slice(0, 2), deferred])).toMatchObject({ queued: 0, deferred: 1, nextFreeAt: "2099-11-28T00:00:00.000Z" });
    // With the pane's own queue from the server, a posting queued by another open pane is not counted here.
    expect(todayCounts(applications, [])).toMatchObject({ queued: 0, deferred: 0 });
    const options = jobCopilotRuntimeOptions(registry);
    expect(options.map((option) => option.runtime.id)).toEqual(["cli:opencode", "cli:codex", "cli:claude"]);
    expect(defaultJobCopilotRuntimeId(options)).toBe("cli:claude");
    expect(defaultJobCopilotRuntimeId(jobCopilotRuntimeOptions({ ...registry, data: [runtime("cli:opencode", "OpenCode CLI"), runtime("cli:claude", "Claude Code CLI", false)] }))).toBe("cli:opencode");
    expect(postingsFromText("https://boards.greenhouse.io/acme/jobs/1\nnot a url\nhttps://boards.greenhouse.io/acme/jobs/1 https://jobs.lever.co/hooli/9").map((posting) => posting.url))
      .toEqual(["https://boards.greenhouse.io/acme/jobs/1", "https://jobs.lever.co/hooli/9"]);
    expect(profileCompleteness(profile)).toMatchObject({ filled: 3, total: 18 });
  });

  it("renders the compact toggle without state text", () => {
    render(<SpaceToggle compact label="Paused" checked={false} onChange={() => undefined} />);
    expect(screen.getByRole("switch", { name: "Paused" })).toBeTruthy();
    expect(screen.queryByText("Disabled")).toBeNull();
  });

  it("shows the agent chip, run pill, counters, hosts browser and terminal, and saves the pause toggle", async () => {
    renderPane();
    expect(screen.getByTestId("terminal")).toBeTruthy();
    expect(screen.getByTestId("browser")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: /Copilot agent: Claude Code CLI/ })).toBeTruthy());
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(screen.getByText("1 queued")).toBeTruthy();
    // Totals since the first day; today's numbers are in the counters' tooltip.
    await waitFor(() => expect(screen.getByTitle("Verified with evidence since Oct 13").textContent).toContain("71"));
    expect(screen.getByLabelText("Since Oct 13").getAttribute("title")).toBe("Today: 24 applied, 24 verified");
    expect(screen.getByTitle("Waiting for you").textContent).toContain("1");
    expect(apiMock.jobApplyStats).toHaveBeenCalledWith(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(document.body.textContent).not.toContain("Enabled");
    const paused = screen.getByRole("switch", { name: "Paused" });
    await act(async () => { fireEvent.click(paused); });
    await waitFor(() => expect(apiMock.updateJobApplySettings).toHaveBeenCalledWith(pane.id, expect.objectContaining({ settings: expect.objectContaining({ paused: true }) })));
    // The terminal stays mounted behind the queue tab and is revealed by its tab.
    const terminalPanel = screen.getByTestId("terminal").parentElement!;
    expect(terminalPanel.getAttribute("data-active")).toBe("false");
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(terminalPanel.getAttribute("data-active")).toBe("true");
  });

  it("queues pasted posting URLs from the Queue tab and filters the list", async () => {
    renderPane();
    await waitFor(() => expect(screen.getByRole("tab", { name: /Queue/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /Queue/ }));
    await waitFor(() => expect(screen.getByText("Globex")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Posting URLs"), { target: { value: "https://boards.greenhouse.io/hooli/jobs/4567890\nhttps://jobs.ashbyhq.com/initech/abcd-1234" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Queue 2 postings" })); });
    await waitFor(() => expect(apiMock.createJobApplication).toHaveBeenCalledTimes(2));
    expect(apiMock.createJobApplication).toHaveBeenCalledWith(expect.objectContaining({ ats: "greenhouse", company: "Hooli", role: "Posting 4567890", paneId: pane.id, status: "QUEUED" }));
    await waitFor(() => expect(screen.getByText("2 queued.")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /^Verified/ }));
    expect(screen.queryByText("Globex")).toBeNull();
    expect(screen.getByText("Acme")).toBeTruthy();
  });

  it("switches the copilot agent: pane runtime patch, forced CLI restart, terminal remount", async () => {
    renderPane();
    await waitFor(() => expect(screen.getByRole("button", { name: /Copilot agent: Claude Code CLI/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Copilot agent: Claude Code CLI/ }));
    const menu = screen.getByRole("menu", { name: "Switch copilot agent" });
    await act(async () => { fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Codex CLI/ })); });
    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledWith(pane.id, expect.objectContaining({ runtimeId: "cli:codex", forceRestart: true })));
    expect(apiMock.updatePane).toHaveBeenCalledWith(pane.id, { terminalRuntimeId: "cli:codex" });
    await waitFor(() => expect(screen.getByTestId("terminal").parentElement!.getAttribute("data-active")).toBe("true"));
  });

  it("starts a new session on the same agent and account from the agent menu, without touching the pane's runtime", async () => {
    apiMock.activeCliSession.mockResolvedValue({ session: { runtimeId: "cli:claude", accountProfileId: "work" } });
    renderPane();
    await waitFor(() => expect(screen.getByRole("button", { name: /Copilot agent: Claude Code CLI/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Copilot agent: Claude Code CLI/ }));
    const menu = screen.getByRole("menu", { name: "Switch copilot agent" });
    await act(async () => { fireEvent.click(within(menu).getByRole("menuitem", { name: /Start a new session/ })); });
    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledWith(pane.id, { runtimeId: "cli:claude", forceRestart: true, includeTranscript: false, accountProfileId: "work" }));
    expect(apiMock.updatePane).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("Started a new session. The previous conversation stays in the task history.")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("terminal").parentElement!.getAttribute("data-active")).toBe("true"));
  });

  it("saves the pane's agent and the account its CLI runs on as the default for new Job Copilot panes from the agent menu", async () => {
    apiMock.activeCliSession.mockResolvedValue({ session: { runtimeId: "cli:claude", accountProfileId: "work" } });
    renderPane();
    await waitFor(() => expect(apiMock.jobApplySettings).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: /Copilot agent: Claude Code CLI/ }));
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /Set as default for new Job Copilot panes/ })); });
    expect(apiMock.updateUserSettings).toHaveBeenCalledWith({ jobCopilot: { runtimeId: "cli:claude", accountProfileId: "work", askOnLaunch: false } });
    expect(screen.getByText("New Job Copilot panes open with Claude Code (work account) from now on.")).toBeTruthy();
  });

  it("switches this pane's account from Setup → Agent: the CLI restarts on it", async () => {
    // The pane's CLI runs on the CLI's own sign-in ("main").
    apiMock.activeCliSession.mockResolvedValue({ session: { runtimeId: "cli:claude", accountProfileId: null } });
    apiMock.listCliAccountProfiles.mockResolvedValue({ profiles: [
      { runtimeId: "cli:claude", profileId: "main", displayName: "Main", createdAt: now, updatedAt: now, updatedBy: null },
      { runtimeId: "cli:claude", profileId: "work", displayName: "Work", createdAt: now, updatedAt: now, updatedBy: null }
    ], gatewayProfile: null });
    renderPane();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Setup" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Setup" }));
    fireEvent.click(await screen.findByRole("button", { name: /Agent/ }));
    const account = await screen.findByRole("combobox", { name: "Claude Code account" }) as HTMLSelectElement;
    await waitFor(() => expect(account.value).toBe("main"));
    expect(screen.getByText(/New Job Copilot panes ask which agent to use. Change it in Settings → Job Copilot./)).toBeTruthy();
    await act(async () => { fireEvent.change(account, { target: { value: "work" } }); });
    await waitFor(() => expect(apiMock.createCliSession).toHaveBeenCalledWith(pane.id, { runtimeId: "cli:claude", forceRestart: true, includeTranscript: false, accountProfileId: "work" }));
    expect(apiMock.updatePane).not.toHaveBeenCalled();
  });

  it("shows a strip above the browser when the agent asks for a handoff and hands control back", async () => {
    apiMock.browserHandoff.mockResolvedValue({ handoff: handoffRequest });
    renderPane();
    await waitFor(() => expect(screen.getByRole("status", { name: "The copilot needs you" }).textContent).toContain("CAPTCHA on the Globex Ashby form"));
    expect(screen.getByRole("status", { name: "The copilot needs you" }).textContent).toContain("Globex · Platform Engineer");
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect(eventsMock.dispatchBrowserPaneActionEvent).toHaveBeenCalledWith({ paneId: pane.id, action: "handoff", roomId: pane.roomId });
    apiMock.browserHandoff.mockResolvedValue({ handoff: { ...handoffRequest, status: "ACCEPTED", acceptedAt: now } });
    cleanup();
    renderPane();
    await waitFor(() => expect(screen.getByRole("button", { name: "Return to agent" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Return to agent" }));
    expect(eventsMock.dispatchBrowserPaneActionEvent).toHaveBeenCalledWith({ paneId: pane.id, action: "release", roomId: pane.roomId });
  });

  it("offers Return to agent while the operator still holds the browser after the handoff ended", async () => {
    renderPane();
    expect(screen.queryByRole("button", { name: "Return to agent" })).toBeNull();
    act(() => { window.dispatchEvent(new CustomEvent("space:browser-pane-control", { detail: { paneId: pane.id, held: true } })); });
    const giveBack = await screen.findByRole("button", { name: "Return to agent" });
    expect(giveBack.closest(".jc-handoff-strip")?.textContent).toContain("You hold the browser.");
    fireEvent.click(screen.getByRole("button", { name: "Return to agent" }));
    expect(eventsMock.dispatchBrowserPaneActionEvent).toHaveBeenCalledWith({ paneId: pane.id, action: "release", roomId: pane.roomId });
    act(() => { window.dispatchEvent(new CustomEvent("space:browser-pane-control", { detail: { paneId: pane.id, held: false } })); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Return to agent" })).toBeNull());
  });

  it("keeps a postal address in Setup → Profile and saves it with the profile", async () => {
    apiMock.updateJobApplyProfile.mockImplementation(async (input: { candidate: JobApplyProfile["candidate"] }) => ({ profile: { ...profile, candidate: input.candidate } }));
    renderPane();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Setup" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Setup" }));
    fireEvent.click(await screen.findByRole("button", { name: /CV & profile/ }));
    const street = await screen.findByRole("textbox", { name: "Street address" });
    fireEvent.change(street, { target: { value: "99 Sukhumvit Road" } });
    fireEvent.change(screen.getByRole("textbox", { name: "City" }), { target: { value: "Bangkok" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Postal code" }), { target: { value: "10110" } });
    expect(screen.getByRole("textbox", { name: "State / province" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Address line 2" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save profile" })); });
    await waitFor(() => expect(apiMock.updateJobApplyProfile).toHaveBeenCalled());
    const saved = apiMock.updateJobApplyProfile.mock.calls.at(-1)![0] as { candidate: JobApplyProfile["candidate"] };
    expect(saved.candidate.address).toEqual({ line1: "99 Sukhumvit Road", line2: null, city: "Bangkok", region: null, postalCode: "10110", country: null });
    // Clearing every field stores no address at all.
    for (const name of ["Street address", "City", "Postal code"]) fireEvent.change(screen.getByRole("textbox", { name }), { target: { value: "" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save profile" })); });
    const cleared = apiMock.updateJobApplyProfile.mock.calls.at(-1)![0] as { candidate: JobApplyProfile["candidate"] };
    expect(cleared.candidate.address).toBeNull();
  });

  it("names the posting the handoff is about, not another posting a parallel agent is filling", () => {
    const base = applications[0]!;
    const grafana = { ...base, id: "jobapp:g1", company: "Grafanalabs", role: "Staff Backend Software Engineer - Loki", status: "FILLING" as const };
    const lalamoveOps = { ...base, id: "jobapp:l1", company: "Lalamove", role: "Lead, Platform Growth and Operations", status: "NEEDS_USER" as const };
    const lalamoveBackend = { ...base, id: "jobapp:l2", company: "Lalamove", role: "Software Engineer, Backend", status: "QUEUED" as const };
    const reason = "CAPTCHA: Lalamove (Lever), Software Engineer, Backend: the form is filled but NOT submitted yet.";
    expect(handoffPostingFor(reason, [grafana, lalamoveOps, lalamoveBackend], grafana)?.id).toBe("jobapp:l2");
    expect(handoffPostingFor("CAPTCHA: Lalamove (Lever): press Submit", [grafana, lalamoveBackend, lalamoveOps], null)?.id).toBe("jobapp:l1");
    expect(handoffPostingFor("LOGIN: the job board asks to sign in", [grafana], grafana)).toBeNull();
  });

  it("hides an expired handoff request instead of covering the browser", async () => {
    apiMock.browserHandoff.mockResolvedValue({ handoff: { ...handoffRequest, expiresAt: new Date(Date.now() - 60_000).toISOString() } });
    renderPane();
    await waitFor(() => expect(apiMock.browserHandoff).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("status", { name: "The copilot needs you" })).toBeNull();
  });

  it("drops a request the moment it expires, even while the server still reports it as REQUESTED", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiMock.browserHandoff.mockResolvedValue({ handoff: { ...handoffRequest, expiresAt: new Date(Date.now() + 3_000).toISOString() } });
      const { container } = renderPane();
      await waitFor(() => expect(screen.getByRole("status", { name: "The copilot needs you" })).toBeTruthy());
      expect(container.querySelector("[data-handoff]")?.getAttribute("data-handoff")).toBe("requested");
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
      expect(screen.queryByRole("status", { name: "The copilot needs you" })).toBeNull();
      expect(container.querySelector("[data-handoff]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps refreshing after a request hangs, so a finished handoff card goes away", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiMock.browserHandoff.mockResolvedValue({ handoff: handoffRequest });
      renderPane();
      await waitFor(() => expect(screen.getByRole("status", { name: "The copilot needs you" })).toBeTruthy());
      // One request never answers; later the handoff is gone.
      apiMock.jobApplyRun.mockReturnValueOnce(new Promise(() => undefined));
      apiMock.browserHandoff.mockRejectedValue(new Error("not found"));
      await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      await waitFor(() => expect(screen.queryByRole("status", { name: "The copilot needs you" })).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("connects the mailbox in the Setup wizard and never echoes the password", async () => {
    renderPane();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Setup" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Setup" }));
    await waitFor(() => expect(screen.getByRole("meter", { name: "Profile completeness" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Google account/ }));
    fireEvent.click(screen.getByText("Use an IMAP mailbox instead"));
    const password = screen.getByLabelText("App password") as HTMLInputElement;
    expect(password.type).toBe("password");
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "me@gmail.com" } });
    fireEvent.change(password, { target: { value: "app-password" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Connect" })); });
    await waitFor(() => expect(apiMock.setJobApplyMailbox).toHaveBeenCalledWith({ host: "imap.gmail.com", port: 993, secure: true, user: "me@gmail.com", password: "app-password" }));
    await waitFor(() => expect(screen.getByText("Mailbox connected and verified.")).toBeTruthy());
    expect(password.value).toBe("");
    expect(document.body.textContent).not.toContain("app-password");
  });

  it("chooses the copilot's Google account like the Browser pane menu and asks Google for Gmail and Calendar", async () => {
    renderPane();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Setup" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Setup" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Google account/ })).toBeTruthy());
    // The profile has a CV and a name but no mail access: Setup opens on the Google account step.
    const list = await screen.findByRole("menu", { name: "Google accounts for Job Copilot" });
    expect(apiMock.browserAccounts).toHaveBeenCalledWith(pane.id);
    // Before anything is allowed, each account of the menu offers its own Allow.
    expect(await screen.findByLabelText("Google access for me@gmail.com")).toBeTruthy();
    expect(screen.getByLabelText("Google access for work@example.com")).toBeTruthy();
    fireEvent.click(within(list).getByRole("menuitemradio", { name: /^work/ }));
    expect(eventsMock.dispatchBrowserPaneActionEvent).toHaveBeenCalledWith({ paneId: pane.id, roomId: pane.roomId, action: "account", profileId: "gemini:work", signIn: false });
    expect(screen.getByText("Opening the Google account in the pane browser…")).toBeTruthy();

    // The pane browser switched; the API made it the copilot's account, still without Gmail access.
    const calendarOnly = { email: "work@example.com", capabilities: ["CALENDAR" as const] };
    apiMock.jobApplyProfile.mockResolvedValue({ profile: { ...profile, google: { ...calendarOnly, available: true }, googleAccounts: [calendarOnly] } });
    await act(async () => { window.dispatchEvent(new CustomEvent("space:browser-pane-account-selected", { detail: { paneId: pane.id, profileId: "gemini:work" } })); });
    const access = await screen.findByLabelText("Google access for work@example.com");
    expect(within(access).getByText("Pane browser")).toBeTruthy();
    expect(within(access).getByText("Read email: codes, links, recruiter replies · not allowed yet")).toBeTruthy();
    expect(within(access).getByText("Calendar: busy times and interviews")).toBeTruthy();
    expect(within(access).getByText("Organize mail: file application emails under Job Applications labels and archive receipts · not allowed yet")).toBeTruthy();
    const allow = within(access).getByRole("link", { name: "Allow Gmail & Calendar" });
    expect(allow.getAttribute("href")).toBe("/api/connectors/google/start?capabilities=MAIL_READ%2CMAIL_COMPOSE%2CCALENDAR%2CMAIL_ORGANIZE&loginHint=work%40example.com&source=job-copilot");
    // Every other Google account can be allowed too, at the same time.
    const other = screen.getByLabelText("Google access for me@gmail.com");
    expect(within(other).getByRole("link", { name: "Allow Gmail & Calendar" }).getAttribute("href")).toContain("loginHint=me%40gmail.com");
    expect((screen.getByRole("button", { name: "Test mail" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Opening the Google account in the pane browser…")).toBeNull();

    // An earlier grant (read, drafts, calendar) asks once more for organizing mail.
    const earlier = ["MAIL_READ", "MAIL_COMPOSE", "CALENDAR"] as const;
    apiMock.jobApplyProfile.mockResolvedValue({ profile: { ...profile, google: { email: "work@example.com", capabilities: [...earlier], available: true },
      googleAccounts: [{ email: "work@example.com", capabilities: [...earlier] }] } });
    await act(async () => { window.dispatchEvent(new CustomEvent("space:browser-pane-account-selected", { detail: { paneId: pane.id, profileId: "gemini:work" } })); });
    await waitFor(() => expect(within(screen.getByLabelText("Google access for work@example.com")).getByText(/^Organize mail: .* · not allowed yet$/)).toBeTruthy());
    expect(within(screen.getByLabelText("Google access for work@example.com")).getByRole("link", { name: "Allow Gmail & Calendar" })).toBeTruthy();

    // Both accounts allowed: no consent links, the step counts as done and the mail test runs through Gmail.
    const all = ["MAIL_READ", "MAIL_COMPOSE", "CALENDAR", "MAIL_ORGANIZE"] as const;
    apiMock.jobApplyProfile.mockResolvedValue({ profile: { ...profile, google: { email: "work@example.com", capabilities: [...all], available: true },
      googleAccounts: [{ email: "work@example.com", capabilities: [...all] }, { email: "me@gmail.com", capabilities: [...all] }] } });
    await act(async () => { window.dispatchEvent(new CustomEvent("space:browser-pane-account-selected", { detail: { paneId: pane.id, profileId: "gemini:work" } })); });
    await waitFor(() => expect(screen.queryByRole("link", { name: "Allow Gmail & Calendar" })).toBeNull());
    expect(screen.getByRole("button", { name: /Google account/ }).className).toContain("done");
    apiMock.testJobApplyMailbox.mockResolvedValue({ ok: true, verifiedAt: now, recent: [{ from: "no-reply@greenhouse-mail.io", subject: "Your security code", receivedAt: now, snippet: "" }] });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Test mail" })); });
    await waitFor(() => expect(screen.getByText("Mailbox reachable. Latest: Your security code")).toBeTruthy());
  });

  it("shows mail triage in the activity: an email that asks for something stands out, filed mail stays quiet", async () => {
    apiMock.jobApplyEvents.mockResolvedValue({ events: [
      { id: "jobevt:m00002", ownerUserId: "user:1", paneId: pane.id, applicationId: null, runId: null, type: "MAIL" as const, message: "Action needed: Interview with Acme from Acme",
        payload: { category: "ACTION_NEEDED", messageId: "m2" }, artifactId: null, createdAt: now },
      { id: "jobevt:m00001", ownerUserId: "user:1", paneId: pane.id, applicationId: null, runId: null, type: "MAIL" as const, message: "Archived 2 confirmations from me@gmail.com under Job Applications",
        payload: { category: "ARCHIVED" }, artifactId: null, createdAt: now }
    ] });
    renderPane();
    const needed = await screen.findByText("Action needed: Interview with Acme from Acme");
    expect(needed.closest("li")?.className).toContain("tone-warn");
    expect(screen.getByText("Archived 2 confirmations from me@gmail.com under Job Applications").closest("li")?.className).toContain("tone-muted");
  });

  it("renders the activity timeline with screenshot thumbnails and starts, pauses the run from the command bar", async () => {
    renderPane();
    await waitFor(() => expect(screen.getByText("Run started: 2 queued")).toBeTruthy());
    expect(screen.getByText("Filled 4 fields on Application")).toBeTruthy();
    const shot = screen.getByAltText(/Screenshot: Verified Acme/) as HTMLImageElement;
    expect(shot.getAttribute("src")).toBe("/api/artifacts/artifact:shot0001/preview");
    expect(screen.getByText("Idle")).toBeTruthy();
    const start = screen.getByRole("button", { name: /^Start$/ });
    expect((start as HTMLButtonElement).disabled).toBe(false);
    const running = { ...idleRun, status: "RUNNING" as const, run: { id: "jobrun:r00002", ownerUserId: "user:1", paneId: pane.id, status: "RUNNING" as const, counters: { taken: 1, submitted: 0, verified: 0, failed: 0, needsUser: 0 }, currentApplicationId: "jobapp:a00003", kickoffSentAt: now, startedAt: now, pausedAt: null, stoppedAt: null, lastActivityAt: now, createdAt: now, updatedAt: now }, queue: [], current: applications[2]! };
    apiMock.startJobApplyRun.mockResolvedValue({ ...running, kickoffSent: true });
    apiMock.jobApplyRun.mockResolvedValue(running);
    await act(async () => { fireEvent.click(start); });
    await waitFor(() => expect(apiMock.startJobApplyRun).toHaveBeenCalledWith(pane.id));
    await waitFor(() => expect(screen.getByText("Running 0/1")).toBeTruthy());
    const paused = { ...running, status: "PAUSED" as const, run: { ...running.run, status: "PAUSED" as const } };
    apiMock.pauseJobApplyRun.mockResolvedValue(paused);
    apiMock.jobApplyRun.mockResolvedValue(paused);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Pause/ })); });
    await waitFor(() => expect(apiMock.pauseJobApplyRun).toHaveBeenCalledWith(pane.id));
    await waitFor(() => expect(screen.getByText("Paused 0/1")).toBeTruthy());
    expect(screen.getByRole("button", { name: /Resume/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stop/ })).toBeTruthy();
  });

  it("shows a pending question as a card and sends the operator's answer", async () => {
    apiMock.jobApplyRun.mockResolvedValue({ ...idleRun, status: "RUNNING", current: applications[1], pending: [
      { kind: "QUESTION", id: "jobq:q00001", applicationId: "jobapp:a00002", message: "Needs you: What is your expected salary?", payload: { questionId: "jobq:q00001", question: "What is your expected salary?", options: ["70k", "80k"] }, createdAt: now }
    ] });
    renderPane();
    await waitFor(() => expect(screen.getByText("What is your expected salary?")).toBeTruthy());
    expect(screen.getByTitle("Questions or reviews waiting for you").textContent).toContain("1 needs you");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "80k" })); });
    await waitFor(() => expect(apiMock.answerJobApplyQuestion).toHaveBeenCalledWith("jobapp:a00002", { questionId: "jobq:q00001", answer: "80k" }));
  });

  it("lists recorded fields of the selected application and saves an edit as the operator's answer", async () => {
    apiMock.jobApplyFields.mockResolvedValue({ fields: [
      { id: "jobfield:f00001", applicationId: "jobapp:a00001", ownerUserId: "user:1", stepIndex: 0, stepTitle: "Application", label: "Years of TypeScript", fieldType: "text", refHint: null, value: "6", source: "CV", filledAt: now, verifiedAt: null, createdAt: now, updatedAt: now },
      { id: "jobfield:f00002", applicationId: "jobapp:a00001", ownerUserId: "user:1", stepIndex: 0, stepTitle: "Application", label: "Resume", fieldType: "file", refHint: null, value: "cv.pdf", source: "PROFILE", filledAt: now, verifiedAt: now, createdAt: now, updatedAt: now }
    ] });
    apiMock.editJobApplyField.mockImplementation(async (id: string, value: string | null) => ({ field: { id, applicationId: "jobapp:a00001", ownerUserId: "user:1", stepIndex: 0, stepTitle: "Application", label: "Years of TypeScript", fieldType: "text", refHint: null, value, source: "USER", filledAt: now, verifiedAt: null, createdAt: now, updatedAt: now } }));
    renderPane();
    await waitFor(() => expect(screen.getByRole("tab", { name: /Queue/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /Queue/ }));
    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Acme/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Fields" }));
    await waitFor(() => expect(screen.getByText("Years of TypeScript")).toBeTruthy());
    expect(screen.getByText("cv.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit Years of TypeScript" }));
    fireEvent.change(screen.getByLabelText("Value of Years of TypeScript"), { target: { value: "7" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    await waitFor(() => expect(apiMock.editJobApplyField).toHaveBeenCalledWith("jobfield:f00001", "7"));
    await waitFor(() => expect(screen.getByText("from you")).toBeTruthy());
  });

  it("shows the fields of the application waiting for the operator when no row is picked", async () => {
    apiMock.jobApplyRun.mockResolvedValue({ ...idleRun, status: "STOPPED", current: null, pending: [
      { kind: "QUESTION", id: "jobq:q00001", applicationId: "jobapp:a00002", message: "Needs you: Visa sponsorship?", payload: { questionId: "jobq:q00001", question: "Visa sponsorship?", options: ["No", "Yes"] }, createdAt: now }
    ] });
    renderPane();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Fields" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Fields" }));
    await waitFor(() => expect(apiMock.jobApplyFields).toHaveBeenCalledWith("jobapp:a00002"));
    expect(screen.queryByText("Pick an application")).toBeNull();
    expect(screen.getByText("Globex")).toBeTruthy();
  });

  it("keeps imported tracker history out of the Queue counts until the operator asks for it", async () => {
    const imported = Array.from({ length: 3 }, (_, index) => ({ ...applications[0]!, id: `jobapp:i0000${index}`, company: `Oldco ${index}`, status: "SUBMITTED" as const,
      url: `https://space.local/imported/oldco_${index}`, evidenceArtifactIds: [], externalConfirmation: null, appliedAt: "2026-08-25T00:00:00.000Z" }));
    apiMock.jobApplications.mockResolvedValue({ applications: [...applications, ...imported] });
    renderPane();
    await waitFor(() => expect(screen.getByRole("tab", { name: /Queue/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /Queue/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Space 3" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Space 3" }).getAttribute("aria-pressed")).toBe("true");
    const statusTiles = screen.getByRole("tablist", { name: "Filter by status" });
    expect(statusTiles.textContent).toContain("All 3");
    expect(statusTiles.textContent).toContain("Submitted 0");
    expect(screen.queryByText("Oldco 0")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Imported 3" }));
    expect(statusTiles.textContent).toContain("All 3");
    expect(statusTiles.textContent).toContain("Submitted 3");
    expect(screen.getByText("Oldco 0")).toBeTruthy();
    expect(screen.queryByText("Acme")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All sources 6" }));
    expect(statusTiles.textContent).toContain("All 6");
  });

  it("opens the Activity tab on the whole picture: totals since the first day, per day, and the earlier campaign apart", async () => {
    renderPane();
    await waitFor(() => expect(screen.getByRole("tab", { name: /Activity/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /Activity/ }));
    const overview = await screen.findByRole("region", { name: "Overview" });
    expect(overview.textContent).toContain("Since Oct 13 · 2 active days");
    expect(overview.textContent).toContain("71 applied");
    expect(overview.textContent).toContain("Earlier campaign (imported): 500 sent · 27 failed");
    expect(overview.textContent).not.toContain("Archived");
    const rows = Array.from(overview.querySelectorAll("tbody tr")).map((row) => Array.from(row.children).map((cell) => cell.textContent));
    expect(rows).toEqual([["Oct 14", "24", "24", "0"], ["Oct 13", "47", "47", "0"]]);
  });

  it("explains a reset before doing it, sends it only on confirmation, and archives earlier rows in the Queue", async () => {
    const { stats } = await apiMock.jobApplyStats("UTC");
    apiMock.resetJobApply.mockResolvedValue({ reset: { campaignStartedAt: "2026-10-14T06:00:00.000Z", closed: 2, runsStopped: 1 } });
    const onDone = vi.fn();
    render(<StartOver campaignStartedAt={null} stats={stats} applications={applications} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset and start over…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Reset Job Copilot and start over?");
    expect(dialog.textContent).toContain("close 2 open postings (queued, in progress or waiting for you) as Failed");
    expect(dialog.textContent).toContain("all 571 sent applications as archived history");
    expect(dialog.textContent).toContain("Nothing is deleted.");
    // Cancel changes nothing.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(apiMock.resetJobApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reset and start over…" }));
    await act(async () => { fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Reset and start over" })); });
    expect(apiMock.resetJobApply).toHaveBeenCalledWith(null);
    expect(onDone).toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Started over: 2 open postings closed, 1 run stopped. Nothing was deleted.");
    cleanup();

    // After the reset, Space rows created before it are archived and leave the default view.
    const before = { ...applications[0]!, id: "jobapp:a00021", createdAt: "2026-10-13T08:00:00.000Z" };
    const after = { ...applications[2]!, id: "jobapp:a00022", url: "https://jobs.lever.co/umbrella/22", createdAt: "2026-10-14T07:00:00.000Z" };
    render(<QueueTab applications={[before, after]} campaignStartedAt="2026-10-14T06:00:00.000Z" paneId={pane.id} selectedId={null} onSelect={() => undefined} onCreated={() => undefined} onRefresh={() => undefined} />);
    expect(screen.getByRole("button", { name: "Space 1" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Archived 1" })).toBeTruthy();
    expect(screen.queryByText(before.company)).toBeNull();
  });

  it("tags a posting deferred by an employer limit until its date, and a passed date as a normal queued row", async () => {
    const until = "2027-02-24T00:00:00.000Z";
    const deferred = { ...applications[2]!, notBefore: until, notes: "limit: candidates may not apply more than 5 times in any 180 day span" };
    const expired = { ...applications[2]!, id: "jobapp:a00009", company: "Umbrella", url: "https://jobs.lever.co/umbrella/9", notBefore: "2026-01-01T00:00:00.000Z" };
    apiMock.jobApplications.mockResolvedValue({ applications: [applications[0]!, applications[1]!, deferred, expired] });
    renderPane();
    await waitFor(() => expect(screen.getByRole("tab", { name: /Queue/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /Queue/ }));
    await waitFor(() => expect(screen.getByText("Initech")).toBeTruthy());
    const tags = screen.getAllByText(/^Deferred until /);
    expect(tags).toHaveLength(1);
    expect(tags[0]!.textContent).toBe(`Deferred until ${new Date(until).toLocaleDateString()}`);
    expect(tags[0]!.closest("li")!.textContent).toContain("Initech");
    expect(screen.getByText("limit: candidates may not apply more than 5 times in any 180 day span")).toBeTruthy();
    expect(screen.getByText("Umbrella").closest("li")!.textContent).not.toContain("Deferred");
  });

  it("teaches the copilot a memory from the Memory tab", async () => {
    apiMock.rememberJobApplyMemory.mockResolvedValue({ memory: { id: "jobmem:m00002" } });
    renderPane();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Memory" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Memory" }));
    await waitFor(() => expect(screen.getByText("Nothing remembered yet")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Teach/ }));
    fireEvent.change(screen.getByLabelText("What should the copilot remember?"), { target: { value: "Prefer remote roles." } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remember" })); });
    await waitFor(() => expect(apiMock.rememberJobApplyMemory).toHaveBeenCalledWith({ kind: "FACT", text: "Prefer remote roles.", source: "USER", pinned: false }));
    await waitFor(() => expect(screen.getByText("The copilot will remember that.")).toBeTruthy());
  });

  it("discovers postings on public boards from the Queue tab and queues the fresh ones", async () => {
    apiMock.discoverJobApplyPostings.mockResolvedValue({ postings: [
      { url: "https://boards.greenhouse.io/hooli/jobs/5", ats: "greenhouse", board: "hooli", company: "Hooli", role: "Backend Engineer", location: "Remote - EU", remote: true, postedAt: now, tracked: false },
      { url: "https://jobs.lever.co/initech/77", ats: "lever", board: "initech", company: "Initech", role: "Posting 77", location: "Athens", remote: false, postedAt: null, tracked: true }
    ], scanned: [{ ats: "greenhouse", board: "hooli", count: 1, error: null }, { ats: "lever", board: "hooli", count: 0, error: "no board" }], truncated: false });
    apiMock.addJobApplyQueue.mockResolvedValue({ queued: [], existing: 0, rejected: [] });
    renderPane();
    await waitFor(() => expect(screen.getByRole("tab", { name: /Queue/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /Queue/ }));
    fireEvent.click(screen.getByRole("button", { name: /Discover/ }));
    fireEvent.change(screen.getByLabelText("Board tokens"), { target: { value: "hooli, Initech" } });
    fireEvent.change(screen.getByLabelText("Title contains"), { target: { value: "backend" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Search boards/ })); });
    await waitFor(() => expect(apiMock.discoverJobApplyPostings).toHaveBeenCalledWith(pane.id, { query: "backend", tokens: ["hooli", "initech"], remote: undefined, limit: 100 }));
    await waitFor(() => expect(screen.getByText("Hooli")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Tracked" })).toBeTruthy();
    expect(screen.getByText(/lever\/hooli: no board/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Queue" })); });
    await waitFor(() => expect(apiMock.addJobApplyQueue).toHaveBeenCalledWith(pane.id, ["https://boards.greenhouse.io/hooli/jobs/5"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Queued" })).toBeTruthy());
  });

  it("restarts a stopped browser only after the browser pane had its chance", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiMock.browserSession.mockResolvedValue({ session: { sessionId: "browser_session:1", status: "CLOSED" }, frame: null, websocket: null });
      apiMock.startBrowserSession.mockResolvedValue({ session: { sessionId: "browser_session:2", status: "RUNNING" }, frame: null, websocket: null });
      renderPane();
      await waitFor(() => expect(apiMock.browserSession).toHaveBeenCalled());
      expect(apiMock.startBrowserSession).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
      await waitFor(() => expect(apiMock.startBrowserSession).toHaveBeenCalledWith(pane.id, { targetUrl: "about:blank" }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("QueueTab history", () => {
  afterEach(() => cleanup());
  it("marks rows imported from an earlier tracker, shows when they were sent and links the real posting", () => {
    const appliedAt = "2026-09-02T20:09:07.000Z";
    const imported: JobApplication[] = [
      { ...applications[0]!, id: "jobapp:imp00001", company: "SE Conquer AI", role: "Title not recorded", ats: "linkedin", status: "FAILED", evidenceArtifactIds: [], externalConfirmation: null,
        url: "https://space.local/imported/NO_FORM/linkedin_4453887122", notes: "imported id: linkedin_4453887122 | earlier tracker: no application form found", appliedAt },
      { ...applications[0]!, id: "jobapp:imp00002", company: "databricks", role: "Title not recorded", ats: "greenhouse", status: "SUBMITTED", evidenceArtifactIds: [], externalConfirmation: null,
        url: "https://space.local/imported/gh-iframe/databricks_8569390002", notes: "imported id: databricks_8569390002 | earlier tracker said verified; no confirmation email checked yet", appliedAt }
    ];
    render(<QueueTab applications={imported} paneId={pane.id} selectedId={null} onSelect={() => undefined} onCreated={() => undefined} onRefresh={() => undefined} />);
    // Imported history waits behind its own source switch; Space's own rows come first.
    expect(screen.getByText("Space has not queued or sent anything yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Imported 2" }));
    expect(screen.getAllByText("Imported")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Open SE Conquer AI posting" }).getAttribute("href")).toBe("https://www.linkedin.com/jobs/view/4453887122/");
    expect(screen.getByRole("link", { name: "Open databricks posting" }).getAttribute("href")).toBe("https://job-boards.greenhouse.io/databricks/jobs/8569390002");
    expect(screen.getAllByText("Title not recorded")[0]!.className).toContain("jc-muted");
    expect(applicationWhen(imported[0]!, Date.parse("2026-10-13T08:00:00.000Z"))).toEqual({ text: `Tried ${new Date(appliedAt).toLocaleDateString()}`, title: appliedAt });
    expect(applicationWhen(imported[1]!, Date.parse("2026-10-13T08:00:00.000Z")).text).toBe(`Applied ${new Date(appliedAt).toLocaleDateString()}`);
    expect(applicationWhen({ status: "QUEUED", appliedAt: null, updatedAt: "2026-10-13T07:00:00.000Z" }, Date.parse("2026-10-13T08:00:00.000Z")).text).toBe("1 h ago");
  });

  it("checks sent applications with Gmail and marks those without a confirmation email", async () => {
    const onRefresh = vi.fn();
    const unconfirmed = { ...applications[0]!, id: "jobapp:imp00003", company: "snowflake", status: "SUBMITTED" as const, evidenceArtifactIds: [], externalConfirmation: null,
      notes: "imported id: snowflake_123456 | earlier tracker said verified | no confirmation email found (checked 2026-10-13)" };
    apiMock.checkJobApplyMail.mockResolvedValue({ checked: 2, confirmed: 1, unconfirmed: 1, accounts: ["me@gmail.com", "work@gmail.com"] });
    render(<QueueTab applications={[unconfirmed]} paneId={pane.id} selectedId={null} onSelect={() => undefined} onCreated={() => undefined} onRefresh={onRefresh} />);
    expect(screen.getByText("No email")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check with Gmail" })); });
    expect(apiMock.checkJobApplyMail).toHaveBeenCalledWith(pane.id);
    expect(await screen.findByText("Checked 2 sent applications in me@gmail.com, work@gmail.com: 1 confirmed by email, 1 without a confirmation email.")).toBeTruthy();
    expect(onRefresh).toHaveBeenCalled();
  });
});

describe("JobCopilotLaunchDialog", () => {
  const profileRow = (runtimeId: string, profileId: string, displayName: string) => ({ runtimeId, profileId, displayName, createdAt: now, updatedAt: now, updatedBy: null });
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    apiMock.cliRuntimes.mockResolvedValue(registry);
    apiMock.cliRuntimesSnapshot.mockReturnValue(null);
    apiMock.updateUserSettings.mockResolvedValue({});
    apiMock.listCliAccountProfiles.mockImplementation(async (runtimeId: string) => runtimeId === "cli:gemini"
      ? { profiles: [profileRow("cli:gemini", "main", "Main"), profileRow("cli:gemini", "personal", "Personal")], gatewayProfile: null }
      : { profiles: [profileRow("cli:claude", "main", "Main"), profileRow("cli:claude", "work", "Work"), profileRow("cli:claude", "space-gateway", "Space Gateway (pooled)")],
        gatewayProfile: { profileId: "space-gateway", ready: true } });
  });
  afterEach(() => cleanup());

  it("preselects Claude Code, offers no account choice, remembers the choice and creates the pane on the Space Gateway pool", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<JobCopilotLaunchDialog preselect={{ runtimeId: "cli:claude", accountProfileId: "work", askOnLaunch: true }} onClose={() => undefined} onCreate={onCreate} />);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Claude Code CLI/ }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText("Recommended")).toBeTruthy();
    // Operator decision 2026-10-19: no account picker; a new pane starts on the ready gateway pool, even over an account saved earlier.
    expect(screen.queryByLabelText("Claude Code account")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /OpenCode CLI/ }));
    expect(screen.getByRole("button", { name: "Open with OpenCode" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Claude Code CLI/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Remember as my default" }));
    expect(screen.getByText(/Change it in Settings → Job Copilot/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: "Open with Claude Code" }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open with Claude Code" })); });
    expect(onCreate).toHaveBeenCalledWith({ terminalRuntimeId: "cli:claude", accountProfileId: "space-gateway" });
    // Chosen once, saved server-side: later Job Copilot panes open with it on every device without the dialog.
    expect(apiMock.updateUserSettings).toHaveBeenCalledWith({ jobCopilot: { runtimeId: "cli:claude", accountProfileId: "space-gateway", askOnLaunch: false } });
  });

  it("starts a CLI without a gateway pool on its default account and Codex on the gateway, with no account field", async () => {
    apiMock.cliRuntimes.mockResolvedValue({ ...registry, data: [...registry.data, runtime("cli:gemini", "Gemini CLI")] });
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<JobCopilotLaunchDialog onClose={() => undefined} onCreate={onCreate} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Gemini CLI/ }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Open with Gemini" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByLabelText("Gemini account")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open with Gemini" })); });
    expect(onCreate).toHaveBeenLastCalledWith({ terminalRuntimeId: "cli:gemini", accountProfileId: "main" });
    cleanup();
    render(<JobCopilotLaunchDialog onClose={() => undefined} onCreate={onCreate} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Codex CLI/ }));
    expect(screen.queryByRole("note")).toBeNull();
    expect(apiMock.listCliAccountProfiles).not.toHaveBeenCalledWith("cli:codex");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open with Codex" })); });
    expect(onCreate).toHaveBeenLastCalledWith({ terminalRuntimeId: "cli:codex", accountProfileId: null });
  });

  it("starts on the saved choice when asked every time, keeps asking without Remember, and says why a saved CLI is skipped", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<JobCopilotLaunchDialog preselect={{ runtimeId: "cli:codex", accountProfileId: null, askOnLaunch: true }} onClose={() => undefined} onCreate={onCreate} />);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Codex CLI/ }).getAttribute("aria-checked")).toBe("true"));
    expect((screen.getByRole("switch", { name: "Remember as my default" }) as HTMLInputElement).checked).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open with Codex" })); });
    expect(apiMock.updateUserSettings).toHaveBeenCalledWith({ jobCopilot: { runtimeId: "cli:codex", accountProfileId: null, askOnLaunch: true } });
    cleanup();
    const onClose = vi.fn();
    render(<JobCopilotLaunchDialog notice="Your default agent, Grok Build, is not ready: Login required" onClose={onClose} onCreate={onCreate} />);
    expect(screen.getByText("Your default agent, Grok Build, is not ready: Login required").getAttribute("role")).toBe("status");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("opens a new pane at once on the remembered agent only while it is ready and asking is off", () => {
    const options = jobCopilotRuntimeOptions(registry);
    expect(jobCopilotLaunchDecision(undefined, options)).toEqual({ open: false, preselect: null, notice: null });
    expect(jobCopilotLaunchDecision({ runtimeId: "cli:claude", accountProfileId: "work", askOnLaunch: false }, options))
      .toEqual({ open: true, label: "Claude Code", choice: { terminalRuntimeId: "cli:claude", accountProfileId: "work" } });
    // Codex has no account profiles: its pane starts on the Space Gateway pool whatever was saved.
    expect(jobCopilotLaunchDecision({ runtimeId: "cli:codex", accountProfileId: "work", askOnLaunch: false }, options))
      .toEqual({ open: true, label: "Codex", choice: { terminalRuntimeId: "cli:codex", accountProfileId: null } });
    const ask = { runtimeId: "cli:claude", accountProfileId: null, askOnLaunch: true };
    expect(jobCopilotLaunchDecision(ask, options)).toEqual({ open: false, preselect: ask, notice: null });
    const notReady = jobCopilotRuntimeOptions({ ...registry, data: [runtime("cli:claude", "Claude Code CLI", false)] });
    expect(jobCopilotLaunchDecision({ runtimeId: "cli:claude", accountProfileId: null, askOnLaunch: false }, notReady))
      .toEqual({ open: false, preselect: null, notice: "Your default agent, Claude Code, is not ready: Login required" });
    expect(jobCopilotLaunchDecision({ runtimeId: "cli:grok", accountProfileId: null, askOnLaunch: false }, options))
      .toEqual({ open: false, preselect: null, notice: "Your default agent, Grok Build, is not available. Choose another one." });
  });
});

describe("JobCopilotSettingsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    apiMock.cliRuntimes.mockResolvedValue(registry);
    apiMock.cliRuntimesSnapshot.mockReturnValue(registry);
    apiMock.updateUserSettings.mockResolvedValue({});
    apiMock.listCliAccountProfiles.mockResolvedValue({ profiles: [
      { runtimeId: "cli:claude", profileId: "main", displayName: "Main", createdAt: now, updatedAt: now, updatedBy: null },
      { runtimeId: "cli:claude", profileId: "work", displayName: "Work", createdAt: now, updatedAt: now, updatedBy: null }
    ], gatewayProfile: null });
  });
  afterEach(() => cleanup());

  it("changes the default agent, its account and asking, saved to the user's settings", async () => {
    apiMock.userSettings.mockResolvedValue({ jobCopilot: { runtimeId: "cli:claude", accountProfileId: "work", askOnLaunch: false } });
    render(<JobCopilotSettingsCard />);
    const agent = await screen.findByRole("combobox", { name: "Default Job Copilot agent" }) as HTMLSelectElement;
    await waitFor(() => expect(agent.value).toBe("cli:claude"));
    expect((await screen.findByRole("combobox", { name: "Claude Code account" }) as HTMLSelectElement).value).toBe("work");
    const ask = screen.getByRole("switch", { name: "Ask which agent every time" }) as HTMLInputElement;
    expect(ask.checked).toBe(false);
    await act(async () => { fireEvent.click(ask); });
    expect(apiMock.updateUserSettings).toHaveBeenLastCalledWith({ jobCopilot: { runtimeId: "cli:claude", accountProfileId: "work", askOnLaunch: true } });
    await act(async () => { fireEvent.change(screen.getByRole("combobox", { name: "Claude Code account" }), { target: { value: "main" } }); });
    expect(apiMock.updateUserSettings).toHaveBeenLastCalledWith({ jobCopilot: { runtimeId: "cli:claude", accountProfileId: "main", askOnLaunch: true } });
    await act(async () => { fireEvent.change(agent, { target: { value: "cli:codex" } }); });
    expect(apiMock.updateUserSettings).toHaveBeenLastCalledWith({ jobCopilot: { runtimeId: "cli:codex", accountProfileId: null, askOnLaunch: true } });
    expect(screen.queryByRole("combobox", { name: "Codex account" })).toBeNull();
    expect(screen.getByText(/every Codex pane uses the gateway's ChatGPT accounts/)).toBeTruthy();
  });

  it("turning asking off without a saved agent picks the recommended ready CLI", async () => {
    apiMock.userSettings.mockResolvedValue({});
    render(<JobCopilotSettingsCard />);
    const ask = await screen.findByRole("switch", { name: "Ask which agent every time" }) as HTMLInputElement;
    await waitFor(() => expect(ask.disabled).toBe(false));
    expect(ask.checked).toBe(true);
    await act(async () => { fireEvent.click(ask); });
    expect(apiMock.updateUserSettings).toHaveBeenCalledWith({ jobCopilot: { runtimeId: "cli:claude", accountProfileId: null, askOnLaunch: false } });
  });
});
