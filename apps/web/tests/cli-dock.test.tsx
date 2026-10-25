import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliRuntimeSettingsResponse } from "@space/contracts";

const mocks = vi.hoisted(() => ({
  cliRuntimeSettings: vi.fn(),
  cliRuntimeRestart: vi.fn(),
  cliRuntimeRestartAll: vi.fn()
}));

vi.mock("../src/api.js", () => ({ api: mocks }));

import { CliDock } from "../src/features/cli-dock/CliDock.js";

const checkedAt = "2026-08-07T10:00:00.000Z";

const settingsResponse: CliRuntimeSettingsResponse = {
  settings: [
    { runtimeId: "cli:opencode", enabled: true, vpnEnabled: false, updatedAt: checkedAt, updatedBy: "user:admin" },
    { runtimeId: "cli:claude", enabled: false, vpnEnabled: false, updatedAt: checkedAt, updatedBy: "user:admin" },
    { runtimeId: "cli:codex", enabled: true, vpnEnabled: false, updatedAt: checkedAt, updatedBy: "user:admin" }
  ],
  runtimes: [
    {
      id: "cli:opencode",
      providerId: "legacy",
      providerName: "Legacy",
      agentId: "opencode",
      agentName: "OpenCode",
      displayName: "OpenCode",
      capabilities: ["CLI"],
      adapterStatus: "ENABLED",
      authMode: "NONE",
      authState: "READY",
      authReason: "Ready",
      canStartLogin: true,
      status: "ENABLED",
      statusReason: "",
      commandName: "opencode",
      detectedCommandPath: "/var/lib/spaceapp-user/.npm-global/bin/opencode",
      defaultModelId: null,
      supportedReasoningEfforts: [],
      checkedAt
    },
    {
      id: "cli:claude",
      providerId: "legacy",
      providerName: "Claude Code",
      agentId: "claude",
      agentName: "Claude Code",
      displayName: "Claude Code",
      capabilities: ["CLI"],
      adapterStatus: "ENABLED",
      authMode: "NONE",
      authState: "LOGIN_REQUIRED",
      authReason: "Login required",
      canStartLogin: true,
      status: "DISABLED",
      statusReason: "Login required",
      commandName: "claude",
      detectedCommandPath: "/usr/local/bin/claude",
      defaultModelId: null,
      supportedReasoningEfforts: [],
      checkedAt
    },
    {
      id: "cli:codex",
      providerId: "openai",
      providerName: "OpenAI",
      agentId: "codex",
      agentName: "Codex",
      displayName: "Codex",
      capabilities: ["CLI"],
      adapterStatus: "ENABLED",
      authMode: "NONE",
      authState: "READY",
      authReason: "Ready",
      canStartLogin: true,
      status: "ENABLED",
      statusReason: "",
      commandName: "codex",
      detectedCommandPath: "/usr/local/bin/codex",
      defaultModelId: null,
      supportedReasoningEfforts: [],
      checkedAt
    }
  ],
  vpnSupported: true,
  vpnConnection: {
    profileConfigured: false,
    status: "NOT_CONFIGURED",
    endpoint: null,
    dnsServers: [],
    profileFingerprint: null,
    relay: null,
    egressIpv4: null,
    egressIpv6: null,
    lastHandshakeAt: null,
    lastVerifiedAt: null,
    lastVerificationCode: "NOT_CONFIGURED",
    updatedAt: checkedAt
  },
  vpnApplications: [],
  checkedAt
};

function renderDock(overrides: {
  canManage?: boolean;
  warmRoomEnabled?: boolean;
  warmConnectedPaneLimit?: number;
  onWarmConnectedPaneLimitChange?: (limit: number) => void;
  onOpenRestartAll?: () => void;
  restartAllPending?: boolean;
} = {}) {
  return render(
    <CliDock
      canManage={overrides.canManage ?? true}
      cliImagePreviewLimit={3}
      warmRoomEnabled={overrides.warmRoomEnabled ?? false}
      warmConnectedPaneLimit={overrides.warmConnectedPaneLimit ?? 96}
      onCliImagePreviewLimitChange={vi.fn()}
      onWarmRoomEnabledChange={vi.fn()}
      onWarmConnectedPaneLimitChange={overrides.onWarmConnectedPaneLimitChange ?? vi.fn()}
      onOpenRestartAll={overrides.onOpenRestartAll ?? vi.fn()}
      restartAllPending={overrides.restartAllPending ?? false}
    />
  );
}

describe("CliDock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cliRuntimeSettings.mockResolvedValue(settingsResponse);
    mocks.cliRuntimeRestart.mockResolvedValue({
      runtimeId: "cli:opencode",
      requestedSessionIds: ["session:one"],
      restartedSessionIds: ["session:one"],
      replacementSessionIds: ["session:one-r"],
      failedSessionIds: []
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders one compact runtime list without the duplicated restart panel", async () => {
    renderDock();
    fireEvent.click(screen.getByRole("button", { name: "CLI runtimes" }));
    const card = await screen.findByLabelText("CLI runtime visibility settings");
    expect(card.querySelectorAll(".cli-runtime-settings-row")).toHaveLength(17);
    expect(document.querySelector(".cli-dock-runtime-list")).toBeNull();
    expect(document.querySelector(".cli-dock-restart-all")).toBeNull();
    expect(screen.getAllByText("OpenCode CLI")).toHaveLength(1);
    expect(screen.queryByText(/Choose the VPN provider below/i)).toBeNull();
    expect(screen.queryByText(/Managing a profile does not change/i)).toBeNull();
    expect(screen.queryByText(/Private keys stay root-only/i)).toBeNull();

    const opencodeRow = card.querySelector('[data-runtime-id="cli:opencode"]') as HTMLElement;
    const actions = opencodeRow.querySelector(".cli-runtime-settings-actions") as HTMLElement;
    const restartButton = within(actions).getByRole("button", { name: "Restart OpenCode CLI" });
    expect(actions.children).toHaveLength(3);
    expect(restartButton.textContent?.trim()).toBe("");
    expect(restartButton.querySelector(".lucide-recycle")).toBeTruthy();
    expect(within(actions).getAllByRole("switch")).toHaveLength(2);
    expect(actions.querySelectorAll(".space-toggle")).toHaveLength(2);
    expect(actions.querySelector('input[type="checkbox"]:not(.space-toggle input)')).toBeNull();
  });

  it("shows the restart-all control for admins", async () => {
    const onOpenRestartAll = vi.fn();
    renderDock({ onOpenRestartAll });
    fireEvent.click(screen.getByRole("button", { name: "CLI runtimes" }));
    const menu = await screen.findByRole("button", { name: "CLI runtime actions" });
    fireEvent.click(menu);
    fireEvent.click(screen.getByRole("menuitem", { name: "Restart all CLI runtimes" }));
    expect(onOpenRestartAll).toHaveBeenCalledTimes(1);
  });

  it("hides management controls for non-admins", () => {
    renderDock({ canManage: false });
    expect(screen.getByRole("status").textContent).toBe("The ADMIN role can manage CLI runtimes.");
    expect(screen.queryByRole("button", { name: "CLI runtime actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "CLI runtimes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "CLI VPN route" })).toBeNull();
    expect(screen.queryByRole("button", { name: "CLI accounts" })).toBeNull();
    expect(screen.queryByRole("button", { name: "CLI providers" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "T3 Code" })).toBeNull();
    // Personal settings stay available without the ADMIN role.
    expect(screen.getByRole("button", { name: "CLI pane controls" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Git worktrees" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Room cache" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Image previews" })).toBeTruthy();
    expect(mocks.cliRuntimeSettings).not.toHaveBeenCalled();
  });

  it("opens CLI pane controls and shows button preferences", async () => {
    renderDock();
    fireEvent.click(screen.getByRole("button", { name: "CLI pane controls" }));
    expect(await screen.findByRole("region", { name: "CLI pane controls settings" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Right-click menu" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Visible shortcuts" })).toBeTruthy();
  });

  it("does not repeat the dock title the shell header already shows", () => {
    const view = renderDock();
    expect(view.container.querySelector(".cli-dock h2")).toBeNull();
    expect(screen.queryByText("CLI Tools")).toBeNull();
  });

  it("restarts a single runtime after confirmation", async () => {
    renderDock();
    fireEvent.click(screen.getByRole("button", { name: "CLI runtimes" }));
    const card = await screen.findByLabelText("CLI runtime visibility settings");
    const opencodeRow = card.querySelector('[data-runtime-id="cli:opencode"]') as HTMLElement;
    fireEvent.click(within(opencodeRow).getByRole("button", { name: "Restart OpenCode CLI" }));

    const dialog = await screen.findByRole("dialog", { name: /restart opencode cli\?/i });
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart OpenCode CLI" }));

    await waitFor(() => {
      expect(mocks.cliRuntimeRestart).toHaveBeenCalledWith("cli:opencode");
    });
    expect(await screen.findByText(/1 session restarted/i)).toBeTruthy();
  });

  it("disables the restart button for disabled runtimes", async () => {
    renderDock();
    fireEvent.click(screen.getByRole("button", { name: "CLI runtimes" }));
    const card = await screen.findByLabelText("CLI runtime visibility settings");
    const row = card.querySelector('[data-runtime-id="cli:claude"]') as HTMLElement;
    const button = within(row).getByRole("button", { name: "Restart Claude Code CLI" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the moved CLI settings sections visible", async () => {
    renderDock();
    expect(screen.getByRole("button", { name: "CLI runtimes" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download SpaceApp from SpaceApp.dev" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Room cache" }));
    expect(await screen.findByLabelText("Warm room cache settings")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Image previews" }));
    expect(await screen.findByLabelText("CLI photo preview settings")).toBeTruthy();
  });

  it("shows the warm connected pane limit field and applies user changes", async () => {
    const onWarmConnectedPaneLimitChange = vi.fn();
    renderDock({ warmRoomEnabled: true, warmConnectedPaneLimit: 96, onWarmConnectedPaneLimitChange });
    fireEvent.click(screen.getByRole("button", { name: "Room cache" }));
    const warmRoomCard = await screen.findByLabelText("Warm room cache settings");
    const limitInput = within(warmRoomCard).getByRole("spinbutton", {
      name: "Warm connected pane limit"
    });
    expect((limitInput as HTMLInputElement).value).toBe("96");
    expect((limitInput as HTMLInputElement).disabled).toBe(false);
    act(() => {
      fireEvent.change(limitInput, { target: { value: "64" } });
    });
    expect(onWarmConnectedPaneLimitChange).toHaveBeenCalledWith(64);
  });

  it("disables the warm connected pane limit field when the cache is off", async () => {
    renderDock({ warmRoomEnabled: false });
    fireEvent.click(screen.getByRole("button", { name: "Room cache" }));
    const warmRoomCard = await screen.findByLabelText("Warm room cache settings");
    const limitInput = within(warmRoomCard).getByRole("spinbutton", {
      name: "Warm connected pane limit"
    });
    expect((limitInput as HTMLInputElement).disabled).toBe(true);
  });

  it("renders CLI runtimes, CLI VPN route, and CLI accounts as disclosures", async () => {
    renderDock();
    expect(screen.getByRole("button", { name: "CLI runtimes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "CLI VPN route" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "CLI accounts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Room cache" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Image previews" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "CLI VPN route" }));
    expect(await screen.findByLabelText("CLI VPN route settings")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "CLI accounts" }));
    expect(await screen.findByLabelText("CLI account profile settings")).toBeTruthy();
  });
});
