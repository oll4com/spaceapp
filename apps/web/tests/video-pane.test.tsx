import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, Pane, VideoAsset, VideoPaneMetadata, VideoRequest } from "@space/contracts";
import { defaultVideoPaneMetadata } from "@space/contracts";
import { VideoPane, resolveActiveTab, tabsForLayout } from "../src/features/video-pane/VideoPane.js";
import { VIDEO_KIND, copilotKindForMode } from "../src/features/copilot-kit/copilot-kind.js";

const apiMock = vi.hoisted(() => ({
  artifactFileUrl: (id: string) => `/api/artifacts/${encodeURIComponent(id)}/file`,
  artifactMetadata: vi.fn(),
  artifacts: vi.fn(),
  videoSettings: vi.fn(),
  updateVideoSettings: vi.fn(),
  videoRequests: vi.fn(),
  videoAssets: vi.fn(),
  videoEvents: vi.fn(),
  videoTools: vi.fn(),
  uploadVideoSource: vi.fn(),
  createVideoRequest: vi.fn(),
  approveVideoRequest: vi.fn(),
  cancelVideoRequest: vi.fn(),
  answerVideoRequest: vi.fn(),
  deleteVideoAsset: vi.fn(),
  deleteVideoFile: vi.fn(),
  saveVideoToAgentFiles: vi.fn(),
  videoMusicSearch: vi.fn(),
  videoMusicFetch: vi.fn(),
  uploadVideoMusic: vi.fn(),
  uploadAgentFiles: vi.fn(),
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
    supportedReasoningEfforts: [], checkedAt: "2026-10-21T08:00:00.000Z"
  } as AgentRuntime;
}
const registry = { data: [runtime("cli:claude", "Claude Code CLI"), runtime("cli:codex", "Codex CLI")], checkedAt: "2026-10-21T08:00:00.000Z" };
const at = "2026-10-21T08:00:00.000Z";
const pane: Pane = {
  id: "pane:video000001", roomId: "room:video000001", title: "Video 1", titleSource: "auto", mode: "VIDEO", status: "IDLE",
  providerId: null, modelId: null, reasoningEffort: "medium", cwd: null, order: 0, columnSpan: 1, isMaximized: false, isMinimized: false,
  isClosed: false, split: { parentId: null, direction: null, size: null }, categoryColor: null, vncTarget: null, terminalRuntimeId: "cli:claude",
  createdAt: at, updatedAt: at
} as Pane;
const asset = (id: string, kind: VideoAsset["kind"], extra: Partial<VideoAsset> = {}): VideoAsset => ({
  id, ownerUserId: "user:operator", paneId: pane.id, requestId: null, artifactId: `artifact:${id.slice(7)}`, thumbnailArtifactId: null, formatId: null, width: 1920, height: 1080, durationSec: 83.4,
  mimeType: "video/mp4", kind, label: null, description: null, madeBy: { by: "OPERATOR", runtimeId: null, model: null }, credits: null, timeline: null, parentAssetId: null, pinned: true, createdAt: at, updatedAt: at, ...extra
});
const request = (id: string, status: VideoRequest["status"], extra: Partial<VideoRequest> = {}): VideoRequest => ({
  id, ownerUserId: "user:operator", videoPaneId: pane.id, requester: { kind: "PANE", paneId: "pane:codex00001", label: "Andy (Codex CLI)" }, brief: "A 30-second highlight for Shorts",
  sources: [{ artifactId: "artifact:demo0001" }], formatIds: ["youtube-short"], options: {}, callback: null, status, resultAssetIds: [], question: null, answer: null, message: null,
  takenAt: at, deliveredAt: null, createdAt: at, updatedAt: at, ...extra
});
const source = asset("vasset:demo0001", "UPLOAD", { label: "demo.mp4", thumbnailArtifactId: "artifact:poster001" });
const output = asset("vasset:short0001", "OUTPUT", { requestId: "vreq:request01", formatId: "youtube-short", width: 1080, height: 1920, durationSec: 29, thumbnailArtifactId: "artifact:poster002",
  description: "The demo's three highlights with karaoke captions", credits: "Music: Sunrise by Alex (CC BY 4.0)", label: "YouTube Short" });
const music = asset("vasset:music0001", "MUSIC", { mimeType: "audio/mpeg", label: "Sunrise", credits: "Sunrise by Alex (CC BY 4.0)", width: null, height: null, durationSec: 180 });
const approval = request("vreq:request01", "NEEDS_APPROVAL", { resultAssetIds: [output.id], question: "Logo at the end?", answer: null });

describe("VideoPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    apiMock.videoSettings.mockResolvedValue({ metadata: defaultVideoPaneMetadata() });
    apiMock.updateVideoSettings.mockImplementation(async (_paneId: string, next: VideoPaneMetadata) => ({ metadata: next }));
    apiMock.videoRequests.mockResolvedValue({ requests: [approval] });
    apiMock.videoAssets.mockResolvedValue({ assets: [source, output, music] });
    apiMock.videoEvents.mockResolvedValue({ events: [] });
    apiMock.videoTools.mockResolvedValue({ tools: { ok: false, missing: ["ffmpeg", "whisper"] } });
    apiMock.artifacts.mockResolvedValue({ data: [{ id: "artifact:room0001", roomId: pane.roomId, kind: "VIDEO", mimeType: "video/mp4", metadata: { originalFilename: "room-take.mp4" }, byteSize: 10, createdAt: at }], pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 } });
    apiMock.createVideoRequest.mockResolvedValue({ request: request("vreq:request02", "QUEUED", { requester: { kind: "OPERATOR", roomId: pane.roomId, label: "You" } }), assets: [], videoPaneId: pane.id, runStarted: true });
    apiMock.approveVideoRequest.mockResolvedValue({ request: { ...approval, status: "DELIVERED" }, assets: [] });
    apiMock.cancelVideoRequest.mockResolvedValue({ request: { ...approval, status: "CANCELLED" }, assets: [] });
    apiMock.answerVideoRequest.mockResolvedValue({ request: { ...approval, answer: "Yes" }, assets: [] });
    apiMock.deleteVideoAsset.mockResolvedValue({ deleted: true });
    apiMock.deleteVideoFile.mockResolvedValue({ deleted: true, removedAssets: 1, keptInAgentFiles: false });
    apiMock.saveVideoToAgentFiles.mockResolvedValue({ artifact: { id: "artifact:filed0001" }, folder: "MEDIA/Video", alreadyThere: false });
    apiMock.videoMusicSearch.mockResolvedValue({ results: [{ title: "Sunrise", artist: "Alex", url: "https://ccmixter.org/content/alex/sunrise.mp3", license: "CC BY 4.0", attribution: "Sunrise by Alex (CC BY 4.0)" }] });
    apiMock.videoMusicFetch.mockResolvedValue({ asset: music });
    apiMock.userSettings.mockResolvedValue({ video: null });
    apiMock.cliRuntimes.mockResolvedValue(registry);
    apiMock.cliRuntimesSnapshot.mockReturnValue(registry);
    apiMock.listCliAccountProfiles.mockResolvedValue({ runtimeId: "cli:claude", profiles: [{ profileId: "main", displayName: "Main" }], gatewayProfile: null, defaultProfileId: "main" });
    apiMock.activeCliSession.mockResolvedValue({ session: { runtimeId: "cli:claude", accountProfileId: "main" } });
  });
  afterEach(() => cleanup());

  it("is a copilot kind that opens with Claude Code, with the Studio as a tab only when stacked", () => {
    expect(copilotKindForMode("VIDEO")).toBe(VIDEO_KIND);
    expect(VIDEO_KIND).toMatchObject({ preferredRuntimeId: "cli:claude", settingsKey: "video", label: "Video", mode: "VIDEO" });
    expect(tabsForLayout("split")).toEqual(["requests", "library", "music", "setup", "terminal"]);
    expect(tabsForLayout("stacked")[0]).toBe("studio");
    expect(resolveActiveTab("studio", "split")).toBe("requests");
  });

  it("makes a request from the Studio with the picked sources, formats and options", async () => {
    render(<VideoPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    const studio = await screen.findByRole("region", { name: "Studio" });
    // Sources: the library's uploads and the room's Media videos, each once; outputs are not sources.
    const shelf = await within(studio).findByLabelText("Source files");
    expect(within(shelf).getAllByTitle(/^Preview /).map((button) => button.title)).toEqual(["Preview demo.mp4", "Preview room-take.mp4"]);
    // A click previews; + picks it for the cut (the order is the sources' order).
    fireEvent.click(within(shelf).getByTitle("Preview demo.mp4"));
    expect((within(studio).getByLabelText("Player").querySelector("video") as HTMLVideoElement).getAttribute("poster")).toBe("/api/artifacts/artifact%3Aposter001/file");
    fireEvent.click(within(shelf).getByRole("checkbox", { name: "Use demo.mp4 in the video" }));
    expect(within(studio).getByRole("button", { name: "Source 1" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(within(studio).getByPlaceholderText(/highlight of the demo/), { target: { value: "Three highlights, upbeat" } });
    fireEvent.click(within(studio).getByRole("radio", { name: "Scene cuts" }));
    fireEvent.click(within(studio).getByRole("checkbox", { name: "X post" }));
    expect(within(studio).getByRole("combobox", { name: "Captions" }).querySelector('option[value="bold-center"]')?.textContent).toBe("Bold center");
    fireEvent.change(within(studio).getByRole("combobox", { name: "Captions" }), { target: { value: "bold-center" } });
    fireEvent.click(within(studio).getByRole("switch", { name: "Narration" }));
    fireEvent.change(within(studio).getByRole("combobox", { name: "Narration language" }), { target: { value: "el" } });
    fireEvent.change(within(studio).getByRole("combobox", { name: "Music" }), { target: { value: music.artifactId } });
    fireEvent.click(within(studio).getByRole("button", { name: "Make" }));
    await waitFor(() => expect(apiMock.createVideoRequest).toHaveBeenCalledWith(pane.id, {
      brief: "Three highlights, upbeat", sources: [{ artifactId: source.artifactId }], formatIds: ["youtube-short", "x"],
      // Greek is Chatterbox-only, so the request names that engine instead of the pane's Kokoro.
      options: { technique: "scene", transition: "auto", filter: "none", captions: "bold-center", narration: { language: "el", voice: "af_heart", engine: "chatterbox" }, music: { artifactId: music.artifactId } }
    }));
    expect(await within(studio).findByText("Queued: the editor is working on it.")).toBeTruthy();
  });

  it("plays the newest output with its details; Download, Save to Agent Files, Delete after a confirm, and Approve", async () => {
    render(<VideoPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    const studio = await screen.findByRole("region", { name: "Studio" });
    expect(within(await within(studio).findByLabelText("Output files")).getAllByTitle(/^Preview /).map((button) => button.title)).toEqual(["Preview YouTube Short"]);
    const video = within(studio).getByLabelText("Player").querySelector("video") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe("/api/artifacts/artifact%3Ashort0001/file");
    expect(video.getAttribute("poster")).toBe("/api/artifacts/artifact%3Aposter002/file");
    expect(within(studio).getByText("The demo's three highlights with karaoke captions")).toBeTruthy();
    expect(within(studio).getByText("Credits: Music: Sunrise by Alex (CC BY 4.0)")).toBeTruthy();
    const bar = within(within(studio).getByRole("toolbar", { name: "This video" }));
    expect(bar.getByText("1080×1920 · 0:29")).toBeTruthy();
    expect(bar.getByRole("link", { name: "Download" }).getAttribute("download")).toBe("video-youtube-short.mp4");
    expect(within(studio).getByLabelText("Request status").textContent).toContain("Needs your approval");
    fireEvent.click(bar.getByRole("button", { name: "Save to Agent Files" }));
    await waitFor(() => expect(apiMock.saveVideoToAgentFiles).toHaveBeenCalledWith(pane.id, output.artifactId));
    expect(await within(studio).findByText("Saved to Agent Files › Media / Video.")).toBeTruthy();
    // Delete asks first; Keep it leaves the file alone.
    fireEvent.click(bar.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(within(studio).getByRole("alertdialog", { name: "Delete this file?" })).getByRole("button", { name: "Keep it" }));
    expect(apiMock.deleteVideoFile).not.toHaveBeenCalled();
    fireEvent.click(bar.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(within(studio).getByRole("alertdialog", { name: "Delete this file?" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(apiMock.deleteVideoFile).toHaveBeenCalledWith(pane.id, output.artifactId));
    expect(await within(studio).findByText("Deleted “YouTube Short”.")).toBeTruthy();
    fireEvent.click(within(studio).getByRole("button", { name: "Approve and deliver" }));
    await waitFor(() => expect(apiMock.approveVideoRequest).toHaveBeenCalledWith(pane.id, approval.id));
  });

  it("deletes a library file for good after a confirm and saves one to Agent Files", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<VideoPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Library" }));
    const files = await screen.findByLabelText("Library files");
    const music = within(files).getByText("Sunrise").closest("li") as HTMLElement;
    fireEvent.click(within(music).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(apiMock.deleteVideoFile).toHaveBeenCalledWith(pane.id, "artifact:music0001"));
    expect(confirm).toHaveBeenCalledWith("Delete “Sunrise” for good?");
    fireEvent.click(within(music).getByRole("button", { name: "Save to Agent Files" }));
    await waitFor(() => expect(apiMock.saveVideoToAgentFiles).toHaveBeenCalledWith(pane.id, "artifact:music0001"));
    confirm.mockRestore();
  });

  it("answers, approves and cancels requests from the Requests tab", async () => {
    render(<VideoPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    const requests = within(await screen.findByLabelText("Video requests"));
    expect(screen.getByText("1 needs you")).toBeTruthy();
    fireEvent.change(requests.getByLabelText("The editor asks: Logo at the end?"), { target: { value: "Yes" } });
    fireEvent.click(requests.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(apiMock.answerVideoRequest).toHaveBeenCalledWith(pane.id, approval.id, "Yes"));
    fireEvent.click(requests.getByRole("button", { name: "Approve and deliver" }));
    await waitFor(() => expect(apiMock.approveVideoRequest).toHaveBeenCalledWith(pane.id, approval.id));
    fireEvent.click(requests.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(apiMock.cancelVideoRequest).toHaveBeenCalledWith(pane.id, approval.id));
  });

  it("finds CC BY music and adds a track to the library with its attribution", async () => {
    render(<VideoPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Music" }));
    const tracks = await screen.findByLabelText("Music tracks");
    expect(within(tracks).getByText("Credits: Sunrise by Alex (CC BY 4.0)")).toBeTruthy();
    expect(tracks.querySelector("audio")?.getAttribute("src")).toBe("/api/artifacts/artifact%3Amusic0001/file");
    fireEvent.change(screen.getByLabelText("Music search"), { target: { value: "upbeat" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(apiMock.videoMusicSearch).toHaveBeenCalledWith(pane.id, { query: "upbeat", limit: 20 }));
    const results = await screen.findByLabelText("Music search results");
    expect(within(results).getByText("Alex · CC BY 4.0")).toBeTruthy();
    fireEvent.click(within(results).getByRole("button", { name: "Add to library" }));
    await waitFor(() => expect(apiMock.videoMusicFetch).toHaveBeenCalledWith(pane.id, { url: "https://ccmixter.org/content/alex/sunrise.mp3", title: "Sunrise", artist: "Alex", attribution: "Sunrise by Alex (CC BY 4.0)" }));
    expect(await screen.findByText("Added “Sunrise” to the library with its credits.")).toBeTruthy();
  });

  it("saves the defaults from Setup and shows the tools' install command while they are missing", async () => {
    render(<VideoPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Setup" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Technique" }), { target: { value: "silence" } });
    await waitFor(() => expect(apiMock.updateVideoSettings).toHaveBeenLastCalledWith(pane.id, expect.objectContaining({ settings: expect.objectContaining({ technique: "silence" }) })));
    fireEvent.click(within(screen.getByRole("group", { name: "Default formats" })).getByRole("checkbox", { name: "X post" }));
    await waitFor(() => expect(apiMock.updateVideoSettings).toHaveBeenLastCalledWith(pane.id, expect.objectContaining({ settings: expect.objectContaining({ defaultFormatIds: ["youtube-short", "x"] }) })));
    // Chatterbox speaks Greek; switching back to Kokoro, which does not, falls back to English.
    fireEvent.change(screen.getByRole("combobox", { name: "Narration engine" }), { target: { value: "chatterbox" } });
    fireEvent.change(await screen.findByRole("combobox", { name: "Narration language" }), { target: { value: "el" } });
    await waitFor(() => expect(apiMock.updateVideoSettings).toHaveBeenLastCalledWith(pane.id, expect.objectContaining({ settings: expect.objectContaining({ narration: expect.objectContaining({ engine: "chatterbox", language: "el" }) }) })));
    fireEvent.change(screen.getByRole("combobox", { name: "Narration engine" }), { target: { value: "kokoro" } });
    await waitFor(() => expect(apiMock.updateVideoSettings).toHaveBeenLastCalledWith(pane.id, expect.objectContaining({ settings: expect.objectContaining({ narration: expect.objectContaining({ engine: "kokoro", language: "en" }) }) })));
    fireEvent.click(screen.getByRole("button", { name: /Tools/ }));
    expect(await screen.findByText("Missing: ffmpeg, whisper.")).toBeTruthy();
    expect(screen.getByText("node /opt/spaceapp/scripts/space-video-tools-setup.mjs --install")).toBeTruthy();
    expect(document.querySelector('input[type="checkbox"]:not([role="switch"])')).toBeNull();
  });
});
