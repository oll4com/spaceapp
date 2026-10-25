import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentPaneSessionSchema, type AgentPaneSession, type DotFeed as DotFeedPage, type DotFeedItem, type DotProfile, type Pane } from "@space/contracts";
import { DotFeed, dotFeedSeparatorLabel, needsDotFeedSeparator } from "../src/features/agent-pane/DotFeed.js";
import { mergeLatestDotFeed } from "../src/features/agent-pane/useDotFeed.js";
import { dotActiveLabel, DotInfoCard, slackDirectUrl } from "../src/features/agent-pane/DotInfoCard.js";
import { OPEN_DOT_SETTINGS_EVENT } from "../src/features/agent-pane/dot-home-events.js";
import { AgentPane } from "../src/features/agent-pane/AgentPane.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const mock = vi.hoisted(() => ({ dots: vi.fn(), dotCollection: vi.fn(), agentSession: vi.fn(), createAgentSession: vi.fn(), codexThread: vi.fn(),
  sendAgentMessage: vi.fn(), uploadPaneFiles: vi.fn(), updateAgentSettings: vi.fn(), dotFeed: vi.fn(), markDotFeedRead: vi.fn(),
  dotComputer: vi.fn(), channels: vi.fn(), dotToolInvocations: vi.fn(), dotDeliverables: vi.fn(), browserFrame: vi.fn(),
  agentFileDownloadUrl: (id: string) => `/api/agent-files/${id}/download`, artifactFileUrl: (id: string) => `/api/artifacts/${id}/file` }));
vi.mock("../src/api.js", () => ({ api: mock }));
vi.mock("../src/features/voice-input/VoiceInputProvider.js", () => ({ useOptionalVoiceInput: () => null,
  useVoiceInput: () => ({ ownerId: null, status: "idle", settings: { enabled: true }, serverSettings: { enabled: true }, settingsLoading: false,
    cancel: vi.fn(), prewarm: vi.fn(), start: vi.fn(), stop: vi.fn() }) }));

const utc = { timeZone: "UTC", timeFormat: "12h" as const };
const orbit = { dotId: `dot:${"1".repeat(32)}`, ownerUserId: "user:one", slot: 1, name: "Orbit", appearance: { character: "astronaut", accent: "slate" },
  preferences: {}, permissions: { mode: "INHERIT_USER" }, workLimits: { maxConcurrentTasks: 1, dailyBudgetUsd: null },
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" } as DotProfile;
const dots = ["Orbit", "Nova", "Byte", "Comet", "Luna", "Cosmo"].map((name, i) => ({ ...orbit, dotId: `dot:${String(i + 1).repeat(32)}`, slot: i + 1, name,
  appearance: { character: (["astronaut", "star", "robot", "comet", "moon", "planet"] as const)[i]!, accent: "slate" as const } }));
const item = (input: Partial<DotFeedItem>): DotFeedItem => ({ id: "agent_msg:1", kind: "MESSAGE", author: "DOT", origin: "USER", content: "Hello",
  summary: null, status: "COMPLETED", createdAt: "2026-10-12T08:00:00.000Z", sessionId: "s:1", roomId: "room:1", runId: null, conversationStart: false,
  link: null, attachments: [], ...input });

beforeEach(() => { installSpaceRuntime(liveRuntime); sessionStorage.clear(); localStorage.clear(); vi.resetAllMocks(); });
afterEach(cleanup);

describe("feed dates", () => {
  const now = new Date("2026-10-12T20:06:00.000Z");
  it("labels separators like ChatGPT dot in the SpaceApp time zone and clock", () => {
    expect(dotFeedSeparatorLabel("2026-10-12T20:06:00.000Z", now, utc)).toBe("Today 8:06 PM");
    expect(dotFeedSeparatorLabel("2026-10-11T09:14:00.000Z", now, utc)).toBe("Yesterday 9:14 AM");
    expect(dotFeedSeparatorLabel("2026-10-07T13:37:00.000Z", now, utc)).toBe("Oct 7 1:37 PM");
    expect(dotFeedSeparatorLabel("2025-10-07T13:37:00.000Z", now, utc)).toBe("Oct 7, 2025 1:37 PM");
    expect(dotFeedSeparatorLabel("2026-10-07T13:37:00.000Z", now, { timeZone: "UTC", timeFormat: "24h" })).toBe("Oct 7 13:37");
    // In Bangkok both times fall on October 13.
    expect(dotFeedSeparatorLabel("2026-10-12T22:30:00.000Z", now, { timeZone: "Asia/Bangkok", timeFormat: "24h" })).toBe("Today 05:30");
  });
  it("separates the first item, a new day and a gap of an hour or more", () => {
    const first = item({ createdAt: "2026-10-12T08:00:00.000Z" });
    expect(needsDotFeedSeparator(undefined, first, utc)).toBe(true);
    expect(needsDotFeedSeparator(first, item({ createdAt: "2026-10-12T08:20:00.000Z" }), utc)).toBe(false);
    expect(needsDotFeedSeparator(first, item({ createdAt: "2026-10-12T09:00:00.000Z" }), utc)).toBe(true);
    expect(needsDotFeedSeparator(item({ createdAt: "2026-10-12T23:50:00.000Z" }), item({ createdAt: "2026-10-13T00:10:00.000Z" }), utc)).toBe(true);
  });
});

describe("the feed", () => {
  const props = { dot: { name: "Orbit", character: "astronaut" as const }, status: "ready" as const, hasOlder: false, loadingOlder: false,
    onLoadOlder: vi.fn(), onRetry: vi.fn(), running: null, latestRun: null };
  it("shows bubbles, one-line events, notices with their link and a new-conversation divider", () => {
    render(<DotFeed {...props} items={[
      item({ id: "u1", author: "USER", content: "Plan my week", conversationStart: true }),
      item({ id: "d1", content: "**Here** is your week." }),
      item({ id: "e1", kind: "EVENT", author: "USER", origin: "APPROVAL", summary: "Approved: Create the event “Test”",
        content: "Approved: Create the event “Test”\nDetails: {\"eventId\":\"x\"}", createdAt: "2026-10-12T08:01:00.000Z" }),
      item({ id: "v1", author: "USER", origin: "VOICE", content: "What's next?", createdAt: "2026-10-12T08:02:00.000Z", sessionId: "s:2", conversationStart: true }),
      item({ id: "n1", kind: "NOTICE", origin: "PROACTIVE", content: "New sign-in on Linux. Was it you? Check www.evil-login.example\n\nFrom: no-reply@accounts.example", createdAt: "2026-10-12T08:03:00.000Z", sessionId: null,
        link: { label: "Open email", url: "https://mail.google.com/mail/u/0/#inbox/1" } })
    ]} />);
    const log = screen.getByRole("log", { name: "Conversation with Orbit" });
    expect(within(log).getByText("Plan my week").closest(".dots-bubble.user")).toBeTruthy();
    expect(within(log).getByText("Here").tagName).toBe("STRONG");
    expect(within(log).queryByText(/eventId/)).toBeNull();
    fireEvent.click(within(log).getByRole("button", { name: "Details" }));
    expect(within(log).getByText(/eventId/)).toBeTruthy();
    expect(within(log).getByText("Voice")).toBeTruthy();
    expect(within(log).getAllByRole("separator", { name: "New conversation" })).toHaveLength(1);
    expect(within(log).getByRole("link", { name: "Open email" }).getAttribute("rel")).toBe("noopener noreferrer");
    // Only Space's own link: notice text never turns into links.
    expect(within(screen.getByText(/New sign-in on Linux/).closest("article")!).getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByText("Room Agent")).toBeNull();
  });
  it("shows a photo sent without text by its file name", () => {
    render(<DotFeed {...props} items={[item({ id: "p1", author: "USER", content: "", attachments: [{ name: "receipt.png", mimeType: "image/png" }] })]} />);
    const files = screen.getByRole("list", { name: "Attached files" });
    expect(within(files).getByText("receipt.png")).toBeTruthy();
    expect(files.closest(".dots-bubble.user")?.querySelector("p")).toBeNull();
  });
  it("welcomes an empty conversation, offers earlier messages and shows the running task", () => {
    const { rerender } = render(<DotFeed {...props} items={[]} />);
    expect(screen.getByRole("heading", { name: "Hi, I'm Orbit" })).toBeTruthy();
    const onLoadOlder = vi.fn();
    rerender(<DotFeed {...props} items={[item({})]} hasOlder onLoadOlder={onLoadOlder}
      running={{ status: "RUNNING", elapsedSeconds: 42, progress: "Checking your calendar" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Show earlier messages" }));
    expect(onLoadOlder).toHaveBeenCalled();
    const working = screen.getByRole("status", { name: "Orbit is working" });
    expect(within(working).getByText("0:42")).toBeTruthy();
    expect(within(working).getByText("Checking your calendar")).toBeTruthy();
  });
  it("merges the newest page into what is loaded and replaces it when a gap would remain", () => {
    const page = (items: DotFeedItem[], nextBefore: string | null = null): DotFeedPage =>
      ({ dotId: orbit.dotId, scope: "DOT", items, nextBefore, latestCursor: null, lastActiveAt: null, unread: 0 });
    const a = item({ id: "a", createdAt: "2026-10-12T08:00:00.000Z" });
    const b = item({ id: "b", createdAt: "2026-10-12T08:01:00.000Z", status: "RUNNING" });
    const merged = mergeLatestDotFeed([a, b], page([{ ...b, status: "COMPLETED" }, item({ id: "c", createdAt: "2026-10-12T08:02:00.000Z" })]));
    expect(merged.items.map((value) => `${value.id}:${value.status}`)).toEqual(["a:COMPLETED", "b:COMPLETED", "c:COMPLETED"]);
    expect(merged.replaced).toBe(false);
    const gap = mergeLatestDotFeed([a], page([item({ id: "z", createdAt: "2026-10-12T09:00:00.000Z" })], "cursor"));
    expect(gap).toEqual({ items: [expect.objectContaining({ id: "z" })], replaced: true });
  });
});

describe("the Dot's card", () => {
  it("says when the Dot was active", () => {
    const now = Date.parse("2026-10-12T20:00:00.000Z");
    expect(dotActiveLabel(null, false, now)).toBe("No activity yet");
    expect(dotActiveLabel("2026-10-12T19:00:00.000Z", true, now)).toBe("Active now");
    expect(dotActiveLabel("2026-10-12T19:55:00.000Z", false, now)).toBe("Active 5 minutes ago");
    expect(dotActiveLabel("2026-10-12T19:00:00.000Z", false, now)).toBe("Active 1 hour ago");
    expect(dotActiveLabel("2026-10-09T20:00:00.000Z", false, now)).toBe("Active 3 days ago");
  });
  it("shows Call, Slack only when Space has Slack, the computer, recent actions and outputs", async () => {
    mock.dotComputer.mockResolvedValue({ dotId: orbit.dotId, workspace: { path: "/w", exists: true, entries: [], totalEntries: 0, sortedAll: true },
      runs: [], goals: [], browsers: [], limits: { maxConcurrentTasks: 1, activeTasks: 0 } });
    mock.channels.mockResolvedValue({ providers: [{ provider: "SLACK", configured: true, reason: null }], identities: [], threads: [] });
    mock.dotToolInvocations.mockResolvedValue({ dotId: orbit.dotId, items: [
      { invocationId: "i1", dotId: orbit.dotId, toolId: "calendar.create", risk: "WRITE", status: "COMPLETED", approvalSummary: "Create the event “SpaceApp test”",
        startedAt: "2026-10-12T19:00:00.000Z", completedAt: "2026-10-12T19:00:01.000Z" },
      { invocationId: "i2", dotId: orbit.dotId, toolId: "mail.search", risk: "READ", status: "COMPLETED", approvalSummary: null,
        startedAt: "2026-10-12T19:00:00.000Z", completedAt: "2026-10-12T19:00:01.000Z" }] });
    mock.dotDeliverables.mockResolvedValue({ dotId: orbit.dotId, items: [...["Plan.pdf", "CV.docx", "Letter.docx", "Budget.xlsx"].map((name, i) => ({
      deliverableId: `d${i}`, dotId: orbit.dotId, name, version: 1, artifactId: `artifact:${i}`, byteSize: 2048, publishedBy: "USER",
      createdAt: `2026-10-0${i + 1}T00:00:00.000Z` })),
      { deliverableId: "d9", dotId: orbit.dotId, name: "Budget.xlsx", version: 2, artifactId: "artifact:9", byteSize: 4096, publishedBy: "DOT", createdAt: "2026-10-05T00:00:00.000Z" },
      { deliverableId: "d8", dotId: orbit.dotId, name: "Budget.xlsx", version: 3, artifactId: null, byteSize: 10, publishedBy: "DOT", createdAt: "2026-10-06T00:00:00.000Z" }] });
    const settings = vi.fn(); window.addEventListener(OPEN_DOT_SETTINGS_EVENT, settings);
    const onCall = vi.fn();
    render(<DotInfoCard dot={orbit} roomId="room:1" visible working={false} lastActiveAt={null} sessionId={null} onCall={onCall}
      callDisabledReason={null} onClose={() => {}} overlay={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Call" })); expect(onCall).toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Slack" }));
    expect(settings).toHaveBeenCalledWith(expect.objectContaining({ detail: { dotId: orbit.dotId, section: "channels" } }));
    expect(await screen.findByRole("button", { name: "Your dot's computer, Ready" })).toBeTruthy();
    expect(await screen.findByText("Create the event “SpaceApp test”")).toBeTruthy();
    expect(screen.queryByText("Search email")).toBeNull();
    // The card lists the latest downloadable version of the three newest files.
    expect((await screen.findByText("Budget.xlsx")).closest("a")?.getAttribute("href")).toBe("/api/agent-files/artifact:9/download");
    expect(screen.queryByText("Plan.pdf")).toBeNull();
    // Show more opens every version of every file; it only lists and downloads.
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    const dialog = within(screen.getByRole("dialog", { name: "Orbit's outputs" }));
    expect(dialog.getByRole("link", { name: "Download Plan.pdf version 1" }).getAttribute("href")).toBe("/api/agent-files/artifact:0/download");
    expect(dialog.getByRole("link", { name: "Download Budget.xlsx version 2" }).getAttribute("href")).toBe("/api/agent-files/artifact:9/download");
    expect(dialog.getByRole("link", { name: "Download Budget.xlsx version 1" })).toBeTruthy();
    expect(dialog.queryByRole("link", { name: "Download Budget.xlsx version 3" })).toBeNull();
    expect(dialog.getByText("Version 3 (latest)")).toBeTruthy();
    expect(dialog.getByText("Removed from Agent Files")).toBeTruthy();
    expect(dialog.getAllByText(/requested by Orbit/)).toHaveLength(2);
    expect(mock.dotDeliverables).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog.getByRole("button", { name: "Close outputs" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Orbit's outputs" })).toBeNull();
    window.removeEventListener(OPEN_DOT_SETTINGS_EVENT, settings);
  });
  it("opens the direct conversation with the Space app when Slack is linked, and Slack itself when the app is unknown", async () => {
    mock.dotComputer.mockRejectedValue(Error("down"));
    mock.dotToolInvocations.mockResolvedValue({ dotId: orbit.dotId, items: [] });
    mock.dotDeliverables.mockResolvedValue({ dotId: orbit.dotId, items: [] });
    const identities = [{ identityId: `channel_identity:${"1".repeat(32)}`, provider: "SLACK", tenantId: "T0123ABCD", displayName: null, linkedAt: "2026-10-13T00:00:00.000Z" }];
    mock.channels.mockResolvedValue({ providers: [{ provider: "SLACK", configured: true, reason: null, appUrl: "https://slack.com/app_redirect?app=A0123ABCDE" }],
      identities, threads: [] });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const settings = vi.fn(); window.addEventListener(OPEN_DOT_SETTINGS_EVENT, settings);
    const { unmount } = render(<DotInfoCard dot={orbit} roomId="room:1" visible working={false} lastActiveAt={null} sessionId={null} onCall={() => {}}
      callDisabledReason={null} onClose={() => {}} overlay={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Slack" }).getAttribute("title")).toBe("Open Slack"));
    fireEvent.click(screen.getByRole("button", { name: "Slack" }));
    expect(open).toHaveBeenLastCalledWith("https://slack.com/app_redirect?app=A0123ABCDE&team=T0123ABCD", "_blank", "noopener,noreferrer");
    unmount();
    mock.channels.mockResolvedValue({ providers: [{ provider: "SLACK", configured: true, reason: null, appUrl: null }], identities, threads: [] });
    render(<DotInfoCard dot={orbit} roomId="room:1" visible working={false} lastActiveAt={null} sessionId={null} onCall={() => {}}
      callDisabledReason={null} onClose={() => {}} overlay={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Slack" }).getAttribute("title")).toBe("Open Slack"));
    fireEvent.click(screen.getByRole("button", { name: "Slack" }));
    expect(open).toHaveBeenLastCalledWith("https://app.slack.com/client", "_blank", "noopener,noreferrer");
    expect(settings).not.toHaveBeenCalled();
    expect(slackDirectUrl("https://evil.example/?x", "T0123ABCD")).toBe("https://app.slack.com/client");
    expect(slackDirectUrl("https://slack.com/app_redirect?app=A0123ABCDE", "bad team")).toBe("https://slack.com/app_redirect?app=A0123ABCDE");
    window.removeEventListener(OPEN_DOT_SETTINGS_EVENT, settings);
    open.mockRestore();
  });
  it("shows the Dot's running browser as its computer's picture, and the mascot otherwise", async () => {
    const browserRow = { roomId: "room:2", roomName: "Research", paneId: "pane:browser", active: true, currentUrl: "https://example.com/", title: "Example",
      sessionId: "browser_session:1", ready: true };
    const computer = (browsers: unknown[]) => ({ dotId: orbit.dotId, workspace: { path: "/w", exists: true, entries: [], totalEntries: 0, sortedAll: true },
      runs: [], goals: [], browsers, limits: { maxConcurrentTasks: 1, activeTasks: 0 } });
    mock.channels.mockResolvedValue({ providers: [], identities: [], threads: [] });
    mock.dotToolInvocations.mockResolvedValue({ dotId: orbit.dotId, items: [] });
    mock.dotDeliverables.mockResolvedValue({ dotId: orbit.dotId, items: [] });
    mock.browserFrame.mockResolvedValue({ screenshotDataUrl: "data:image/png;base64,AAAA" });
    const card = (roomId: string, roomScoped = false) => render(<DotInfoCard dot={orbit} roomId={roomId} visible working={false} lastActiveAt={null} sessionId={null}
      onCall={() => {}} callDisabledReason={null} onClose={() => {}} overlay={false} roomScoped={roomScoped} />);
    const thumb = (container: HTMLElement) => container.querySelector<HTMLImageElement>(".dots-info-computer-thumb")!;
    mock.dotComputer.mockResolvedValue(computer([{ ...browserRow, paneId: "pane:stopped", sessionId: null, ready: false, active: false }, browserRow]));
    const first = card("room:1");
    await waitFor(() => expect(thumb(first.container).getAttribute("data-source")).toBe("browser"));
    expect(thumb(first.container).getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(mock.browserFrame).toHaveBeenCalledWith("pane:browser", "browser_session:1");
    first.unmount();
    // A browser that is not running is never woken for a picture, and an Agent Proof room never shows another room's browser.
    mock.browserFrame.mockClear();
    for (const [browsers, roomScoped] of [[[{ ...browserRow, ready: false }], false], [[browserRow], true]] as const) {
      mock.dotComputer.mockResolvedValue(computer([...browsers]));
      const view = card("room:1", roomScoped);
      expect(await screen.findByRole("button", { name: "Your dot's computer, Ready" })).toBeTruthy();
      expect(thumb(view.container).getAttribute("data-source")).toBe("mascot");
      view.unmount();
    }
    expect(mock.browserFrame).not.toHaveBeenCalled();
    // A picture that cannot be read leaves the mascot.
    mock.dotComputer.mockResolvedValue(computer([browserRow]));
    mock.browserFrame.mockRejectedValue(Error("gone"));
    const failed = card("room:2", true);
    await waitFor(() => expect(mock.browserFrame).toHaveBeenCalled());
    expect(thumb(failed.container).getAttribute("data-source")).toBe("mascot");
  });
  it("hides Slack when Space has no Slack app", async () => {
    mock.dotComputer.mockRejectedValue(Error("down"));
    mock.channels.mockResolvedValue({ providers: [{ provider: "SLACK", configured: false, reason: "Not configured" }], identities: [], threads: [] });
    mock.dotToolInvocations.mockResolvedValue({ dotId: orbit.dotId, items: [] });
    mock.dotDeliverables.mockResolvedValue({ dotId: orbit.dotId, items: [] });
    render(<DotInfoCard dot={orbit} roomId="room:1" visible working lastActiveAt={null} sessionId={null} onCall={() => {}}
      callDisabledReason={null} onClose={() => {}} overlay={false} />);
    expect(await screen.findByText("No outputs yet")).toBeTruthy();
    expect(screen.getByText("Active now")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Your dot's computer, Unavailable" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Slack" })).toBeNull();
  });
});

describe("the Dot pane", () => {
  const pane = { id: "pane:feed", roomId: "room:feed", title: "Feed", mode: "CHAT", isMinimized: false } as Pane;
  function session(messages: AgentPaneSession["messages"] = []): AgentPaneSession {
    return agentPaneSessionSchema.parse({ dotId: orbit.dotId, runtimeState: "AVAILABLE", binding: { paneId: pane.id, source: "SPACE", sessionId: "agent_session:feed",
      coderChatId: null, status: "READY", title: pane.title, selectedModelConfigId: "gpt:high", selectedProviderName: "Codex", selectedModelName: "gpt",
      selectedReasoningKey: "high", selectedToolIds: [], lastSyncedAt: "2026-10-12T00:00:00.000Z" }, threadId: null, messages, runStatus: "IDLE",
      statusReason: "Ready", modelOptions: [{ id: "gpt:high", displayName: "gpt", providerId: null, providerName: "Codex", model: "gpt", reasoningKey: "high",
        reasoningLabel: "High", isDefault: true }], selectedModelConfigId: "gpt:high",
      capabilities: { canSend: true, canInterrupt: false, canSelectModel: true, canSelectTools: false, supportsTools: true } });
  }
  it("shows the Dot's feed from every room, the current conversation at once, and marks what is seen as read", async () => {
    mock.dots.mockResolvedValue({ dots });
    mock.agentSession.mockResolvedValue(session([{ id: "m:live", role: "user", content: "Typed just now", status: "COMPLETED", createdAt: "2026-10-12T09:00:00.000Z" }]));
    // The latest cursor can lie past the last shown item (a hidden tool row): reading up to it clears the unread count.
    mock.dotFeed.mockResolvedValue({ dotId: orbit.dotId, nextBefore: null, latestCursor: "2026-10-12T08:02:00.000Z|tool", lastActiveAt: "2026-10-12T08:01:00.000Z", unread: 1,
      items: [item({ id: "r2", author: "USER", content: "Asked in another room", roomId: "room:other" }),
        item({ id: "n1", kind: "NOTICE", origin: "PROACTIVE", content: "Security notice", createdAt: "2026-10-12T08:01:00.000Z", sessionId: null })] });
    mock.markDotFeedRead.mockResolvedValue({ unread: 0 });
    render(<AgentPane pane={pane} codexEnvironment={null} workspaceTextSize={14} />);
    const log = await screen.findByRole("log", { name: "Conversation with Orbit" });
    expect(await within(log).findByText("Asked in another room")).toBeTruthy();
    expect(within(log).getByText("Security notice")).toBeTruthy();
    expect(within(log).getByText("Typed just now")).toBeTruthy();
    await waitFor(() => expect(mock.markDotFeedRead).toHaveBeenCalledWith(orbit.dotId, "2026-10-12T08:02:00.000Z|tool", pane.roomId));
    // The pane's room goes along: an Agent Proof room sees only its own conversation.
    expect(mock.dotFeed).toHaveBeenCalledWith(orbit.dotId, { limit: 40, roomId: pane.roomId });
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Dot session history" })).toBeNull();
  });
  it("reads no feed while the pane is minimized and opens Settings → Dots from the menu", async () => {
    mock.dots.mockResolvedValue({ dots });
    mock.agentSession.mockResolvedValue(session());
    mock.dotFeed.mockResolvedValue({ dotId: orbit.dotId, items: [], nextBefore: null, latestCursor: null, lastActiveAt: null, unread: 0 });
    const view = render(<AgentPane pane={{ ...pane, isMinimized: true }} codexEnvironment={null} workspaceTextSize={14} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose Dot (Orbit)" })).toBeTruthy());
    await act(async () => {});
    expect(mock.dotFeed).not.toHaveBeenCalled();
    view.rerender(<AgentPane pane={pane} codexEnvironment={null} workspaceTextSize={14} />);
    await waitFor(() => expect(mock.dotFeed).toHaveBeenCalled());
    const settings = vi.fn(); window.addEventListener(OPEN_DOT_SETTINGS_EVENT, settings);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Dot settings" }));
    expect(settings).toHaveBeenCalledWith(expect.objectContaining({ detail: { dotId: orbit.dotId } }));
    window.removeEventListener(OPEN_DOT_SETTINGS_EVENT, settings);
  });
});
