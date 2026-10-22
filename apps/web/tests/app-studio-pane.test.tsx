import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, AppStudioEvent, AppStudioPaneMetadata, AppStudioPreview, Pane } from "@space/contracts";
import { defaultAppStudioPaneMetadata } from "@space/contracts";
import { AppStudioPane, resolveActiveTab, tabsForLayout } from "../src/features/app-studio-pane/AppStudioPane.js";
import { APP_STUDIO_KIND, copilotKindForMode } from "../src/features/copilot-kit/copilot-kind.js";

const apiMock = vi.hoisted(() => ({
  appStudioState: vi.fn(),
  updateAppStudioSettings: vi.fn(),
  createAppStudioBrief: vi.fn(),
  answerAppStudioQuestion: vi.fn(),
  userSettings: vi.fn(),
  updateUserSettings: vi.fn(),
  cliRuntimes: vi.fn(),
  cliRuntimesSnapshot: vi.fn(),
  listCliAccountProfiles: vi.fn(),
  activeCliSession: vi.fn()
}));
vi.mock("../src/api.js", () => ({ api: apiMock }));
vi.mock("../src/runtime/SpaceRuntime.js", () => ({ getSpaceRuntime: () => ({ platform: { localStorage: window.localStorage } }) }));

function runtime(id: string, displayName: string): AgentRuntime {
  return {
    id, providerId: id.slice(4), providerName: displayName, agentId: id.slice(4), agentName: displayName, displayName, capabilities: ["CLI"],
    adapterStatus: "ENABLED", authMode: "BROWSER_OAUTH", authState: "READY", authReason: "ok", canStartLogin: false,
    status: "ENABLED", statusReason: "Ready", commandName: null, detectedCommandPath: null, defaultModelId: null,
    supportedReasoningEfforts: [], checkedAt: "2026-10-19T08:00:00.000Z"
  } as AgentRuntime;
}
const registry = { data: [runtime("cli:claude", "Claude Code CLI"), runtime("cli:codex", "Codex CLI")], checkedAt: "2026-10-19T08:00:00.000Z" };
const at = "2026-10-19T08:00:00.000Z";
const pane: Pane = {
  id: "pane:apps000001", roomId: "room:apps000001", title: "App Studio 1", titleSource: "auto", mode: "APP_STUDIO", status: "IDLE",
  providerId: null, modelId: null, reasoningEffort: "medium", cwd: null, order: 0, columnSpan: 1, isMaximized: false, isMinimized: false,
  isClosed: false, split: { parentId: null, direction: null, size: null }, categoryColor: null, vncTarget: null, terminalRuntimeId: "cli:claude",
  createdAt: at, updatedAt: at
} as Pane;
const preview = (deviceId: string, route: string, artifactId: string): AppStudioPreview => ({ paneId: pane.id, deviceId, route, artifactId, capturedAt: at });
const event = (id: string, type: AppStudioEvent["type"], status: AppStudioEvent["status"], message: string, payload: Record<string, unknown> = {}): AppStudioEvent =>
  ({ id, ownerUserId: "user:operator", paneId: pane.id, type, status, message, payload, createdAt: at, updatedAt: at });

describe("AppStudioPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    apiMock.appStudioState.mockResolvedValue({
      metadata: defaultAppStudioPaneMetadata(), run: { status: "IDLE", paused: false, openQuestions: 1, pendingBriefs: 1 },
      previews: [preview("android-412x915", "/", "artifact:shot0001"), preview("iphone-402x874", "/", "artifact:shot0002"), preview("iphone-402x874", "/settings", "artifact:shot0003")],
      events: [event("asevt:question1", "QUESTION", "OPEN", "Light or dark theme?", { options: ["Light", "Dark"] }), event("asevt:brief0001", "BRIEF", "TAKEN", "Build a habit tracker")]
    });
    apiMock.updateAppStudioSettings.mockImplementation(async (_paneId: string, next: AppStudioPaneMetadata) => ({ metadata: next }));
    apiMock.createAppStudioBrief.mockResolvedValue({ brief: event("asevt:brief0002", "BRIEF", "PENDING", "Add a settings screen"), kickoffSent: true });
    apiMock.answerAppStudioQuestion.mockResolvedValue({ question: event("asevt:question1", "QUESTION", "ANSWERED", "Light or dark theme?") });
    apiMock.userSettings.mockResolvedValue({ appStudio: null });
    apiMock.cliRuntimes.mockResolvedValue(registry);
    apiMock.cliRuntimesSnapshot.mockReturnValue(registry);
    apiMock.listCliAccountProfiles.mockResolvedValue({ runtimeId: "cli:claude", profiles: [{ profileId: "main", displayName: "Main" }], gatewayProfile: null, defaultProfileId: "main" });
    apiMock.activeCliSession.mockResolvedValue({ session: { runtimeId: "cli:claude", accountProfileId: "main" } });
  });
  afterEach(() => cleanup());

  it("is a copilot kind on Claude Code, with the preview as the main surface and a tab only when stacked", () => {
    expect(copilotKindForMode("APP_STUDIO")).toBe(APP_STUDIO_KIND);
    expect(APP_STUDIO_KIND).toMatchObject({ label: "App Studio", preferredRuntimeId: "cli:claude", settingsKey: "appStudio" });
    expect(tabsForLayout("split")).toEqual(["activity", "setup", "terminal"]);
    expect(tabsForLayout("stacked")).toEqual(["preview", "activity", "setup", "terminal"]);
    expect(resolveActiveTab("preview", "split")).toBe("activity");
  });

  it("shows each phone's latest capture of a screen in its frame, filtered by platform", async () => {
    render(<AppStudioPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    const previews = await screen.findByLabelText("Device previews");
    const images = within(previews).getAllByRole("img") as HTMLImageElement[];
    expect(images.map((image) => image.getAttribute("src"))).toEqual(["/api/artifacts/artifact%3Ashot0001/file", "/api/artifacts/artifact%3Ashot0002/file"]);
    expect(previews.querySelector('[data-cutout="island"]')).not.toBeNull();
    expect(previews.querySelector('[data-cutout="punch_hole"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "iPhone" }));
    expect(within(screen.getByLabelText("Device previews")).getAllByRole("img")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Screen"), { target: { value: "/settings" } });
    expect((within(screen.getByLabelText("Device previews")).getByRole("img") as HTMLImageElement).alt).toBe("iPhone 17 / 16 Pro preview of /settings");
    expect(screen.getByText("1 brief")).toBeTruthy();
    expect(screen.getByText("1 needs you")).toBeTruthy();
  });

  it("sends a brief and answers the app builder's question from Activity", async () => {
    render(<AppStudioPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    await screen.findByRole("button", { name: "Dark" });
    fireEvent.change(screen.getByLabelText("Ask App Studio to build or change something"), { target: { value: "Add a settings screen" } });
    fireEvent.click(screen.getByRole("button", { name: "Send brief" }));
    await waitFor(() => expect(apiMock.createAppStudioBrief).toHaveBeenCalledWith(pane.id, "Add a settings screen"));
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    await waitFor(() => expect(apiMock.answerAppStudioQuestion).toHaveBeenCalledWith(pane.id, "asevt:question1", "Dark"));
  });

  it("chooses the preview devices with switches and keeps at least one", async () => {
    render(<AppStudioPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Setup" }));
    fireEvent.click(await screen.findByRole("switch", { name: /Galaxy A series/ }));
    await waitFor(() => expect(apiMock.updateAppStudioSettings).toHaveBeenLastCalledWith(pane.id, expect.objectContaining({
      settings: expect.objectContaining({ devices: ["android-360x800", "android-412x915", "iphone-402x874"] }) })));
    // Only the shared pill switches, never a plain checkbox.
    expect(document.querySelector('input[type="checkbox"]:not([role="switch"])')).toBeNull();
  });
});
