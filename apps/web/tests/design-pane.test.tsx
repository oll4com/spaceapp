import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, DesignAsset, DesignPaneMetadata, DesignRequest, Pane } from "@space/contracts";
import { defaultDesignPaneMetadata, SPACEAPP_BRAND_KIT } from "@space/contracts";
import { DesignPane, resolveActiveTab, tabsForLayout } from "../src/features/design-pane/DesignPane.js";
import { DESIGN_KIND, copilotKindForMode } from "../src/features/copilot-kit/copilot-kind.js";

const apiMock = vi.hoisted(() => ({
  artifactFileUrl: (id: string) => `/api/artifacts/${encodeURIComponent(id)}/file`,
  agentFileDownloadUrl: (id: string) => `/api/artifacts/${encodeURIComponent(id)}/download`,
  artifactMetadata: vi.fn(),
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
  model: null, label: null, prompt: null, templateId: "gradient-headline", params: { values: { headline: "SpaceApp" } }, brandKitId: "dbrand:spaceapp", parentAssetId: null,
  description: 'Template gradient-headline: headline "SpaceApp"', madeBy: { by: "OPERATOR", runtimeId: null, model: null }, pinned: true, createdAt: at, updatedAt: at, ...extra
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
    // The library refresh after Make brings the new asset; the preview keeps its exact aspect ratio.
    apiMock.designAssets.mockResolvedValue({ assets: [asset("dasset:xpost001", "x", 1600, 900)] });
    fireEvent.click(within(studio).getByRole("button", { name: "Make" }));
    await waitFor(() => expect(apiMock.designRender).toHaveBeenCalledWith(pane.id, expect.objectContaining({ templateId: "photo-headline", formatId: "x", params: { headline: "SpaceApp 0.3" }, brandKitId: "dbrand:spaceapp" })));
    expect(await within(studio).findByRole("button", { name: /Crop or annotate/ })).toBeTruthy();
    expect((within(studio).getByLabelText("Preview") as HTMLElement).style.aspectRatio).toMatch(/1600 \/ 900/);
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

  it("Also make lays a template out again, and sends a picture to the designer instead of cropping it", async () => {
    const picture = asset("dasset:chess001", "portrait", 1080, 1350, { engine: "UPLOAD", templateId: null, params: null, prompt: null });
    const template = asset("dasset:tmpl0001", "square", 1080, 1080);
    apiMock.designAssets.mockResolvedValue({ assets: [picture, template] });
    apiMock.createDesignRequest.mockResolvedValue({ request });
    apiMock.designVariants.mockResolvedValue({ assets: [] });
    render(<DesignPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    const studio = await screen.findByRole("region", { name: "Studio" });
    const alsoMake = async (thumbTitle: string, formatId: string) => {
      fireEvent.click(await within(studio).findByTitle(thumbTitle));
      const select = within(studio).getByLabelText("Also make in other formats") as HTMLSelectElement;
      for (const option of Array.from(select.options)) option.selected = option.value === formatId;
      fireEvent.change(select);
      fireEvent.click(within(studio).getByRole("button", { name: /Make 1 more/ }));
    };

    await alsoMake("Instagram portrait · 1080×1350", "x");
    await waitFor(() => expect(apiMock.createDesignRequest).toHaveBeenCalledWith(pane.id, expect.objectContaining({
      formatIds: ["x"], referenceArtifactIds: [picture.artifactId], brief: expect.stringContaining("laid out again for each size")
    })));
    expect(apiMock.designVariants).not.toHaveBeenCalled();
    expect(await within(studio).findByText(/remakes it for each format/)).toBeTruthy();

    await alsoMake("Instagram post · 1080×1080", "x");
    await waitFor(() => expect(apiMock.designVariants).toHaveBeenCalledWith(pane.id, template.id, { formatIds: ["x"], requestId: null }));
    expect(apiMock.createDesignRequest).toHaveBeenCalledTimes(1);
  });

  it("applies a ready-made colour combination to a template, and saves and deletes your own", async () => {
    const paper = { background: "#F7F5F0", primary: "#1F4FD8", accent: "#E4572E", text: "#1A1A1A" };
    apiMock.designRender.mockResolvedValue({ asset: asset("dasset:paper001", "square", 1080, 1080) });
    apiMock.updateUserSettings.mockImplementation(async (input: { designColorPresets: unknown[] }) => ({ designColorPresets: input.designColorPresets }));
    render(<DesignPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    const studio = await screen.findByRole("region", { name: "Studio" });
    fireEvent.change(within(studio).getByRole("combobox", { name: "Engine" }), { target: { value: "TEMPLATE" } });
    // Empty colours show the brand kit's.
    expect((within(studio).getByLabelText("Background colour") as HTMLInputElement).value).toBe("#0a0e24");
    fireEvent.change(within(studio).getByRole("combobox", { name: "Colours" }), { target: { value: "built-in:Paper" } });
    expect((within(studio).getByLabelText("Text colour") as HTMLInputElement).value).toBe("#1a1a1a");
    fireEvent.click(within(studio).getByRole("button", { name: "Make" }));
    await waitFor(() => expect(apiMock.designRender).toHaveBeenCalledWith(pane.id, expect.objectContaining({ params: { colors: paper } })));

    fireEvent.change(within(studio).getByLabelText("Colour combination name"), { target: { value: "Launch week" } });
    fireEvent.click(within(studio).getByRole("button", { name: "Save colours" }));
    await waitFor(() => expect(apiMock.updateUserSettings).toHaveBeenCalledWith({ designColorPresets: [{ name: "Launch week", ...paper }] }));
    expect((within(studio).getByRole("combobox", { name: "Colours" }) as HTMLSelectElement).value).toBe("own:Launch week");
    fireEvent.click(await within(studio).findByRole("button", { name: "Delete “Launch week”" }));
    await waitFor(() => expect(apiMock.updateUserSettings).toHaveBeenLastCalledWith({ designColorPresets: [] }));
    expect((within(studio).getByRole("combobox", { name: "Colours" }) as HTMLSelectElement).value).toBe("built-in:Paper");
  });

  it("saves your colours onto the list saved now, so a failed load or another pane's save is never lost (Record Retention Invariant)", async () => {
    const night = { name: "Night", background: "#000000", primary: "#111111", accent: "#222222", text: "#FFFFFF" };
    apiMock.userSettings.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ designColorPresets: [night] });
    apiMock.updateUserSettings.mockImplementation(async (input: { designColorPresets: unknown[] }) => ({ designColorPresets: input.designColorPresets }));
    render(<DesignPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    const studio = await screen.findByRole("region", { name: "Studio" });
    fireEvent.change(within(studio).getByRole("combobox", { name: "Engine" }), { target: { value: "TEMPLATE" } });
    fireEvent.change(within(studio).getByLabelText("Colour combination name"), { target: { value: "Launch week" } });
    fireEvent.click(within(studio).getByRole("button", { name: "Save colours" }));
    await waitFor(() => expect(apiMock.updateUserSettings).toHaveBeenCalledWith({ designColorPresets: [night, expect.objectContaining({ name: "Launch week" })] }));

    // A full list refuses a new combination instead of dropping the oldest.
    apiMock.userSettings.mockResolvedValue({ designColorPresets: Array.from({ length: 30 }, (_, index) => ({ ...night, name: `Saved ${index}` })) });
    apiMock.updateUserSettings.mockClear();
    fireEvent.change(within(studio).getByLabelText("Colour combination name"), { target: { value: "One more" } });
    fireEvent.click(within(studio).getByRole("button", { name: "Save colours" }));
    expect(await within(studio).findByText(/You have 30 saved colour combinations: delete one first/)).toBeTruthy();
    expect(apiMock.updateUserSettings).not.toHaveBeenCalled();
  });

  it("downloads a design from its Media file, saves a copy to Agent Files › Graphics / Design and deletes it", async () => {
    const design = asset("dasset:story001", "story", 1080, 1920);
    apiMock.designAssets.mockResolvedValue({ assets: [design] });
    apiMock.uploadAgentFiles.mockResolvedValue({ artifacts: [] });
    const fetchMock = vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" })));
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<DesignPane pane={pane} isVisible terminal={<div>terminal</div>} />);
      const studio = await screen.findByRole("region", { name: "Studio" });
      fireEvent.click(await within(studio).findByTitle("Instagram story / Reels · 1080×1920"));
      const download = within(studio).getByRole("link", { name: /Download/ });
      expect(download.getAttribute("href")).toBe(`/api/artifacts/${encodeURIComponent(design.artifactId)}/file`);
      // An .ico is offered only for square designs.
      expect(within(studio).queryByRole("button", { name: /Download \.ico/ })).toBeNull();
      expect(download.getAttribute("download")).toBe("design-story.png");
      fireEvent.click(within(studio).getByRole("button", { name: /Save to Agent Files/ }));
      await waitFor(() => expect(apiMock.uploadAgentFiles).toHaveBeenCalledWith({ roomId: pane.roomId, folder: "GRAPHICS/Design", files: [expect.any(File)] }));
      expect(fetchMock).toHaveBeenCalledWith(`/api/artifacts/${encodeURIComponent(design.artifactId)}/file`, { credentials: "same-origin" });
      expect((apiMock.uploadAgentFiles.mock.calls[0]![0] as { files: File[] }).files[0]!.name).toBe("design-story.png");
      expect(await within(studio).findByText(/Saved to Agent Files › Graphics \/ Design/)).toBeTruthy();
      // The selected design can be deleted from the Studio, like Remove in the Library.
      apiMock.deleteDesignAsset.mockResolvedValue({ deleted: true });
      fireEvent.click(within(studio).getByRole("button", { name: "Delete this design" }));
      await waitFor(() => expect(apiMock.deleteDesignAsset).toHaveBeenCalledWith(pane.id, design.id));
      expect(await within(studio).findByText(/Deleted from the library/)).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("offers the Brand formats and the Logo template, and a .ico download for a square design", async () => {
    apiMock.designAssets.mockResolvedValue({ assets: [asset("dasset:logo0001", "logo", 1024, 1024, { templateId: "logo" })] });
    render(<DesignPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    const studio = await screen.findByRole("region", { name: "Studio" });
    const formats = within(studio).getByRole("combobox", { name: /Format/ });
    expect(within(formats).getByRole("group", { name: "Brand" })).toBeTruthy();
    expect(within(formats).getByRole("option", { name: /Wide logo · 1600×600/ })).toBeTruthy();
    expect(within(studio).getByRole("option", { name: "Logo" })).toBeTruthy();
    fireEvent.click(await within(studio).findByTitle("Logo · 1024×1024"));
    expect(within(studio).getByRole("button", { name: /Download \.ico/ })).toBeTruthy();
  });

  it("shows a design's details (what it shows, who made it, what the file carries) from the Studio and the Library", async () => {
    const design = asset("dasset:link0001", "linkedin", 1200, 627, { label: "Chess benchmark (LinkedIn post)", description: "6 AI models played chess. Zero checkmates.",
      madeBy: { by: "AGENT", runtimeId: "cli:claude", model: "claude-opus-5-5" } });
    apiMock.designAssets.mockResolvedValue({ assets: [design] });
    apiMock.artifactMetadata.mockResolvedValue({
      artifact: { id: design.artifactId, filename: "design-linkedin.png", mimeType: "image/png", byteSize: 206184, sha256: "b".repeat(64), createdAt: at, roomId: pane.roomId, metadata: { source: "DESIGN" } },
      image: { width: 1200, height: 627 }, embedded: { Title: "Chess benchmark (LinkedIn post)", Description: "6 AI models played chess. Zero checkmates.", Software: "SpaceApp Design", "spaceapp:design": "{}" }, design: {}
    });
    render(<DesignPane pane={pane} isVisible terminal={<div>terminal</div>} />);
    const studio = await screen.findByRole("region", { name: "Studio" });
    fireEvent.click(await within(studio).findByTitle("LinkedIn post · 1200×627"));
    fireEvent.click(within(studio).getByRole("button", { name: /Details/ }));
    const dialog = await screen.findByRole("dialog", { name: "Details of design-linkedin.png" });
    expect(apiMock.artifactMetadata).toHaveBeenCalledWith(design.artifactId);
    expect(within(dialog).getByText("6 AI models played chess. Zero checkmates.")).toBeTruthy();
    expect(within(dialog).getByText("claude-opus-5-5 · cli:claude")).toBeTruthy();
    expect(within(dialog).getByText(/1200 × 627 px · LinkedIn post \(matches the format\)/)).toBeTruthy();
    expect(await within(dialog).findByText("Title, Description, Software, spaceapp:design")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Details of/ })).toBeNull());

    fireEvent.click(screen.getByRole("tab", { name: /Library/ }));
    fireEvent.click(within(screen.getByRole("tabpanel", { name: /Library/ })).getByRole("button", { name: "Details" }));
    const fromLibrary = await screen.findByRole("dialog", { name: "Details of design-linkedin.png" });
    fireEvent.click(within(fromLibrary).getByRole("button", { name: "Close details" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Details of/ })).toBeNull());
  });

  it("uploads files to the designer's CLI from the Studio and the Library, showing its terminal", async () => {
    const actions: Array<{ paneId?: string; action?: string }> = [];
    const listener = (event: Event) => actions.push((event as CustomEvent<{ paneId?: string; action?: string }>).detail);
    window.addEventListener("space:terminal-pane-action", listener);
    try {
      render(<DesignPane pane={pane} isVisible terminal={<div>terminal</div>} />);
      expect((await screen.findByRole("tab", { name: /Requests/ })).getAttribute("aria-selected")).toBe("true");
      fireEvent.click(within(await screen.findByRole("region", { name: "Studio" })).getByRole("button", { name: /Upload files/ }));
      expect(actions).toEqual([{ paneId: pane.id, action: "upload" }]);
      expect(screen.getByRole("tab", { name: /Terminal/ }).getAttribute("aria-selected")).toBe("true");
      fireEvent.click(screen.getByRole("tab", { name: /Library/ }));
      fireEvent.click(within(screen.getByRole("tabpanel", { name: /Library/ })).getByRole("button", { name: /Upload files/ }));
      expect(actions).toHaveLength(2);
      expect(screen.getByRole("tab", { name: /Terminal/ }).getAttribute("aria-selected")).toBe("true");
    } finally {
      window.removeEventListener("space:terminal-pane-action", listener);
    }
  });
});
