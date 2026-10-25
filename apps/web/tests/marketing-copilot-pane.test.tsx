import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, MarketingCopilotPaneMetadata, MarketingPost, Pane } from "@space/contracts";
import { defaultMarketingCopilotPaneMetadata } from "@space/contracts";
import { MarketingCopilotPane, resolveActiveTab, tabsForLayout } from "../src/features/marketing-copilot-pane/MarketingCopilotPane.js";
import { MARKETING_COPILOT_KIND, copilotKindForMode } from "../src/features/copilot-kit/copilot-kind.js";
import { summarizeMetrics } from "../src/features/marketing-copilot-pane/AnalyticsTab.js";
import { registerBrowserPaneEventTarget } from "../src/features/browser-pane/events.js";

const apiMock = vi.hoisted(() => ({
  artifactFileUrl: (id: string) => `/api/artifacts/${encodeURIComponent(id)}/file`,
  marketingCopilotSettings: vi.fn(),
  updateMarketingCopilotSettings: vi.fn(),
  userSettings: vi.fn(),
  updateUserSettings: vi.fn(),
  cliRuntimes: vi.fn(),
  cliRuntimesSnapshot: vi.fn(),
  listCliAccountProfiles: vi.fn(),
  updatePane: vi.fn(),
  createCliSession: vi.fn(),
  activeCliSession: vi.fn(),
  marketingCopilotRun: vi.fn(),
  marketingCopilotRunAction: vi.fn(),
  marketingEvents: vi.fn(),
  marketingPosts: vi.fn(),
  marketingCampaigns: vi.fn(),
  createMarketingBrief: vi.fn(),
  decideMarketingPost: vi.fn(),
  marketingMemory: vi.fn(),
  createMarketingCampaign: vi.fn(),
  browserHandoff: vi.fn(),
  navigateBrowser: vi.fn(),
  browserAccounts: vi.fn(),
  marketingBookmarks: vi.fn(),
  createMarketingBookmark: vi.fn(),
  deleteMarketingBookmark: vi.fn(),
  openMarketingBookmark: vi.fn(),
  requestDesignFromPane: vi.fn(),
  requestVideoFromPane: vi.fn()
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
  id: "pane:mkt000001", roomId: "room:mkt000001", title: "Marketing Copilot 1", titleSource: "auto", mode: "MARKETING_COPILOT", status: "IDLE",
  providerId: null, modelId: null, reasoningEffort: "medium", cwd: null, order: 0, columnSpan: 1, isMaximized: false, isMinimized: false,
  isClosed: false, split: { parentId: null, direction: null, size: null }, categoryColor: null, vncTarget: null, terminalRuntimeId: "cli:claude",
  createdAt: "2026-10-14T08:00:00.000Z", updatedAt: "2026-10-14T08:00:00.000Z"
} as Pane;

describe("MarketingCopilotPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    apiMock.marketingCopilotSettings.mockResolvedValue({ metadata: defaultMarketingCopilotPaneMetadata() });
    apiMock.updateMarketingCopilotSettings.mockImplementation(async (_paneId: string, next: MarketingCopilotPaneMetadata) => ({ metadata: next }));
    apiMock.userSettings.mockResolvedValue({ marketingCopilot: null });
    apiMock.cliRuntimes.mockResolvedValue(registry);
    apiMock.cliRuntimesSnapshot.mockReturnValue(registry);
    apiMock.listCliAccountProfiles.mockResolvedValue({ runtimeId: "cli:claude", profiles: [{ profileId: "main", displayName: "Main" }], gatewayProfile: null, defaultProfileId: "main" });
    apiMock.activeCliSession.mockResolvedValue({ session: { runtimeId: "cli:claude", accountProfileId: "main" } });
    apiMock.marketingCopilotRun.mockResolvedValue({ run: null, status: "IDLE", pending: [], backlog: 0 });
    apiMock.marketingCopilotRunAction.mockResolvedValue({ run: null, status: "RUNNING", pending: [], backlog: 1 });
    apiMock.marketingEvents.mockResolvedValue({ events: [] });
    apiMock.marketingPosts.mockResolvedValue({ posts: [] });
    apiMock.marketingCampaigns.mockResolvedValue({ campaigns: [] });
    apiMock.createMarketingBrief.mockResolvedValue({ brief: {} });
    apiMock.decideMarketingPost.mockResolvedValue({ post: {} });
    apiMock.marketingMemory.mockResolvedValue({ memories: [] });
    apiMock.browserHandoff.mockResolvedValue({ handoff: null });
    apiMock.createMarketingCampaign.mockResolvedValue({ campaign: {} });
    apiMock.navigateBrowser.mockResolvedValue({});
    apiMock.browserAccounts.mockResolvedValue({ selectedProfileId: null, effectiveProfileId: "google_account:dev", profiles: [
      { profileId: "google_account:dev", displayName: "Google account · spaceappdv@gmail.com", email: "spaceappdv@gmail.com" },
      { profileId: "google_account:me", displayName: "Google account · ntheogr@gmail.com", email: "ntheogr@gmail.com" }
    ] });
    apiMock.marketingBookmarks.mockResolvedValue({ bookmarks: [] });
    apiMock.openMarketingBookmark.mockResolvedValue({});
    apiMock.deleteMarketingBookmark.mockResolvedValue({ deleted: true });
  });
  afterEach(() => cleanup());

  it("is a copilot kind of its own with the browser as a tab only when stacked", () => {
    expect(copilotKindForMode("MARKETING_COPILOT")).toBe(MARKETING_COPILOT_KIND);
    expect(tabsForLayout("split")).toEqual(["posts", "activity", "analytics", "memory", "bookmarks", "setup", "terminal"]);
    expect(tabsForLayout("stacked")).toEqual(["browser", "posts", "activity", "analytics", "memory", "bookmarks", "setup", "terminal"]);
    expect(resolveActiveTab("browser", "split")).toBe("posts");
  });

  it("hosts the browser and the terminal, shows the agent, autonomy and channels, and saves Paused", async () => {
    render(<MarketingCopilotPane pane={pane} isVisible terminal={<div data-testid="terminal">xterm</div>} browser={<div data-testid="browser">chrome</div>} />);
    await waitFor(() => expect(apiMock.marketingCopilotSettings).toHaveBeenCalledWith(pane.id));
    expect(screen.getByTestId("browser")).toBeTruthy();
    expect(screen.getByTestId("terminal")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copilot agent: Claude Code CLI/ })).toBeTruthy();
    expect(await screen.findByText("Idle · Assist")).toBeTruthy();
    expect(screen.getByText("9/9 channels")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("switch", { name: "Paused" })[0]!);
    await waitFor(() => expect(apiMock.updateMarketingCopilotSettings).toHaveBeenCalledWith(pane.id, expect.objectContaining({ settings: expect.objectContaining({ paused: true }) })));
  });

  it("lists every channel with its cap and limit and saves a channel switched off", async () => {
    render(<MarketingCopilotPane pane={pane} isVisible terminal={<div />} browser={<div />} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Setup/ }));
    const list = await screen.findByRole("list", { name: "Channels" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(9);
    expect((screen.getByRole("combobox", { name: "Hacker News highest autonomy" }) as HTMLSelectElement).value).toBe("ASSIST");
    expect((screen.getByRole("spinbutton", { name: "X posts per period" }) as HTMLInputElement).value).toBe("3");
    fireEvent.click(within(list).getByRole("switch", { name: /^Reddit/ }));
    await waitFor(() => expect(apiMock.updateMarketingCopilotSettings).toHaveBeenCalledWith(pane.id, expect.objectContaining({
      settings: expect.objectContaining({ channels: expect.objectContaining({ REDDIT: expect.objectContaining({ enabled: false }), X: expect.objectContaining({ enabled: true }) }) })
    })));
    expect(await screen.findByText("Reddit saved.")).toBeTruthy();
    // Login once per channel in the pane's own browser.
    fireEvent.click(within(list).getByRole("button", { name: "Log in to X" }));
    await waitFor(() => expect(apiMock.navigateBrowser).toHaveBeenCalledWith(pane.id, "https://x.com/login"));
    expect(within(list).queryByRole("button", { name: "Log in to Blog" })).toBeNull();
  });

  it("saves a bookmark with its Google account, opens it in the pane browser and deletes it", async () => {
    const saved = { id: "mktbm:abc123", ownerUserId: "user:operator", title: "x.com", url: "https://x.com", profileId: "google_account:me", accountLabel: "ntheogr@gmail.com", createdAt: "2026-10-16T10:00:00.000Z" };
    apiMock.createMarketingBookmark.mockResolvedValue({ bookmark: saved });
    const tabs = vi.fn();
    window.addEventListener("space:browser-pane-action", tabs);
    const unregister = registerBrowserPaneEventTarget(pane.id);
    render(<MarketingCopilotPane pane={pane} isVisible terminal={<div />} browser={<div />} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Bookmarks/ }));
    // With no bookmarks yet the form is open at once.
    const account = await screen.findByRole("combobox", { name: "Google account" }) as HTMLSelectElement;
    // A new bookmark starts with the account the pane opens with.
    await waitFor(() => expect(account.value).toBe("google_account:dev"));
    fireEvent.change(account, { target: { value: "google_account:me" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Address" }), { target: { value: "x.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Save bookmark/ }));
    await waitFor(() => expect(apiMock.createMarketingBookmark).toHaveBeenCalledWith({ url: "https://x.com", profileId: "google_account:me", accountLabel: "ntheogr@gmail.com" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open x.com with ntheogr@gmail.com" }));
    // The form folds away once there is a bookmark; Add bookmark opens it again.
    expect(screen.queryByRole("textbox", { name: "Address" })).toBeNull();
    expect(screen.getByRole("button", { name: /Add bookmark/ }).getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(apiMock.openMarketingBookmark).toHaveBeenCalledWith(pane.id, saved.id));
    // The pane browser shows the new tab at once instead of at its next page poll.
    await waitFor(() => expect(tabs).toHaveBeenCalledWith(expect.objectContaining({ detail: { paneId: pane.id, action: "tabs" } })));
    window.removeEventListener("space:browser-pane-action", tabs);
    unregister();
    fireEvent.click(screen.getByRole("button", { name: "Delete bookmark x.com" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Open x\.com/ })).toBeNull());
    expect(apiMock.deleteMarketingBookmark).toHaveBeenCalledWith(saved.id);
  });

  it("lists a bookmark as one card: its title without the unread counter, the site and the account", async () => {
    apiMock.marketingBookmarks.mockResolvedValue({ bookmarks: [
      { id: "mktbm:abc123", ownerUserId: "user:operator", title: "(1) SpaceApp.dev on X: a long post title", url: "https://www.x.com/spaceapp_dev/status/1", profileId: "google_account:dev", accountLabel: "spaceappdv@gmail.com", createdAt: "2026-10-16T10:00:00.000Z" },
      { id: "mktbm:def456", ownerUserId: "user:operator", title: "GitHub", url: "https://github.com/oll4com/spaceapp", profileId: null, accountLabel: null, createdAt: "2026-10-16T10:01:00.000Z" }
    ] });
    render(<MarketingCopilotPane pane={pane} isVisible terminal={<div />} browser={<div />} />);
    fireEvent.click(await screen.findByRole("tab", { name: /Bookmarks/ }));
    const card = await screen.findByRole("button", { name: "Open SpaceApp.dev on X: a long post title with spaceappdv@gmail.com" });
    expect(card.textContent).toBe("xSpaceApp.dev on X: a long post titlex.comSspaceappdv@gmail.com");
    expect(screen.getByRole("button", { name: "Open GitHub" }).textContent).toContain("Pane's account");
    expect(screen.getByText(/^2 bookmarks/).textContent).toBe("2 bookmarks · right-click a browser tab to save it");
    expect(screen.queryByRole("textbox", { name: "Address" })).toBeNull();
  });

  it("shows the login request in a strip above the browser, never over it", async () => {
    apiMock.browserHandoff.mockResolvedValue({ handoff: { handoffRequestId: "handoff:1", status: "REQUESTED", reason: "X asks for a login before posting", requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), acceptedAt: null } });
    const { container } = render(<MarketingCopilotPane pane={pane} isVisible terminal={<div />} browser={<div data-testid="browser" />} />);
    const strip = await screen.findByRole("status", { name: "The copilot needs you" });
    expect(strip.textContent).toContain("X asks for a login before posting");
    expect(within(strip).getByRole("button", { name: "Take control" })).toBeTruthy();
    // The strip sits beside the browser (the operator can work in the page at once), and the pane marks the request
    // so the browser's control icon pulses.
    expect(strip.classList.contains("jc-handoff-strip")).toBe(true);
    expect(strip.contains(screen.getByTestId("browser"))).toBe(false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(container.querySelector("[data-handoff]")?.getAttribute("data-handoff")).toBe("requested");
  });

  it("sends briefs, starts the run and decides a post in review (approve, or approve the operator's edit)", async () => {
    const post = { id: "mktpost:abc123", ownerUserId: "user:operator", paneId: pane.id, campaignId: null, channel: "X", kind: "POST", target: null, title: null,
      body: "SpaceApp runs your AI coding CLIs side by side.", assets: [], status: "IN_REVIEW", scheduledAt: null, reviewNote: null, ruleId: null, publishedUrl: null, publishedAt: null,
      evidence: {}, metrics: {}, createdAt: "2026-10-14T08:00:00.000Z", updatedAt: "2026-10-14T08:00:00.000Z" } as MarketingPost;
    apiMock.marketingPosts.mockResolvedValue({ posts: [post] });
    render(<MarketingCopilotPane pane={pane} isVisible terminal={<div />} browser={<div />} />);
    const review = await screen.findByRole("region", { name: "Needs your review" });
    expect(within(review).getByText("47/280")).toBeTruthy();
    fireEvent.click(within(review).getByRole("button", { name: /^Approve$/ }));
    await waitFor(() => expect(apiMock.decideMarketingPost).toHaveBeenCalledWith(pane.id, post.id, { decision: "approve", scheduledAt: null }));
    fireEvent.change(within(review).getByRole("textbox", { name: "Post text" }), { target: { value: "I built SpaceApp: seamless agents." } });
    expect(within(review).getByRole("note").textContent).toContain("seamless");
    fireEvent.click(within(review).getByRole("button", { name: "Approve my version" }));
    await waitFor(() => expect(apiMock.decideMarketingPost).toHaveBeenLastCalledWith(pane.id, post.id, { decision: "edit", title: null, body: "I built SpaceApp: seamless agents.", scheduledAt: null }));
    // Send back needs a note.
    expect((within(review).getByRole("button", { name: /Send back/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(review).queryByRole("list", { name: "Post media" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Brief for the copilot" }), { target: { value: "A launch thread for 0.2.5" } });
    fireEvent.click(screen.getByRole("button", { name: /Ask/ }));
    await waitFor(() => expect(apiMock.createMarketingBrief).toHaveBeenCalledWith(pane.id, { text: "A launch thread for 0.2.5" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(apiMock.marketingCopilotRunAction).toHaveBeenCalledWith(pane.id, "start"));
  });
});

describe("post media", () => {
  it("shows the captures a post will upload (video and image) and a pane file by its kind", async () => {
    const post = { id: "mktpost:media01", ownerUserId: "user:operator", paneId: "pane:mkt000001", campaignId: null, channel: "LINKEDIN", kind: "POST", target: null, title: null,
      body: "SpaceApp on a phone.", status: "APPROVED", scheduledAt: null, reviewNote: null, ruleId: null, publishedUrl: null, publishedAt: null,
      assets: [{ artifactId: "artifact:video1", path: "/opt/spaceapp/var/artifacts/browser-evidence/space-control-x/video-story.mp4", label: "9:16 tour", kind: "VIDEO" },
        { artifactId: "artifact:shot1", path: "/opt/spaceapp/var/artifacts/browser-evidence/space-control-y/screenshot.png", label: "1:1 shot", kind: "IMAGE" },
        { path: "/opt/spaceapp/var/artifacts/cli-workspaces/a/logo.svg", label: "Logo", kind: "FILE" }],
      evidence: {}, metrics: {}, createdAt: "2026-10-17T08:00:00.000Z", updatedAt: "2026-10-17T08:00:00.000Z" } as MarketingPost;
    apiMock.marketingPosts.mockResolvedValue({ posts: [post] });
    render(<MarketingCopilotPane pane={pane} isVisible terminal={<div />} browser={<div />} />);
    const media = await screen.findByRole("list", { name: "Post media" });
    expect(within(media).getByLabelText("9:16 tour").getAttribute("src")).toBe("/api/artifacts/artifact%3Avideo1/file");
    expect(within(media).getByRole("img", { name: "1:1 shot" }).getAttribute("src")).toBe("/api/artifacts/artifact%3Ashot1/file");
    expect(within(media).getByText("file")).toBeTruthy();
    expect(within(media).getByText("Logo")).toBeTruthy();
    fireEvent.click(within(media).getByRole("img", { name: "1:1 shot" }));
    const preview = screen.getByRole("dialog", { name: "Preview 1:1 shot" });
    expect(within(preview).getByRole("img", { name: "1:1 shot" }).getAttribute("src")).toBe("/api/artifacts/artifact%3Ashot1/file");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Preview 1:1 shot" })).toBeNull();
  });
});

describe("Make video", () => {
  it("asks the Video pane for the channel's video format with the post as the callback, only on channels that take video", async () => {
    const base = { ownerUserId: "user:operator", paneId: pane.id, campaignId: null, kind: "POST", target: null, title: null, assets: [], scheduledAt: null, reviewNote: null, ruleId: null,
      publishedUrl: null, publishedAt: null, evidence: {}, metrics: {}, createdAt: "2026-10-21T08:00:00.000Z", updatedAt: "2026-10-21T08:00:00.000Z" };
    const x = { ...base, id: "mktpost:xpost01", channel: "X", body: "SpaceApp cuts videos now.", status: "DRAFT" } as MarketingPost;
    const reddit = { ...base, id: "mktpost:reddit1", channel: "REDDIT", body: "A text post", status: "DRAFT" } as MarketingPost;
    apiMock.marketingPosts.mockResolvedValue({ posts: [x, reddit] });
    apiMock.requestVideoFromPane.mockResolvedValue({ request: { id: "vreq:abc123" }, videoPaneId: "pane:video0001" });
    render(<MarketingCopilotPane pane={pane} isVisible terminal={<div />} browser={<div />} />);
    const buttons = await screen.findAllByRole("button", { name: /Make video/ });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(apiMock.requestVideoFromPane).toHaveBeenCalledWith(pane.id, expect.objectContaining({
      formatIds: ["x"], callback: { kind: "MARKETING_POST", postId: x.id }, brief: expect.stringContaining("SpaceApp cuts videos now.") })));
    expect(await screen.findByText(/Sent to the Video pane/)).toBeTruthy();
  });
});

describe("Make graphic", () => {
  it("asks the Design pane for the channel's format with the post as the callback, and never for Hacker News", async () => {
    const base = { ownerUserId: "user:operator", paneId: pane.id, campaignId: null, kind: "POST", target: null, title: null, assets: [], scheduledAt: null, reviewNote: null, ruleId: null,
      publishedUrl: null, publishedAt: null, evidence: {}, metrics: {}, createdAt: "2026-10-18T08:00:00.000Z", updatedAt: "2026-10-18T08:00:00.000Z" };
    const linkedin = { ...base, id: "mktpost:linked1", channel: "LINKEDIN", body: "SpaceApp 0.3 is out.", status: "APPROVED" } as MarketingPost;
    const hn = { ...base, id: "mktpost:hacker1", channel: "HACKER_NEWS", body: "Show HN: SpaceApp", status: "DRAFT" } as MarketingPost;
    apiMock.marketingPosts.mockResolvedValue({ posts: [linkedin, hn] });
    apiMock.requestDesignFromPane.mockResolvedValue({ request: { id: "dreq:abc123" }, designPaneId: "pane:design0001" });
    render(<MarketingCopilotPane pane={pane} isVisible terminal={<div />} browser={<div />} />);
    const buttons = await screen.findAllByRole("button", { name: /Make graphic/ });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(apiMock.requestDesignFromPane).toHaveBeenCalledWith(pane.id, expect.objectContaining({
      formatIds: ["linkedin"], callback: { kind: "MARKETING_POST", postId: linkedin.id }, brief: expect.stringContaining("SpaceApp 0.3 is out.") })));
    expect(await screen.findByText(/Sent to the Design pane/)).toBeTruthy();
  });
});

describe("copilot stream forwarding", () => {
  it("forwards each copilot's server events to its pane's window event and stops on cleanup", async () => {
    const { forwardCopilotStreamEvents } = await import("../src/features/copilot-kit/copilot-stream.js");
    const { subscribeMarketingCopilotLiveEvents } = await import("../src/features/marketing-copilot-pane/live-events.js");
    const { subscribeMailCopilotLiveEvents } = await import("../src/features/mail-copilot-pane/live-events.js");
    const source = new EventTarget();
    const marketing = vi.fn();
    const mail = vi.fn();
    const stopMarketing = subscribeMarketingCopilotLiveEvents(pane.id, marketing);
    const stopMail = subscribeMailCopilotLiveEvents(pane.id, mail);
    const stop = forwardCopilotStreamEvents(source as unknown as EventSource);
    const send = (type: string, paneId: string | null) => source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ id: "event:1", roomId: pane.roomId, paneId, turnId: null, workflowId: null, traceId: "t", type, message: "Published", payload: { type: "PUBLISHED" }, createdAt: "2026-10-14T08:00:00.000Z" }) }));
    send("MARKETING_COPILOT_UPDATED", pane.id);
    send("MARKETING_COPILOT_UPDATED", null);
    expect(marketing).toHaveBeenCalledTimes(1);
    expect(marketing.mock.calls[0]![0]).toMatchObject({ paneId: pane.id, message: "Published", payload: { type: "PUBLISHED" } });
    expect(mail).not.toHaveBeenCalled();
    stop();
    send("MARKETING_COPILOT_UPDATED", pane.id);
    expect(marketing).toHaveBeenCalledTimes(1);
    stopMarketing(); stopMail();
  });
});

describe("marketing analytics", () => {
  it("summarizes each public number with its change over 7 and 30 days", () => {
    const rows = summarizeMetrics([
      { day: "2026-09-10", source: "GITHUB", key: "stars", value: 80 }, { day: "2026-10-07", source: "GITHUB", key: "stars", value: 100 },
      { day: "2026-10-14", source: "GITHUB", key: "stars", value: 107 }, { day: "2026-10-14", source: "NPM", key: "downloads_week", value: 210 }
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ source: "GITHUB", key: "stars", latest: 107, day: "2026-10-14", week: 7, month: 27 }),
      expect.objectContaining({ source: "NPM", key: "downloads_week", latest: 210, day: "2026-10-14", week: null, month: null })
    ]);
    expect(rows[0]!.trend.map((point) => point.value)).toEqual([80, 100, 107]);
  });
});

describe("marketing campaign templates", () => {
  beforeEach(() => {
    apiMock.marketingCopilotSettings.mockResolvedValue({ metadata: defaultMarketingCopilotPaneMetadata() });
    apiMock.marketingCopilotRun.mockResolvedValue({ run: null, status: "IDLE", pending: [], backlog: 0 });
    apiMock.marketingEvents.mockResolvedValue({ events: [] });
    apiMock.marketingPosts.mockResolvedValue({ posts: [] });
    apiMock.marketingCampaigns.mockResolvedValue({ campaigns: [] });
    apiMock.browserHandoff.mockResolvedValue({ handoff: null });
    apiMock.cliRuntimes.mockResolvedValue(registry);
    apiMock.cliRuntimesSnapshot.mockReturnValue(registry);
    apiMock.createMarketingCampaign.mockResolvedValue({ campaign: {} });
  });
  afterEach(() => cleanup());

  it("prefills a campaign from a template and starts it with the template's plan", async () => {
    render(<MarketingCopilotPane pane={pane} isVisible terminal={<div />} browser={<div />} />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Campaign template" }), { target: { value: "release" } });
    expect((screen.getByRole("textbox", { name: "Campaign name" }) as HTMLInputElement).value).toBe("Release announcement");
    fireEvent.click(screen.getByRole("button", { name: "Start campaign" }));
    await waitFor(() => expect(apiMock.createMarketingCampaign).toHaveBeenCalledWith(pane.id, expect.objectContaining({ name: "Release announcement", templateId: "release" })));
  });
});

describe("marketing analytics tab", () => {
  it("shows stat tiles with the weekly change and a sparkline, and keeps a table view", async () => {
    const { AnalyticsTab } = await import("../src/features/marketing-copilot-pane/AnalyticsTab.js");
    (apiMock as Record<string, unknown>).marketingAnalytics = vi.fn(async () => ({ published: 0, topPosts: [], metrics: [
      { day: "2026-10-07", source: "GITHUB", key: "stars", value: 1200 }, { day: "2026-10-14", source: "GITHUB", key: "stars", value: 1284 },
      { day: "2026-10-07", source: "GITHUB", key: "open_issues", value: 3 }, { day: "2026-10-14", source: "GITHUB", key: "open_issues", value: 5 }
    ] }));
    render(<AnalyticsTab />);
    const tiles = within(await screen.findByRole("list", { name: "Public numbers" })).getAllByRole("listitem");
    expect(tiles[0]!.textContent).toContain("1.3K");
    expect(within(tiles[0]!).getByText("+84 in 7 days").className).toContain("up");
    // More open issues is not good news: the change stays neutral.
    expect(within(tiles[1]!).getByText("+2 in 7 days").className).toContain("flat");
    expect(within(tiles[0]!).getByRole("img", { name: "GitHub stars, last 2 days: 1200 to 1284" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Public numbers table" })).toBeTruthy();
  });
});
