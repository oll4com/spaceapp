import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LIVE_AUDIO_PROVIDERS, SETUP_CATALOG, type SetupFeatureId } from "@space/contracts";
import { FirstSetupWizard, type FirstSetupClient } from "../src/features/setup-connections/FirstSetupWizard.js";
import { SetupConnectionsWizard } from "../src/features/setup-connections/SetupConnectionsWizard.js";

const essential: SetupFeatureId[] = [
  "agent:opencode", "pane:chat", "dock:rooms", "dock:tasks", "dock:agent-files", "dock:settings"
];
const catalog = {
  protocolVersion: 2,
  catalogVersion: "first-setup-v2.0",
  features: SETUP_CATALOG.map((feature) => ({
    ...feature, availability: feature.id === "pane:live" ? "INSTALLABLE" : "AVAILABLE", reasonCode: null
  }))
};
const initialDraft = {
  id: null, ownerId: "user:owner", protocolVersion: 2, revision: null,
  persona: "everyday" as const, level: "minimal" as const,
  requestedFeatureIds: essential, connectionChoices: [], catalogVersion: "first-setup-v2.0"
};
const plan = {
  id: "plan:setup-proof", draftId: "draft:setup-proof", ownerId: "user:owner",
  draftRevision: 0, catalogVersion: "first-setup-v2.0", planDigest: "a".repeat(64),
  requestedFeatureIds: essential, effectiveFeatureIds: essential, actions: [],
  requiredHumanInputs: [], costDisclosures: [], resourceConstraints: [],
  createdAt: "2026-10-08T00:00:00.000Z"
};
const run = {
  id: "run:setup-proof", planId: plan.id, ownerId: "user:owner",
  status: "RUNNING" as const, revision: 1, eventSequence: 0,
  createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z", finishedAt: null
};

function client(): FirstSetupClient {
  return {
    getSetupCatalog: vi.fn().mockResolvedValue(catalog),
    getSetupDraft: vi.fn().mockResolvedValue(initialDraft),
    saveSetupDraft: vi.fn().mockImplementation(async (input) => ({ ...initialDraft, ...input, id: "draft:setup-proof", revision: 0 })),
    createSetupPlan: vi.fn().mockResolvedValue(plan),
    startSetupRun: vi.fn().mockResolvedValue(run),
    getSetupRun: vi.fn().mockResolvedValue({ run, plan, tasks: [], receipts: [] }),
    getCurrentSetup: vi.fn().mockResolvedValue({ run: null, plan: null, tasks: [], receipts: [] }),
    verifySetupConnection: vi.fn().mockResolvedValue({}),
    retrySetupRun: vi.fn().mockResolvedValue({ run }),
    finishSetupRun: vi.fn().mockResolvedValue({ isComplete: true })
  };
}

describe("first setup wizard", () => {
  it("explains when automatic setup cannot safely verify an optional agent", async () => {
    const api = client();
    api.getSetupCatalog = vi.fn().mockResolvedValue({ ...catalog, features: catalog.features.map(feature => feature.id === "agent:cursor"
      ? { ...feature, availability: "UNAVAILABLE", reasonCode: "AGENT_SETUP_CHECK_UNSUPPORTED" } : feature) });
    render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Explore all tools" }));
    const toggle = screen.getByRole("switch", { name: "Cursor" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(within(toggle.closest("article")!).getByText(/Automatic setup cannot safely verify this agent yet/)).toBeTruthy();
  });

  it("explains an unsupported Harness check while keeping its selection disabled", async () => {
    const api = client();
    api.getSetupCatalog = vi.fn().mockResolvedValue({ ...catalog, features: catalog.features.map(feature => feature.id === "pane:harness"
      ? { ...feature, availability: "UNAVAILABLE", reasonCode: "HARNESS_SETUP_UNSUPPORTED" } : feature) });
    render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Explore all tools" }));
    const toggle = screen.getByRole("switch", { name: "Harness" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(within(toggle.closest("article")!).getByText(/Automatic setup cannot safely test this Harness runtime yet/)).toBeTruthy();
  });
  it("requires the selected OSK browser check before starting a run", async () => {
    const api = client();
    api.beginSetupClientRuntimeCheck = vi.fn(async () => ({ checkId: "b7111bdb-a9d8-4f6b-b237-2e9b1c815ea0", featureId: "utility:osk" as const, challenge: `SpaceApp-${"a".repeat(32)}` }));
    api.completeSetupClientRuntimeCheck = vi.fn(async () => ({ verified: false }));
    api.cancelSetupClientRuntimeCheck = vi.fn(async () => undefined);
    render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Explore all tools" }));
    fireEvent.click(screen.getByRole("switch", { name: "On-screen keyboard" }));
    fireEvent.click(screen.getByRole("button", { name: "Set up my Space" }));
    await waitFor(() => expect(api.completeSetupClientRuntimeCheck).toHaveBeenCalled());
    expect(api.startSetupRun).not.toHaveBeenCalled();
  });
  it("rechecks a failed browser tool before retrying its task", async () => {
    const api = client(); const failed = { ...run, status: "FAILED" as const };
    const task = { id: "task:osk", featureId: "utility:osk" as const, actionId: "CHECK_SERVICE", status: "NEEDS_ATTENTION", errorCode: "ACTION_INSPECTION_FAILED" };
    api.getSetupDraft = vi.fn(async () => ({ ...initialDraft, id: "draft:setup-proof", revision: 0, requestedFeatureIds: [...essential, "utility:osk" as const] }));
    api.getCurrentSetup = vi.fn(async () => ({ run: failed, plan, tasks: [task] }));
    api.getSetupRun = vi.fn(async () => ({ run: failed, plan, tasks: [task] }));
    api.beginSetupClientRuntimeCheck = vi.fn(async () => ({ checkId: "b7111bdb-a9d8-4f6b-b237-2e9b1c815ea0", featureId: "utility:osk" as const, challenge: `SpaceApp-${"a".repeat(32)}` }));
    api.completeSetupClientRuntimeCheck = vi.fn(async () => ({ verified: false }));
    api.cancelSetupClientRuntimeCheck = vi.fn(async () => undefined);
    render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry failed step" }));
    await waitFor(() => expect(api.completeSetupClientRuntimeCheck).toHaveBeenCalled());
    expect(api.retrySetupRun).not.toHaveBeenCalled();
  });
  it("shows explicit capture permission only for selected Screen capture", async () => {
    const api = client();
    api.beginSetupCaptureCheck = vi.fn(); api.completeSetupCaptureCheck = vi.fn(); api.cancelSetupCaptureCheck = vi.fn();
    api.createSetupPlan = vi.fn(async () => ({ ...plan, requiredHumanInputs: [{ featureId: "utility:snip" as const, kind: "OS_PERMISSION", reasonCode: "CAPTURE_PERMISSION_REQUIRED" }] }));
    render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Explore all tools" }));
    expect(screen.queryByRole("button", { name: "Test capture" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Screen capture" }));
    fireEvent.click(screen.getByRole("button", { name: "Set up my Space" }));
    await screen.findByRole("button", { name: "Test capture" });
    expect(api.beginSetupCaptureCheck).not.toHaveBeenCalled(); expect(api.startSetupRun).not.toHaveBeenCalled();
  });
  it("continues setup with Live disabled when no provider key is supplied", async () => {
    const api = client();
    let current = { ...initialDraft, id: "draft:setup-proof", revision: 0 };
    api.getSetupDraft = vi.fn(async () => current);
    api.getSetupVoiceProviders = vi.fn().mockResolvedValue({ providers: [{ ...LIVE_AUDIO_PROVIDERS.openai, configured: false, credentialSource: null }] });
    api.saveSetupVoiceCredential = vi.fn();
    api.saveSetupDraft = vi.fn(async input => { current = { ...current, ...input, revision: current.revision + 1 }; return current; });
    api.createSetupPlan = vi.fn(async revision => ({ ...plan, draftRevision: revision, effectiveFeatureIds: current.requestedFeatureIds,
      requiredHumanInputs: current.requestedFeatureIds.includes("pane:live") ? [{ featureId: "pane:live" as const, kind: "API_CREDENTIAL", reasonCode: "LIVE_PROVIDER_REQUIRED" }] : [] }));
    render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Explore all tools" }));
    fireEvent.click(screen.getByRole("switch", { name: "Live audio" }));
    fireEvent.click(screen.getByRole("button", { name: "Set up my Space" }));
    await screen.findByLabelText("API key (required)");
    expect(api.startSetupRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Skip Live for now" }));
    await screen.findByRole("heading", { name: "Setting up" });
    expect(current.requestedFeatureIds).not.toContain("pane:live");
    expect(current.connectionChoices).toEqual([]);
    expect(api.saveSetupVoiceCredential).not.toHaveBeenCalled();
    expect(api.startSetupRun).toHaveBeenCalledOnce();
  });
  it("loads the secure voice form only after selecting Live and stores its choice without starting an unverified run", async () => {
    const api = client();
    api.getSetupVoiceProviders = vi.fn().mockResolvedValue({ providers: [{ ...LIVE_AUDIO_PROVIDERS.local, configured: false, credentialSource: null }] });
    api.saveSetupVoiceCredential = vi.fn().mockResolvedValue({ configured: true, credentialRef: "cred:voice:owned-local" });
    api.createSetupPlan = vi.fn().mockResolvedValue({ ...plan, effectiveFeatureIds: [...essential, "pane:live"], requiredHumanInputs: [
      { featureId: "pane:live", kind: "API_CREDENTIAL", reasonCode: "LIVE_PROVIDER_REQUIRED" },
      { featureId: "pane:live", kind: "MICROPHONE", reasonCode: "LIVE_MICROPHONE_CHECK_REQUIRED" }
    ] });
    render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Explore all tools" }));
    expect(api.getSetupVoiceProviders).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch", { name: "Live audio" }));
    fireEvent.click(screen.getByRole("button", { name: "Set up my Space" }));
    const token = await screen.findByLabelText("Local service token (required)");
    fireEvent.change(token, { target: { value: "private-local-fixture-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await screen.findByText("Connection saved securely. Complete the audio check to verify Live.");
    const savedInput = (api.saveSetupDraft as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(savedInput.connectionChoices).toEqual([{ featureId: "pane:live", providerId: "local", modelId: LIVE_AUDIO_PROVIDERS.local.defaultModel,
      voiceId: LIVE_AUDIO_PROVIDERS.local.defaultVoice, credentialRef: "cred:voice:owned-local" }]);
    expect(JSON.stringify(savedInput)).not.toContain("private-local-fixture-token");
    expect(api.startSetupRun).not.toHaveBeenCalled();
  });
  it("lets a completed owner open the shared tool setup from Settings", async () => {
    const api = client();
    const overview = { onboardingVersion: 2, isComplete: true, completedAt: "2026-10-08T00:00:00.000Z",
      starterRoomId: "room:starter", connections: [], summary: { total: 0, functional: 0, liveVerified: 0, needsSetup: 0 } };
    render(<SetupConnectionsWizard embedded open
      checks={{ startSetupConnectionChecks: vi.fn(), startSetupConnectionCheck: vi.fn(),
        getSetupConnectionCheckReplay: vi.fn(), openSetupConnectionCheckStream: vi.fn(() => null) }}
      finish={async () => overview} loadOverview={async () => overview}
      onOpenChange={vi.fn()} openLogin={vi.fn()} reconfigurationClient={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Configure workspace tools" }));
    await screen.findByRole("heading", { name: "Your Space" });
    expect(screen.getByRole("button", { name: "Set up my Space" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Setup & connections" })).toBeNull();
  });
  it("opens current choices for reconfiguration instead of finishing the previously completed run", async () => {
    const api = client();
    api.getSetupDraft = vi.fn().mockResolvedValue({ ...initialDraft, id: "draft:setup-proof", revision: 0 });
    api.getCurrentSetup = vi.fn().mockResolvedValue({ run: { ...run, status: "READY" }, plan, tasks: [], completedRunId: run.id });
    render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "Your Space" });
    expect(screen.queryByRole("heading", { name: "Your Space is ready" })).toBeNull();
    expect(api.finishSetupRun).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Set up my Space" })).toBeTruthy();
  });
  it("offers checked free models and updates the choice only after server verification", async () => {
    const api = client();
    api.getSetupFreeModels = vi.fn().mockResolvedValue({ selectedModelId: "opencode/fast", checkedAt: new Date().toISOString(), models: [
      { id: "opencode/fast", anonymousAvailable: true, setupPassed: 2, latencyMs: 50 },
      { id: "opencode/other", anonymousAvailable: true, setupPassed: 2, latencyMs: 100 },
      { id: "opencode/account-free", anonymousAvailable: false, setupPassed: 0, latencyMs: 100 }
    ] });
    api.selectSetupFreeModel = vi.fn().mockImplementation(async modelId => ({ modelId, verified: true }));
    render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
    const select = await screen.findByRole("combobox", { name: "Free model choice" });
    expect((screen.getByRole("option", { name: /opencode\/account-free/ }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: "opencode/other" } });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("opencode/other"));
    fireEvent.click(screen.getByRole("button", { name: "Set up my Space" }));
    await waitFor(() => expect(api.saveSetupDraft).toHaveBeenCalledWith(expect.objectContaining({
      connectionChoices: [{ featureId: "agent:opencode", providerId: "opencode", modelId: "other" }]
    })));
  });

  it("shows the free model choice disabled with a reason until this installation can apply one", async () => {
    const api = client();
    api.getSetupFreeModels = vi.fn().mockResolvedValue({ selectedModelId: "opencode/big-pickle", checkedAt: new Date().toISOString(), selectable: false,
      models: [{ id: "opencode/big-pickle", anonymousAvailable: true, setupPassed: 2, latencyMs: 50 }] });
    api.selectSetupFreeModel = vi.fn();
    render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
    const select = await screen.findByRole("combobox", { name: "Free model choice" }) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("auto");
    expect(screen.getByText("Choosing a model needs a newer OpenCode setup on this installation. Auto — best free is used.")).toBeTruthy();
    expect(api.selectSetupFreeModel).not.toHaveBeenCalled();
  });

  it("explains that legacy selections are preserved and lets the owner review them", async () => {
    const api = client();
    api.getSetupDraft = vi.fn().mockResolvedValue({ ...initialDraft, selectionOrigin: "EXISTING_SETTINGS",
      requestedFeatureIds: [...essential, "widget:clock"] });
    render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
    expect(await screen.findByText(/Your existing workspace choices are selected/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Explore all tools" }));
    expect((screen.getByRole("switch", { name: "Clock" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("switch", { name: "File Manager" }) as HTMLInputElement).checked).toBe(false);
  });

  it("lets the owner revise choices when final verification rejects a ready run", async () => {
    const api = client();
    api.getSetupRun = vi.fn().mockResolvedValue({ run: { ...run, status: "READY" }, plan, tasks: [] });
    api.finishSetupRun = vi.fn().mockRejectedValue(new Error("Workspace settings changed."));
    render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up my Space" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Workspace settings changed.");
    expect(screen.queryByRole("button", { name: "Open Space" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change tools" }));
    expect(screen.getByRole("heading", { name: "Your Space" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Set up my Space" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("opens selected agent login from Connections and can recheck it", async () => {
    const api = client();
    const login = vi.fn().mockResolvedValue(undefined);
    api.createSetupPlan = vi.fn().mockResolvedValueOnce({ ...plan, requiredHumanInputs: [
      { featureId: "agent:codex", kind: "PROVIDER_LOGIN", reasonCode: "AGENT_CONNECTION_REQUIRED" }
    ] }).mockResolvedValueOnce(plan);
    const onOpenChange = vi.fn();
    render(<FirstSetupWizard client={api} onOpenChange={onOpenChange} onOpenAgentLogin={login} />);
    await screen.findByRole("heading", { name: "Your Space" });
    fireEvent.click(screen.getByRole("button", { name: "Explore all tools" }));
    fireEvent.click(screen.getByRole("switch", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Set up my Space" }));
    await screen.findByRole("heading", { name: "Connections" });
    expect(screen.queryByText(/Connection setup is not available/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect Codex" }));
    await waitFor(() => expect(login).toHaveBeenCalledWith("cli:codex"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("continues automatically when a selected agent passes its live connection check", async () => {
    const api = client();
    api.createSetupPlan = vi.fn().mockResolvedValueOnce({ ...plan, requiredHumanInputs: [
      { featureId: "agent:codex", kind: "PROVIDER_LOGIN", reasonCode: "AGENT_CONNECTION_REQUIRED" }
    ] }).mockResolvedValueOnce(plan);
    api.verifySetupConnection = vi.fn().mockResolvedValue({ functionalState: "FUNCTIONAL", liveVerificationState: "VERIFIED" });
    render(<FirstSetupWizard client={api} onOpenChange={() => undefined} />);
    await screen.findByRole("heading", { name: "Your Space" });
    fireEvent.click(screen.getByRole("button", { name: "Explore all tools" }));
    fireEvent.click(screen.getByRole("switch", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Set up my Space" }));
    await screen.findByRole("heading", { name: "Connections" });
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() => expect(api.verifySetupConnection).toHaveBeenCalledWith("cli:codex"));
    await screen.findByRole("heading", { name: "Setting up" });
    expect(api.startSetupRun).toHaveBeenCalledOnce();
  });
  it("defaults to Everyday Minimal, explains inactive advanced tools and hides Live setup", async () => {
    const api = client();
    render(<FirstSetupWizard client={api} onOpenChange={() => undefined} />);
    await screen.findByRole("heading", { name: "Your Space" });
    expect(screen.getByRole("button", { name: /^Everyday/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^Minimal/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Explore all tools" }));
    expect(screen.getByText("File Manager")).toBeTruthy();
    expect(screen.getByText("Databases")).toBeTruthy();
    expect((screen.getByRole("switch", { name: "File Manager" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("switch", { name: "Databases" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText(/Choose a Live provider/)).toBeNull();
  });
  it("shows the currently proven free OpenCode model without claiming an unverified choice", async () => {
    const api = client();
    api.getSetupFreeModel = vi.fn().mockResolvedValue({ choice: "AUTO_BEST_FREE", modelId: "opencode/big-pickle", verified: true });
    render(<FirstSetupWizard client={api} onOpenChange={() => undefined} />);
    await screen.findByRole("heading", { name: "Your Space" });
    expect(await screen.findByText(/opencode\/big-pickle/)).toBeTruthy();
    expect(screen.getByText(/Auto — best free/)).toBeTruthy();
  });

  it("lets the owner undo a preset change that replaced custom tool choices", async () => {
    const api = client();
    render(<FirstSetupWizard client={api} onOpenChange={() => undefined} />);
    await screen.findByRole("heading", { name: "Your Space" });
    fireEvent.click(screen.getByRole("button", { name: "Explore all tools" }));
    fireEvent.click(screen.getByRole("switch", { name: "Clipboard" }));
    expect((screen.getByRole("switch", { name: "Clipboard" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Developer/ }));
    expect((screen.getByRole("switch", { name: "Clipboard" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Undo preset change" }));
    expect(screen.getByRole("button", { name: /^Everyday/ }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("switch", { name: "Clipboard" }) as HTMLInputElement).checked).toBe(true);
  });

  it("allows removal when a saved optional tool becomes unavailable", async () => {
    const api = client();
    api.getSetupCatalog = vi.fn().mockResolvedValue({ features: catalog.features.map((feature) =>
      feature.id === "pane:live" ? { ...feature, availability: "UNAVAILABLE", reasonCode: "RUNTIME_NOT_VERIFIED" } : feature
    ) });
    api.getSetupDraft = vi.fn().mockResolvedValue({ ...initialDraft, requestedFeatureIds: [...essential, "pane:live"] });
    render(<FirstSetupWizard client={api} onOpenChange={() => undefined} />);
    await screen.findByRole("heading", { name: "Your Space" });
    fireEvent.click(screen.getByRole("button", { name: "Explore all tools" }));
    const live = screen.getByRole("switch", { name: "Live audio" }) as HTMLInputElement;
    expect(live.checked).toBe(true);
    expect(live.disabled).toBe(false);
    fireEvent.click(live);
    expect(live.checked).toBe(false);
    expect(screen.queryByText(/Choose a Live provider/)).toBeNull();
  });

  it("shows connection details only for selected Live and never asks for a microphone while Live is off", async () => {
    const api = client();
    render(<FirstSetupWizard client={api} onOpenChange={() => undefined} />);
    await screen.findByRole("heading", { name: "Your Space" });
    fireEvent.click(screen.getByRole("button", { name: "Explore all tools" }));
    fireEvent.click(screen.getByRole("switch", { name: "Live audio" }));
    expect(screen.getByText(/Choose a Live provider/)).toBeTruthy();
    expect(screen.getAllByText(/microphone/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("switch", { name: "Live audio" }));
    expect(screen.queryByText(/Choose a Live provider/)).toBeNull();
  });
  it("explains Live providers and requirements while Live is unavailable", async () => {
    const api = client();
    api.getSetupCatalog = vi.fn().mockResolvedValue({ features: catalog.features.map((feature) =>
      feature.id === "pane:live" ? { ...feature, availability: "UNAVAILABLE", reasonCode: "RUNTIME_NOT_VERIFIED" } : feature
    ) });
    render(<FirstSetupWizard client={api} onOpenChange={() => undefined} />);
    await screen.findByRole("heading", { name: "Your Space" });
    fireEvent.click(screen.getByRole("button", { name: "Explore all tools" }));
    const live = screen.getByRole("switch", { name: "Live audio" });
    expect((live as HTMLInputElement).disabled).toBe(true);
    const details = live.closest("article")!;
    fireEvent.click(within(details).getByText("What this tool does"));
    expect(within(details).getByText(/OpenAI.*Google Gemini.*Amazon/i)).toBeTruthy();
    expect(within(details).getByText(/microphone and playback/i)).toBeTruthy();
    expect(within(details).getByText(/cannot be verified on this installation/i)).toBeTruthy();
  });

  it("does not show Ready or call finish for a run that has not completed", async () => {
    const api = client();
    render(<FirstSetupWizard client={api} onOpenChange={() => undefined} />);
    await screen.findByRole("heading", { name: "Your Space" });
    fireEvent.click(screen.getByRole("button", { name: "Set up my Space" }));
    await screen.findByRole("heading", { name: "Setting up" });
    expect(api.saveSetupDraft).toHaveBeenCalledOnce();
    expect(api.createSetupPlan).toHaveBeenCalledOnce();
    expect(api.startSetupRun).toHaveBeenCalledOnce();
    expect(api.finishSetupRun).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Ready" })).toBeNull();
  });

  it("shows a server-confirmed Ready only after a READY run and successful finish", async () => {
    const api = client();
    const ready = { ...run, status: "READY" as const };
    api.getSetupRun = vi.fn().mockResolvedValue({ run: ready, plan, tasks: [], receipts: [] });
    // Review 2026-10-21 #5: the app reloads the settings setup applied (the tested Live default among them) once.
    const onFinished = vi.fn();
    render(<FirstSetupWizard client={api} onOpenChange={() => undefined} onFinished={onFinished} />);
    await screen.findByRole("heading", { name: "Your Space" });
    fireEvent.click(screen.getByRole("button", { name: "Set up my Space" }));
    await waitFor(() => expect(api.finishSetupRun).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { name: "Ready" })).toBeTruthy();
    expect(onFinished).toHaveBeenCalledOnce();
  });

  // Review 2026-10-21 #8: checks that expired before finish are checked again in the same run, not with a new setup.
  it("checks expired results again in the same run instead of failing finish", async () => {
    const api = client();
    const ready = { ...run, status: "READY" as const, revision: 7 };
    api.getSetupRun = vi.fn().mockResolvedValue({ run: ready, plan, tasks: [], receipts: [] });
    api.finishSetupRun = vi.fn().mockRejectedValueOnce(Object.assign(new Error("Some setup checks expired."),
      { code: "SETUP_CHECKS_EXPIRED", details: { missingTaskIds: ["task:a", "task:b"] } }));
    api.retrySetupRun = vi.fn().mockResolvedValue({ run: { ...run, revision: 8 } });
    render(<FirstSetupWizard client={api} onOpenChange={() => undefined} />);
    await screen.findByRole("heading", { name: "Your Space" });
    fireEvent.click(screen.getByRole("button", { name: "Set up my Space" }));
    await waitFor(() => expect(api.retrySetupRun).toHaveBeenCalledWith(run.id, ["task:a", "task:b"], 7));
    expect(screen.queryByRole("heading", { name: "Ready" })).toBeNull();
    expect(screen.queryByText("Some setup checks expired.")).toBeNull();
  });

  it("saves edited selections before closing and keeps the dialog open if saving fails", async () => {
    const api = client();
    const onOpenChange = vi.fn();
    const first = render(<FirstSetupWizard client={api} onOpenChange={onOpenChange} />);
    await screen.findByRole("heading", { name: "Your Space" });
    fireEvent.click(screen.getByRole("button", { name: /^Developer/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Balanced/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save and close setup" }));
    await waitFor(() => expect(api.saveSetupDraft).toHaveBeenCalledWith(expect.objectContaining({
      persona: "developer", level: "balanced"
    })));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    first.unmount();

    const failing = client();
    failing.saveSetupDraft = vi.fn().mockRejectedValue(new Error("Revision changed"));
    const stillOpen = vi.fn();
    render(<FirstSetupWizard client={failing} onOpenChange={stillOpen} />);
    await screen.findByRole("heading", { name: "Your Space" });
    fireEvent.click(screen.getByRole("button", { name: "Save and close setup" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Revision changed");
    expect(stillOpen).not.toHaveBeenCalled();
  });

  it("moves focus into the dialog and keeps Tab navigation inside it", async () => {
    const api = client();
    render(<FirstSetupWizard client={api} onOpenChange={() => undefined} />);
    const title = await screen.findByRole("heading", { name: "Your Space" });
    expect(document.activeElement).toBe(title);
    const dialog = screen.getByRole("dialog");
    const close = screen.getByRole("button", { name: "Save and close setup" });
    close.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("resumes an unfinished server run after the window is reopened", async () => {
    const api = client();
    api.getSetupDraft = vi.fn().mockResolvedValue({ ...initialDraft, id: plan.draftId, revision: plan.draftRevision });
    api.getCurrentSetup = vi.fn().mockResolvedValue({ run, plan, tasks: [], receipts: [] });
    render(<FirstSetupWizard client={api} onOpenChange={() => undefined} />);
    expect(await screen.findByRole("heading", { name: "Setting up" })).toBeTruthy();
    expect(api.startSetupRun).not.toHaveBeenCalled();
    expect(api.getSetupRun).toHaveBeenCalledWith(run.id);
  });

  it("offers a scoped retry for a failed task", async () => {
    const api = client();
    const failedRun = { ...run, status: "FAILED" as const, revision: 4 };
    const task = { id: "task:failed", featureId: "agent:opencode" as SetupFeatureId,
      actionId: "VERIFY_AGENT_TASK", status: "NEEDS_ATTENTION", errorCode: "PROVIDER_FAILED" };
    api.getSetupDraft = vi.fn().mockResolvedValue({ ...initialDraft, id: plan.draftId, revision: plan.draftRevision });
    api.getCurrentSetup = vi.fn().mockResolvedValue({ run: failedRun, plan, tasks: [task] });
    api.getSetupRun = vi.fn().mockResolvedValue({ run: failedRun, plan, tasks: [task], receipts: [] });
    render(<FirstSetupWizard client={api} onOpenChange={() => undefined} />);
    await screen.findByRole("heading", { name: "Setting up" });
    expect(screen.getByText(/Provider check failed.*Reconnect and retry/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry failed step" }));
    await waitFor(() => expect(api.retrySetupRun).toHaveBeenCalledWith(run.id, [task.id], 4));
  });
  it("offers a server reconciliation action for an expired setup lease", async () => {
    const api = client();
    const failedRun = { ...run, status: "FAILED" as const, revision: 5 };
    const task = { id: "task:expired", featureId: "dock:rooms" as SetupFeatureId,
      actionId: "CHECK_SERVICE", status: "NEEDS_ATTENTION", errorCode: "LEASE_EXPIRED_RECONCILE" };
    api.getSetupDraft = vi.fn().mockResolvedValue({ ...initialDraft, id: plan.draftId, revision: plan.draftRevision });
    api.getCurrentSetup = vi.fn().mockResolvedValue({ run: failedRun, plan, tasks: [task] });
    api.getSetupRun = vi.fn().mockResolvedValue({ run: failedRun, plan, tasks: [task], receipts: [] });
    api.reconcileSetupTask = vi.fn().mockResolvedValue({ run: { ...run, revision: 6 }, plan, tasks: [{ ...task, status: "READY", errorCode: null }] });
    render(<FirstSetupWizard client={api} onOpenChange={() => undefined} />);
    await screen.findByRole("heading", { name: "Setting up" });
    fireEvent.click(screen.getByRole("button", { name: "Check interrupted step" }));
    await waitFor(() => expect(api.reconcileSetupTask).toHaveBeenCalledWith(run.id, task.id));
    expect(api.retrySetupRun).not.toHaveBeenCalled();
  });
  it("explains a failed native OpenCode check using the runner's actual error code", async () => {
    const api = client();
    const failedRun = { ...run, status: "FAILED" as const, revision: 6 };
    const task = { id: "task:opencode-apply", featureId: "agent:opencode" as SetupFeatureId,
      actionId: "PREPARE_OPENCODE", status: "NEEDS_ATTENTION", errorCode: "ACTION_APPLY_FAILED" };
    api.getSetupDraft = vi.fn().mockResolvedValue({ ...initialDraft, id: plan.draftId, revision: plan.draftRevision });
    api.getCurrentSetup = vi.fn().mockResolvedValue({ run: failedRun, plan, tasks: [task] });
    api.getSetupRun = vi.fn().mockResolvedValue({ run: failedRun, plan, tasks: [task], receipts: [] });
    render(<FirstSetupWizard client={api} onOpenChange={() => undefined} />);
    await screen.findByRole("heading", { name: "Setting up" });
    expect(screen.getByText(/OpenCode runtime check failed.*retry/i)).toBeTruthy();
  });
  it("pauses and resumes the same setup run without starting a new plan", async () => {
    const api = client();
    api.pauseSetupRun = vi.fn().mockResolvedValue({ run: { ...run, status: "PAUSED", revision: 2 } });
    api.resumeSetupRun = vi.fn().mockResolvedValue({ run: { ...run, revision: 3 } });
    render(<FirstSetupWizard client={api} onOpenChange={() => undefined} />);
    await screen.findByRole("heading", { name: "Your Space" });
    fireEvent.click(screen.getByRole("button", { name: "Set up my Space" }));
    await screen.findByRole("heading", { name: "Setting up" });
    fireEvent.click(screen.getByRole("button", { name: "Pause setup" }));
    await waitFor(() => expect(api.pauseSetupRun).toHaveBeenCalledWith(run.id));
    fireEvent.click(screen.getByRole("button", { name: "Resume setup" }));
    await waitFor(() => expect(api.resumeSetupRun).toHaveBeenCalledWith(run.id));
    expect(api.startSetupRun).toHaveBeenCalledOnce();
  });
});

it("connects the selected database with an approved choice before starting setup", async () => {
  const api = client(); let checked = false;
  let current = { ...initialDraft, id: "draft:setup-proof", revision: 0, requestedFeatureIds: [...essential, "pane:databases" as SetupFeatureId],
    connectionChoices: [] as Array<{ featureId: SetupFeatureId; modelId?: string }> };
  api.getSetupDraft = vi.fn(async () => current);
  api.saveSetupDraft = vi.fn(async input => { current = { ...current, ...input, revision: current.revision + 1 }; return current; });
  api.createSetupPlan = vi.fn(async revision => ({ ...plan, draftRevision: revision, effectiveFeatureIds: current.requestedFeatureIds,
    requiredHumanInputs: checked ? [] : [{ featureId: "pane:databases" as SetupFeatureId, kind: "API_CREDENTIAL", reasonCode: "DATABASE_CONNECTION_REQUIRED" }] }));
  Object.assign(api, {
    getSetupServiceChoices: vi.fn(async () => ({ choices: [{ id: "spaceapp-internal", label: "SpaceApp database (read-only check)" }] })),
    checkSetupService: vi.fn(async (_feature: string, _revision: number, id: string) => { checked = id === "spaceapp-internal"; return { verified: checked }; })
  });
  render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
  await screen.findByRole("button", { name: "Set up my Space" });
  expect((api as any).getSetupServiceChoices).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Set up my Space" }));
  const target = await screen.findByLabelText("Databases connection");
  expect((target as HTMLSelectElement).value).toBe("spaceapp-internal");
  expect(api.startSetupRun).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Test Databases connection" }));
  await waitFor(() => expect(api.startSetupRun).toHaveBeenCalledOnce());
  expect((api as any).checkSetupService).toHaveBeenCalledWith("pane:databases", current.revision, "spaceapp-internal");
});

it("preserves and checks the connection of Streaming metrics' selected dependency", async () => {
  const api = client(); let checked = false;
  let current = { ...initialDraft, id: "draft:setup-proof", revision: 0, requestedFeatureIds: [...essential, "widget:streaming-metrics" as SetupFeatureId],
    connectionChoices: [{ featureId: "dock:streaming" as SetupFeatureId, modelId: "owned-channel" }] };
  api.getSetupDraft = vi.fn(async () => current);
  api.saveSetupDraft = vi.fn(async input => { current = { ...current, ...input, revision: current.revision + 1 }; return current; });
  api.createSetupPlan = vi.fn(async revision => ({ ...plan, draftRevision: revision,
    effectiveFeatureIds: [...essential, "dock:streaming" as SetupFeatureId, "widget:streaming-metrics" as SetupFeatureId],
    requiredHumanInputs: checked ? [] : [{ featureId: "dock:streaming" as SetupFeatureId, kind: "API_CREDENTIAL", reasonCode: "STREAMING_DESTINATION_REQUIRED" }] }));
  api.getSetupServiceChoices = async () => ({ choices: [{ id: "owned-channel", label: "Owned channel" }] });
  api.checkSetupService = async (_feature, _revision, id) => {
    checked = id === "owned-channel" && current.connectionChoices.some(choice => choice.featureId === "dock:streaming" && choice.modelId === id);
    return { verified: checked };
  };
  render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
  await screen.findByRole("button", { name: "Set up my Space" });
  fireEvent.click(screen.getByRole("button", { name: "Set up my Space" }));
  await screen.findByLabelText("Streaming connection");
  expect(current.connectionChoices).toEqual([{ featureId: "dock:streaming", modelId: "owned-channel" }]);
  fireEvent.click(screen.getByRole("button", { name: "Test Streaming connection" }));
  await screen.findByRole("heading", { name: "Setting up" });
  expect(api.saveSetupDraft).toHaveBeenCalledTimes(1);
});

it("asks before removing Streaming and its dependent metrics, and removes both atomically", async () => {
  const api = client();
  api.getSetupDraft = async () => ({ ...initialDraft, requestedFeatureIds: [...essential, "widget:streaming-metrics"] });
  render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Explore all tools" }));
  expect((screen.getByRole("switch", { name: "Streaming" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("switch", { name: "Streaming" }));
  const confirmation = screen.getByRole("alertdialog");
  expect(confirmation.textContent).toContain("Streaming metrics");
  fireEvent.click(within(confirmation).getByRole("button", { name: "Keep tools" }));
  expect((screen.getByRole("switch", { name: "Streaming metrics" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("switch", { name: "Streaming" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove tools" }));
  expect((screen.getByRole("switch", { name: "Streaming" }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("switch", { name: "Streaming metrics" }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Set up my Space" }));
  await waitFor(() => expect(api.saveSetupDraft).toHaveBeenCalled());
  expect(vi.mocked(api.saveSetupDraft).mock.calls[0]![0].requestedFeatureIds).toEqual(essential);
});
