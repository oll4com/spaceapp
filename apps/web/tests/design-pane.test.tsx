import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, DesignAsset, DesignPaneMetadata, DesignRequest, Pane } from "@space/contracts";
import { defaultDesignPaneMetadata, SPACEAPP_BRAND_KIT } from "@space/contracts";
import { DesignPane, resolveActiveTab, tabsForLayout } from "../src/features/design-pane/DesignPane.js";
import { DESIGN_KIND, copilotKindForMode } from "../src/features/copilot-kit/copilot-kind.js";

const apiMock = vi.hoisted(() => ({
  artifactFileUrl: (id: string) => `/api/artifacts/${encodeURIComponent(id)}/file`,
  agentFileDownloadUrl: (id: string) => `/api/artifacts/${encodeURIComponent(id)}/download`,
  designSettings: vi.fn(),
  updateDesignSettings: vi.fn(),
  designRequests: vi.fn(),
  designAssets: vi.fn(),
  designBrandKits: vi.fn(),
  designEvents: vi.fn(),
  designRender: vi.fn(),
  designGenerate: vi.fn(),
  designVariants: vi.fn(),
  deliverDesignRequest: vi.fn(),
  createDesignRequest: vi.fn(),
  cancelDesignRequest: vi.fn(),
  answerDesignRequest: vi.fn(),
  deleteDesignAsset: vi.fn(),
  createDesignBrandKit: vi.fn(),
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
    supportedReasoningEfforts: [], checkedAt: "2026-10-18T08:00:00.000Z"
  } as AgentRuntime;
}
const registry = { data: [runtime("cli:claude", "Claude Code CLI"), runtime("cli:codex", "Codex CLI")], checkedAt: "2026-10-18T08:00:00.000Z" };
const at = "2026-10-18T08:00:00.000Z";
const pane: Pane = {
  id: "pane:design00001", roomId: "room:design00001", title: "Design 1", titleSource: "auto", mode: "DESIGN", status: "IDLE",
  providerId: null, modelId: null, reasoningEffort: "medium", cwd: null, order: 0, columnSpan: 1, isMaximized: false, isMinimized: false,
  isClosed: false, split: { parentId: null, direction: null, size: null }, categoryColor: null, vncTarget: null, terminalRuntimeId: "cli:claude",
  createdAt: at, updatedAt: at
} as Pane;
const asset = (id: string, formatId: string, width: number, height: number, extra: Partial<DesignAsset> = {}): DesignAsset => ({
  id, ownerUserId: "user:operator", paneId: pane.id, requestId: null, artifactId: `artifact:${id.slice(7)}`, formatId, width, height, mimeType: "image/png", engine: "TEMPLATE",
  model: null, label: null, prompt: null, templateId: "gradient-headline", params: { values: { headline: "SpaceApp" } }, brandKitId: "dbrand:spaceapp", parentAssetId: null, pinned: true,
  createdAt: at, updatedAt: at, ...extra
});
const request: DesignRequest = {
  id: "dreq:request01", ownerUserId: "user:operator", designPaneId: pane.id, requester: { kind: "PANE", paneId: "pane:codex00001", label: "Andy (Codex CLI)" },
  brief: "LinkedIn banner for the 0.3 release", formatIds: ["linkedin-banner"], engine: null, brandKitId: null, referenceArtifactIds: [], callback: null,
  status: "NEEDS_APPROVAL", resultAssetIds: ["dasset:banner01"], question: null, answer: null, message: null, takenAt: at, deliveredAt: null, createdAt: at, updatedAt: at
};

describe("DesignPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    apiMock.designSettings.mockResolvedValue({ metadata: defaultDesignPaneMetadata() });
    apiMock.updateDesignSettings.mockImplementation(async (_paneId: string, next: DesignPaneMetadata) => ({ metadata: next }));
    apiMock.designRequests.mockResolvedValue({ requests: [request] });
    apiMock.designAssets.mockResolvedValue({ assets: [asset("dasset:banner01", "linkedin-banner", 1584, 396)] });
    apiMock.designBrandKits.mockResolvedValue({ brandKits: [SPACEAPP_BRAND_KIT] });
    apiMock.designEvents.mockResolvedValue({ events: [] });
    apiMock.userSettings.mockResolvedValue({ design: null });
    apiMock.cliRuntimes.mockResolvedValue(registry);
    apiMock.cliRuntimesSnapshot.mockReturnValue(registry);
    apiMock.listCliAccountProfiles.mockResolvedValue({ runtimeId: "cli:claude", profiles: [{ profileId: "main", displayName: "Main" }], gatewayProfile: null, defaultProfileId: "main" });
    apiMock.activeCliSession.mockResolvedValue({ session: { runtimeId: "cli:claude", accountProfileId: "main" } });
  });
  afterEach(() => cleanup());

  it("is a copilot kind that opens with Claude Code, with the Studio as a tab only when stacked", () => {
    expect(copilotKindForMode("DESIGN")).toBe(DESIGN_KIND);
    expect(DESIGN_KIND).toMatchObject({ preferredRuntimeId: "cli:claude", settingsKey: "design", label: "Design" });
    expect(tabsForLayout("split")).toEqual(["requests", "library", "brand-kits", "setup", "terminal"]);
    expect(tabsForLayout("stacked")[0]).toBe("studio");
    expect(resolveActiveTab("studio", "split")).toBe("requests");
  });

  it("renders a template at the chosen format and shows it at that format's aspect", async () => {
    apiMock.designRender.mockResolvedValue({ asset: asset("dasset:xpost001", "x", 1600, 900) });
    render(<DesignPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    const studio = await screen.findByRole("region", { name: "Studio" });
    fireEvent.change(within(studio).getByRole("combobox", { name: "Format" }), { target: { value: "x" } });
    fireEvent.change(within(studio).getByRole("combobox", { name: "Engine" }), { target: { value: "TEMPLATE" } });
    fireEvent.change(within(studio).getByLabelText("Headline"), { target: { value: "SpaceApp 0.3" } });
    fireEvent.click(within(studio).getByRole("button", { name: "Make" }));
    await waitFor(() => expect(apiMock.designRender).toHaveBeenCalledWith(pane.id, expect.objectContaining({ templateId: "photo-headline", formatId: "x", params: { headline: "SpaceApp 0.3" }, brandKitId: "dbrand:spaceapp" })));
    // The library refresh brings the new asset; the preview keeps its exact aspect ratio.
    apiMock.designAssets.mockResolvedValue({ assets: [asset("dasset:xpost001", "x", 1600, 900)] });
    await waitFor(() => expect((within(studio).getByLabelText("Preview") as HTMLElement).style.aspectRatio).toMatch(/1600 \/ 900/));
  });

  it("generates the picture, then composes it at the exact size; a custom size is a custom- format", async () => {
    apiMock.designGenerate.mockResolvedValue({ asset: asset("dasset:photo001", "custom-1000x500", 1024, 576, { engine: "NANO_BANANA", templateId: null }), text: null });
    apiMock.designRender.mockResolvedValue({ asset: asset("dasset:final001", "custom-1000x500", 1000, 500) });
    render(<DesignPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    const studio = await screen.findByRole("region", { name: "Studio" });
    fireEvent.change(within(studio).getByLabelText("Brief"), { target: { value: "Calm orbit of terminals" } });
    fireEvent.change(within(studio).getByRole("combobox", { name: "Format" }), { target: { value: "custom" } });
    fireEvent.change(within(studio).getByLabelText("Custom width"), { target: { value: "1000" } });
    fireEvent.change(within(studio).getByLabelText("Custom height"), { target: { value: "500" } });
    fireEvent.click(within(studio).getByRole("button", { name: "Make" }));
    await waitFor(() => expect(apiMock.designRender).toHaveBeenCalled());
    expect(apiMock.designGenerate).toHaveBeenCalledWith(pane.id, { engine: "NANO_BANANA", prompt: "Calm orbit of terminals", formatId: "custom-1000x500", requestId: null });
    expect(apiMock.designRender).toHaveBeenCalledWith(pane.id, expect.objectContaining({ backgroundAssetId: "dasset:photo001", formatId: "custom-1000x500" }));
  });

  it("lists requests with their requester, approves a held delivery and saves Setup", async () => {
    apiMock.deliverDesignRequest.mockResolvedValue({ request: { ...request, status: "DELIVERED" } });
    render(<DesignPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    const card = (await screen.findByText("Andy (Codex CLI)")).closest("li")!;
    expect(within(card).getByText("Needs your approval")).toBeTruthy();
    expect(within(card).getByText("LinkedIn banner for the 0.3 release")).toBeTruthy();
    expect(screen.getByText("1 needs you")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Approve and deliver" }));
    await waitFor(() => expect(apiMock.deliverDesignRequest).toHaveBeenCalledWith(pane.id, request.id));

    fireEvent.click(screen.getByRole("tab", { name: /Setup/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Requests/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Needs my approval" }));
    await waitFor(() => expect(apiMock.updateDesignSettings).toHaveBeenCalledWith(pane.id, expect.objectContaining({ settings: expect.objectContaining({ requestAutonomy: "APPROVAL" }) })));
  });
});
