import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cliToggleRuntimeIds,
  type AgentRuntime,
  type CliAccountProfile,
  type CreateCliAccountProfileInput,
  type UpdateCliAccountProfileInput,
  type CliRuntimeSettingsResponse,
  type CliToggleRuntimeId,
  type CliEgressRouteId,
  type CliVpnConnection,
  type CliVpnProfileId
} from "@space/contracts";
import { CLI_RUNTIME_PRESENTATIONS } from "../src/cli-runtime-presentation.js";
import {
  CLI_RUNTIME_VISIBILITY_EVENT,
  readCliRuntimeVisibilityChange
} from "../src/cli-runtime-visibility-events.js";
import {
  CliRuntimeSettingsCard,
  type CliRuntimeSettingsClient
} from "../src/features/cli-runtime-settings/CliRuntimeSettingsCard.js";
import { SpaceApiError } from "../src/runtime/SpaceRuntime.js";
import { resetCliAccountIdentitiesForTests } from "../src/features/cli-accounts/cli-account-identities.js";
import { writeStoredSuppressNotifications } from "../src/notifications-settings.js";

const checkedAt = "2026-07-22T18:00:00.000Z";

function vpnConnection(overrides: Partial<CliVpnConnection> = {}): CliVpnConnection {
  return {
    profileConfigured: true,
    status: "CONNECTED",
    endpoint: "vpn.example.test:51820",
    dnsServers: ["10.2.0.1"],
    profileFingerprint: "0123456789abcdef",
    relay: null,
    egressIpv4: "198.51.100.8",
    egressIpv6: "2001:db8::8",
    lastHandshakeAt: checkedAt,
    lastVerifiedAt: checkedAt,
    lastVerificationCode: "VERIFIED",
    updatedAt: checkedAt,
    ...overrides
  };
}

function runtime(runtimeId: string, displayName: string): AgentRuntime {
  const setupRequired = runtimeId === "cli:autohand" || runtimeId === "cli:deepseek";
  return {
    id: runtimeId,
    providerId: runtimeId.replace(/^cli:/, ""),
    providerName: displayName,
    agentId: runtimeId.replace(/^cli:/, ""),
    agentName: displayName,
    displayName,
    capabilities: ["CLI"],
    adapterStatus: "ENABLED",
    authMode: setupRequired ? "API_KEY" : "NONE",
    authState: setupRequired ? "SETUP_REQUIRED" : "READY",
    authReason: setupRequired ? `${displayName} setup is required.` : "Credentials are ready.",
    canStartLogin: setupRequired,
    status: setupRequired ? "NOT_CONNECTED" : "ENABLED",
    statusReason: setupRequired ? `${displayName} setup is required.` : `${displayName} is ready.`,
    commandName: runtimeId.replace(/^cli:/, ""),
    detectedCommandPath: `/opt/spaceapp/bin/${runtimeId.replace(/^cli:/, "")}`,
    defaultModelId: null,
    supportedReasoningEfforts: [],
    checkedAt
  };
}

function settingsResponse(
  disabled: CliToggleRuntimeId[] = [],
  selectedRoute: CliEgressRouteId = "direct",
  removedProfiles: CliVpnProfileId[] = []
): CliRuntimeSettingsResponse {
  const vpnEnabled = selectedRoute !== "direct";
  const greece = vpnConnection({ egressIpv4: "216.128.13.68" });
  const thailand = vpnConnection({ egressIpv4: "203.0.113.66" });
  const mullvad = vpnConnection({
    egressIpv4: "198.51.100.91",
    relay: {
      hostname: "al-tia-wg-001",
      cityCode: "tia",
      cityName: "Tirana",
      countryCode: "al",
      countryName: "Albania"
    }
  });
  const nord = vpnConnection({
    egressIpv4: "198.51.100.92",
    relay: {
      hostname: "de1547.nordvpn.com",
      cityCode: "ham",
      cityName: "Hamburg",
      countryCode: "de",
      countryName: "Germany"
    }
  });
  return {
    settings: cliToggleRuntimeIds.map((runtimeId) => ({
      runtimeId,
      enabled: !disabled.includes(runtimeId),
      vpnEnabled,
      updatedAt: checkedAt,
      updatedBy: null
    })),
    runtimes: CLI_RUNTIME_PRESENTATIONS.map(({ id, displayName }) => runtime(id, displayName)),
    vpnSupported: true,
    vpnConnection: vpnConnection(),
    vpnApplications: cliToggleRuntimeIds.map((runtimeId) => ({
      runtimeId,
      effectiveMode: vpnEnabled ? "VPN" : "DIRECT",
      appliedSessionIds: [],
      restartRequiredSessionIds: []
    })),
    egress: {
      supported: true,
      selectedRoute,
      directEgressIpv4: "78.46.128.16",
      removedProfiles,
      profiles: { greece, thailand, mullvad, nord },
      applications: cliToggleRuntimeIds.map((runtimeId) => ({
        runtimeId,
        routeId: selectedRoute,
        appliedSessionIds: [],
        restartRequiredSessionIds: []
      })),
      checkedAt
    },
    harness: {
      runtimeId: "cli:harness",
      enabled: true,
      vpnEnabled,
      effectiveMode: vpnEnabled ? "VPN" : "DIRECT",
      isolated: true,
      pid: 9001
    },
    checkedAt
  };
}

function client(overrides: Partial<CliRuntimeSettingsClient> = {}): CliRuntimeSettingsClient {
  const mainAccountProfile: CliAccountProfile = {
    runtimeId: "cli:gemini",
    profileId: "main",
    displayName: "Main account",
    createdAt: checkedAt,
    updatedAt: checkedAt,
    updatedBy: null
  };
  return {
    cliRuntimeSettings: vi.fn(async () => settingsResponse()),
    cliRuntimeDisablePreview: vi.fn(async (runtimeId) => ({
      runtimeId: runtimeId as CliToggleRuntimeId,
      activeSessionCount: 0,
      openPaneCount: 0,
      activeChatRunCount: 0,
      openChatPaneCount: 0,
      activeRoomAgentMissionCount: 0,
      matchingProcessCount: 0,
      confirmationToken: "preview_token_12345678901234567890",
      expiresAt: "2026-07-22T18:02:00.000Z"
    })),
    cliRuntimeRestart: vi.fn(async (runtimeId) => ({
      runtimeId: runtimeId as CliToggleRuntimeId,
      requestedSessionIds: ["cli_session:one"],
      restartedSessionIds: ["cli_session:one"],
      replacementSessionIds: ["cli_session:replacement"],
      failedSessionIds: []
    })),
    restartHarness: vi.fn(async () => ({ status: settingsResponse().harness! })),
    updateHarnessEnabled: vi.fn(async (input) => ({
      status: {
        ...settingsResponse().harness!,
        enabled: input.enabled,
        pid: input.enabled ? 9001 : null,
        isolated: input.enabled
      }
    })),
    updateCliRuntimeSetting: vi.fn(async (runtimeId, input) => ({
      setting: {
        runtimeId: runtimeId as CliToggleRuntimeId,
        enabled: input.enabled,
        vpnEnabled: false,
        updatedAt: checkedAt,
        updatedBy: "user:admin"
      },
      cleanup: input.enabled ? null : {
        requestedActiveSessionCount: 0,
        requestedOpenPaneCount: 0,
        requestedActiveChatRunCount: 0,
        requestedOpenChatPaneCount: 0,
        requestedRoomAgentMissionCount: 0,
        terminatedSessionIds: [],
        interruptedChatPaneIds: [],
        stoppedRoomAgentMissionIds: [],
        closedPaneIds: [],
        closedChatPaneIds: [],
        unresolvedSessionIds: [],
        unresolvedChatPaneIds: [],
        unresolvedRoomAgentMissionIds: [],
        unresolvedPaneIds: [],
        killedProcessCount: 0,
        remainingProcessCount: 0,
        processSweepFailed: false
      }
    })),
    updateCliGlobalEgress: vi.fn(async (routeId) => ({
      status: settingsResponse([], routeId).egress!,
      requestedRestartSessionIds: [],
      restartedSessionIds: [],
      replacementSessionIds: [],
      failedSessionIds: []
    })),
    replaceCliEgressProfile: vi.fn(async () => vpnConnection()),
    verifyCliEgressProfile: vi.fn(async () => vpnConnection()),
    removeCliEgressProfile: vi.fn(async () => vpnConnection({
      profileConfigured: false,
      status: "NOT_CONFIGURED",
      endpoint: null,
      dnsServers: [],
      profileFingerprint: null,
      egressIpv4: null,
      egressIpv6: null,
      lastHandshakeAt: null,
      lastVerifiedAt: null,
      lastVerificationCode: "NOT_CONFIGURED"
    })),
    rotateCliMullvadCity: vi.fn(async () => vpnConnection({
      relay: {
        hostname: "al-tia-wg-001",
        cityCode: "tia",
        cityName: "Tirana",
        countryCode: "al",
        countryName: "Albania"
      }
    })),
    replaceCliVpnProfile: vi.fn(async () => vpnConnection()),
    verifyCliVpnProfile: vi.fn(async () => vpnConnection()),
    removeCliVpnProfile: vi.fn(async () => vpnConnection({
      profileConfigured: false,
      status: "NOT_CONFIGURED",
      endpoint: null,
      dnsServers: [],
      profileFingerprint: null,
      egressIpv4: null,
      egressIpv6: null,
      lastHandshakeAt: null,
      lastVerifiedAt: null,
      lastVerificationCode: "NOT_CONFIGURED"
    })),
    updateCliRuntimeVpn: vi.fn(async (runtimeId, input) => ({
      setting: {
        runtimeId: runtimeId as CliToggleRuntimeId,
        enabled: true,
        vpnEnabled: input.enabled,
        updatedAt: checkedAt,
        updatedBy: "user:admin"
      },
      connection: vpnConnection(),
      application: {
        effectiveMode: input.enabled ? "VPN" as const : "DIRECT" as const,
        appliedSessionIds: [],
        restartRequiredSessionIds: []
      }
    })),
    updateHarnessVpn: vi.fn(async (input) => ({
      status: {
        ...settingsResponse().harness!,
        vpnEnabled: input.enabled,
        effectiveMode: input.enabled ? "VPN" as const : "DIRECT" as const
      },
      connection: vpnConnection()
    })),
    restartCliRuntimeVpnSessions: vi.fn(async (runtimeId) => ({
      runtimeId: runtimeId as CliToggleRuntimeId,
      requestedSessionIds: [],
      restartedSessionIds: [],
      replacementSessionIds: [],
      failedSessionIds: [],
      connection: vpnConnection(),
      application: {
        effectiveMode: "VPN" as const,
        appliedSessionIds: [],
        restartRequiredSessionIds: []
      }
    })),
    listCliAccountProfiles: vi.fn(async () => ({ profiles: [mainAccountProfile] })),
    createCliAccountProfile: vi.fn(async (input) => ({
      profile: { ...mainAccountProfile, ...input, updatedBy: "user:admin" }
    })),
    updateCliAccountProfile: vi.fn(async (_runtimeId, profileId, input) => ({
      profile: { ...mainAccountProfile, profileId, ...input, updatedBy: "user:admin" }
    })),
    getCliAccountProfileDetails: vi.fn(async (_runtimeId, profileId) => ({
      details: {
        runtimeId: "cli:gemini" as const,
        profileId,
        displayName: mainAccountProfile.displayName,
        email: "space@example.com",
        authStatus: "CONNECTED" as const
      }
    })),
    removeCliAccountProfile: vi.fn(async () => ({ removed: true })),
    invalidateCliRuntimes: vi.fn(),
    invalidateCliRuntimeSettings: vi.fn(),
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  resetCliAccountIdentitiesForTests();
  window.localStorage.removeItem("space.cliVpnProfileManager.profileId");
  vi.restoreAllMocks();
});

describe("CliRuntimeSettingsCard", () => {
  it("adds accounts beyond five and generates a unique profile ID", async () => {
    const profiles: CliAccountProfile[] = [
      {
        runtimeId: "cli:gemini",
        profileId: "main",
        displayName: "Main account",
        createdAt: checkedAt,
        updatedAt: checkedAt,
        updatedBy: null
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        runtimeId: "cli:gemini" as const,
        profileId: index === 0 ? "work-account" : `account-${index + 1}`,
        displayName: index === 0 ? "Work account" : `Account ${index + 1}`,
        createdAt: checkedAt,
        updatedAt: checkedAt,
        updatedBy: null
      }))
    ];
    const createCliAccountProfile = vi.fn(async (input: CreateCliAccountProfileInput) => ({
      profile: { ...profiles[0]!, ...input, updatedBy: "user:admin" }
    }));
    render(<CliRuntimeSettingsCard canManage client={client({
      listCliAccountProfiles: vi.fn(async () => ({ profiles })),
      createCliAccountProfile
    })} />);

    const accounts = await screen.findByLabelText("Gemini account profiles");
    expect(within(accounts).getAllByRole("listitem")).toHaveLength(7);
    fireEvent.click(within(accounts).getByRole("button", { name: "Add account" }));
    // The same account name twice in one CLI is the same account entered again.
    fireEvent.change(within(accounts).getByRole("textbox", { name: /^Account name/ }), {
      target: { value: "work account" }
    });
    fireEvent.click(within(accounts).getByRole("button", { name: "Add account" }));
    expect(await screen.findByText("work account is already a Gemini account.")).toBeTruthy();
    expect(createCliAccountProfile).not.toHaveBeenCalled();

    fireEvent.change(within(accounts).getByRole("textbox", { name: /^Account name/ }), {
      target: { value: "Work-account" }
    });
    fireEvent.click(within(accounts).getByRole("button", { name: "Add account" }));

    await waitFor(() => expect(createCliAccountProfile).toHaveBeenCalledWith({
      runtimeId: "cli:gemini",
      profileId: "work-account-2",
      displayName: "Work-account"
    }));
    expect(within(accounts).getAllByRole("listitem")).toHaveLength(8);
    expect(within(accounts).getByRole("button", { name: "Add account" })).toBeTruthy();
  });

  it("renames main and shows sanitized account details", async () => {
    const updateCliAccountProfile = vi.fn(async (_runtimeId: string, profileId: string, input: UpdateCliAccountProfileInput) => ({
      profile: {
        runtimeId: "cli:gemini" as const,
        profileId,
        displayName: input.displayName,
        createdAt: checkedAt,
        updatedAt: checkedAt,
        updatedBy: "user:admin"
      }
    }));
    const getCliAccountProfileDetails = vi.fn(async () => ({
      details: {
        runtimeId: "cli:gemini" as const,
        profileId: "main",
        displayName: "Personal",
        email: "space@example.com",
        authStatus: "CONNECTED" as const
      }
    }));
    render(<CliRuntimeSettingsCard canManage client={client({ updateCliAccountProfile, getCliAccountProfileDetails })} />);
    const accounts = await screen.findByLabelText("Gemini account profiles");
    fireEvent.click(within(accounts).getByRole("button", { name: "Rename Main account" }));
    fireEvent.change(within(accounts).getByRole("textbox", { name: "New name for Main account" }), { target: { value: "Personal" } });
    fireEvent.click(within(accounts).getByRole("button", { name: "Save account name" }));
    await waitFor(() => expect(updateCliAccountProfile).toHaveBeenCalledWith("cli:gemini", "main", { displayName: "Personal" }));
    expect(within(accounts).getByText("Personal")).toBeTruthy();
    fireEvent.click(within(accounts).getByRole("button", { name: "Show details for Personal" }));
    const details = await screen.findByRole("dialog", { name: "Account details for Personal" });
    expect(within(details).getByText("Google account details")).toBeTruthy();
    await waitFor(() => expect(within(details).getByText("space@example.com")).toBeTruthy());
    expect(within(details).getByText("Connected")).toBeTruthy();
    expect(getCliAccountProfileDetails).toHaveBeenCalledWith("cli:gemini", "main");
  });

  it("manages Claude Code account profiles in their own tab", async () => {
    const claudeMain: CliAccountProfile = {
      runtimeId: "cli:claude",
      profileId: "main",
      displayName: "Main account",
      createdAt: checkedAt,
      updatedAt: checkedAt,
      updatedBy: null
    };
    const listCliAccountProfiles = vi.fn(async (runtimeId: string) => ({
      profiles: runtimeId === "cli:claude" ? [claudeMain] : []
    }));
    const createCliAccountProfile = vi.fn(async (input: CreateCliAccountProfileInput) => ({
      profile: { ...claudeMain, ...input, updatedBy: "user:admin" }
    }));
    const getCliAccountProfileDetails = vi.fn(async () => ({
      details: {
        runtimeId: "cli:claude" as const,
        profileId: "main",
        displayName: "Main account",
        email: "claude@example.com",
        authStatus: "CONNECTED" as const
      }
    }));
    render(<CliRuntimeSettingsCard canManage client={client({
      listCliAccountProfiles,
      createCliAccountProfile,
      getCliAccountProfileDetails
    })} />);

    fireEvent.click(await screen.findByRole("tab", { name: "Claude Code" }));
    const accounts = await screen.findByLabelText("Claude account profiles");
    await waitFor(() => expect(listCliAccountProfiles).toHaveBeenCalledWith("cli:claude"));
    expect(await within(accounts).findByText("Main account")).toBeTruthy();

    fireEvent.click(within(accounts).getByRole("button", { name: "Add account" }));
    fireEvent.change(within(accounts).getByRole("textbox", { name: /^Account name/ }), {
      target: { value: "Work" }
    });
    fireEvent.click(within(accounts).getByRole("button", { name: "Add account" }));
    await waitFor(() => expect(createCliAccountProfile).toHaveBeenCalledWith({
      runtimeId: "cli:claude",
      profileId: "work",
      displayName: "Work"
    }));
    expect(await screen.findByText("Work added. Select it in a Claude Code pane to complete sign-in.")).toBeTruthy();

    fireEvent.click(within(accounts).getByRole("button", { name: "Show details for Main account" }));
    const details = await screen.findByRole("dialog", { name: "Account details for Main account" });
    expect(within(details).getByText("Claude account details")).toBeTruthy();
    await waitFor(() => expect(within(details).getByText("claude@example.com")).toBeTruthy());
    expect(getCliAccountProfileDetails).toHaveBeenCalledWith("cli:claude", "main");
  });

  it("links accounts that share an email and adds accounts from other CLIs with one click", async () => {
    const profileOf = (runtimeId: CliAccountProfile["runtimeId"], profileId: string, displayName = profileId): CliAccountProfile => ({
      runtimeId, profileId, displayName, createdAt: checkedAt, updatedAt: checkedAt, updatedBy: null
    });
    const profilesByRuntime: Record<string, CliAccountProfile[]> = {
      "cli:gemini": [profileOf("cli:gemini", "main", "Main account"), profileOf("cli:gemini", "pir"), profileOf("cli:gemini", "spc")],
      "cli:claude": [profileOf("cli:claude", "ntheo"), profileOf("cli:claude", "lab")],
      "cli:copilot": [profileOf("cli:copilot", "ops")],
      "cli:cursor": []
    };
    const identity = (runtimeId: CliAccountProfile["runtimeId"], profileId: string, email: string | null) => ({
      runtimeId,
      profileId,
      displayName: profilesByRuntime[runtimeId]!.find((profile) => profile.profileId === profileId)?.displayName ?? profileId,
      email,
      authStatus: "CONNECTED" as const
    });
    const cliAccountIdentities = vi.fn(async () => ({
      accounts: [
        identity("cli:gemini", "main", "main@example.test"),
        identity("cli:gemini", "pir", "pir@example.test"),
        identity("cli:gemini", "spc", "MAIN@example.test"),
        identity("cli:claude", "ntheo", "pir@example.test"),
        identity("cli:claude", "lab", "lab@example.test"),
        identity("cli:copilot", "ops", null)
      ],
      checkedAt
    }));
    const createCliAccountProfile = vi.fn(async (input: CreateCliAccountProfileInput) => ({
      profile: profileOf(input.runtimeId, input.profileId, input.displayName)
    }));
    render(<CliRuntimeSettingsCard canManage client={client({
      listCliAccountProfiles: vi.fn(async (runtimeId: string) => ({ profiles: profilesByRuntime[runtimeId] ?? [] })),
      cliAccountIdentities,
      createCliAccountProfile
    })} />);

    const accounts = await screen.findByLabelText("Gemini account profiles");
    const pir = (await within(accounts).findByText("pir")).closest("li")!;
    expect(await within(pir).findByRole("button", { name: "Linked: ntheo in Claude Code" })).toBeTruthy();
    expect(within(pir).getByText("pir@example.test")).toBeTruthy();
    const spc = within(accounts).getByText("spc").closest("li")!;
    expect(within(spc).getByText("Same email as Main account")).toBeTruthy();

    const suggestions = screen.getByLabelText("Accounts from other CLIs to add to Gemini");
    // ntheo already exists here through pir's email; ops has no known email, so only lab is offered.
    expect(within(suggestions).getAllByRole("button").map((button) => button.getAttribute("aria-label")))
      .toEqual(["Add lab to Gemini"]);
    fireEvent.click(within(suggestions).getByRole("button", { name: "Add lab to Gemini" }));
    await waitFor(() => expect(createCliAccountProfile).toHaveBeenCalledWith({
      runtimeId: "cli:gemini",
      profileId: "lab",
      displayName: "lab"
    }));
    expect(await screen.findByText("lab added from Claude Code. Select it in a Gemini pane to sign in once.")).toBeTruthy();

    fireEvent.click(within(pir).getByRole("button", { name: "Linked: ntheo in Claude Code" }));
    expect(await screen.findByLabelText("Claude account profiles")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Claude Code" }).getAttribute("aria-selected")).toBe("true");
  });

  it("rejects visibility events carrying an unknown runtime ID", () => {
    expect(readCliRuntimeVisibilityChange(new CustomEvent(CLI_RUNTIME_VISIBILITY_EVENT, {
      detail: { runtimeId: "cli:unknown", enabled: false, source: "server" }
    }))).toBeNull();
  });

  it("is ADMIN-only and renders CLI runtimes plus the managed Harness service", async () => {
    const settingsClient = client({ cliRuntimeSettings: vi.fn(async () => settingsResponse(["cli:grok"])) });
    const hidden = render(<CliRuntimeSettingsCard canManage={false} client={settingsClient} />);
    expect(screen.queryByLabelText("CLI runtime visibility settings")).toBeNull();
    expect(settingsClient.cliRuntimeSettings).not.toHaveBeenCalled();
    hidden.unmount();

    render(<CliRuntimeSettingsCard canManage client={settingsClient} />);
    const card = await screen.findByLabelText("CLI runtime visibility settings");
    const runtimeList = card.querySelector(".cli-runtime-settings-list") as HTMLElement;
    expect(within(runtimeList).getAllByRole("switch")).toHaveLength(34);
    expect(card.querySelectorAll("img[data-terminal-runtime-brand]")).toHaveLength(17);
    expect(card.querySelectorAll(".cli-runtime-settings-row")).toHaveLength(17);
    expect(card.querySelectorAll(".cli-runtime-settings-badges")).toHaveLength(0);
    expect(card.querySelectorAll(".cli-runtime-settings-copy small")).toHaveLength(0);
    const restartButtons = within(card).getAllByRole("button", { name: /^Restart .* CLI$/ });
    expect(restartButtons).toHaveLength(16);
    expect(within(card).getByRole("button", { name: "Restart DeepSeek Harness" })).toBeTruthy();
    expect(within(card).getByRole("switch", { name: "Use VPN for DeepSeek Harness" })).toBeTruthy();
    expect(within(within(card).getByText("DeepSeek Harness").closest(".cli-runtime-settings-row") as HTMLElement).getByText("VPN")).toBeTruthy();
    expect(within(card).getByRole("switch", { name: "Enable DeepSeek Harness" })).toHaveProperty("checked", true);
    expect(restartButtons.every((button) => button.textContent?.trim() === "")).toBe(true);
    expect(restartButtons.every((button) => button.getAttribute("title") === button.getAttribute("aria-label"))).toBe(true);
    expect(within(card).getByRole("switch", { name: "Enable Autohand Code CLI" })).toHaveProperty("checked", true);
    expect(within(card).queryByText("Hidden")).toBeNull();
    expect(within(card).queryByText("Master")).toBeNull();
    expect(within(card).queryByText("Controls Codex CLI, Chat, Room Agent, and Codex tools globally.")).toBeNull();
    expect(within(card).getByRole("switch", { name: "Enable Grok Build CLI" })).toHaveProperty("checked", false);
  });

  it("renders a cached snapshot immediately while refreshing in the background", async () => {
    const cached = settingsResponse(["cli:grok"]);
    const refreshed = settingsResponse(["cli:qwen"]);
    const refresh = deferred<CliRuntimeSettingsResponse>();
    const loadSettings = vi.fn(() => refresh.promise);
    render(<CliRuntimeSettingsCard canManage client={client({
      cliRuntimeSettingsSnapshot: () => cached,
      cliRuntimeSettings: loadSettings
    })} />);

    expect(screen.getByRole("switch", { name: "Enable Grok Build CLI" })).toHaveProperty("checked", false);
    expect(screen.queryByText("Loading CLI runtime settings…")).toBeNull();
    await waitFor(() => expect(loadSettings).toHaveBeenCalledTimes(1));

    await act(async () => refresh.resolve(refreshed));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Enable Qwen Code CLI" })).toHaveProperty("checked", false));
    expect(screen.getByRole("switch", { name: "Enable Grok Build CLI" })).toHaveProperty("checked", true);
  });

  it("does not paint missing VPN data as off while the first authoritative snapshot loads", async () => {
    const refresh = deferred<CliRuntimeSettingsResponse>();
    const view = render(<CliRuntimeSettingsCard canManage client={client({
      cliRuntimeSettingsSnapshot: () => null,
      cliRuntimeSettings: vi.fn(() => refresh.promise)
    })} />);

    expect(screen.getByRole("status").textContent).toContain("Loading CLI runtime settings");
    expect(view.container.querySelector(".cli-vpn-profile")?.hasAttribute("hidden")).toBe(true);
    expect(view.container.querySelector(".cli-runtime-settings-list")?.hasAttribute("hidden")).toBe(true);
    expect(screen.queryByRole("switch", { name: "Use VPN for OpenCode CLI" })).toBeNull();

    await act(async () => refresh.resolve(settingsResponse([], "mullvad")));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Use VPN for OpenCode CLI" })).toHaveProperty("checked", true));
    expect(screen.queryByText("Loading CLI runtime settings…")).toBeNull();
  });

  it("concentrates restart-all and confirmed per-runtime restart actions in the card", async () => {
    const onOpenRestartAll = vi.fn();
    const restart = vi.fn(async (runtimeId: string) => ({
      runtimeId: runtimeId as CliToggleRuntimeId,
      requestedSessionIds: ["cli_session:one"],
      restartedSessionIds: ["cli_session:one"],
      replacementSessionIds: ["cli_session:replacement"],
      failedSessionIds: []
    }));
    const settingsClient = client({
      cliRuntimeSettings: vi.fn(async () => settingsResponse(["cli:grok"])),
      cliRuntimeRestart: restart
    });
    render(
      <CliRuntimeSettingsCard
        canManage
        client={settingsClient}
        onOpenRestartAll={onOpenRestartAll}
      />
    );

    const card = await screen.findByLabelText("CLI runtime visibility settings");
    fireEvent.click(within(card).getByRole("button", { name: "CLI runtime actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Restart all CLI runtimes" }));
    expect(onOpenRestartAll).toHaveBeenCalledTimes(1);
    expect(within(card).getByRole("button", { name: "Restart Grok Build CLI" })).toHaveProperty("disabled", true);

    fireEvent.click(within(card).getByRole("button", { name: "Restart OpenCode CLI" }));
    const dialog = await screen.findByRole("dialog", { name: "Restart OpenCode CLI?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart OpenCode CLI" }));

    await waitFor(() => expect(restart).toHaveBeenCalledWith("cli:opencode"));
    expect(await screen.findByText("OpenCode CLI: 1 session restarted.")).toBeTruthy();
    expect(settingsClient.invalidateCliRuntimeSettings).toHaveBeenCalled();
  });

  it("restarts Harness and switches its real managed-service VPN route", async () => {
    const before = settingsResponse([], "greece");
    const after = settingsResponse([], "greece");
    after.harness = { ...after.harness!, vpnEnabled: false, effectiveMode: "DIRECT" };
    const restartHarness = vi.fn(async () => ({ status: before.harness! }));
    const updateHarnessVpn = vi.fn(async () => ({
      status: after.harness!,
      connection: after.egress!.profiles.greece
    }));
    const updateHarnessEnabled = vi.fn(async () => ({
      status: { ...after.harness!, enabled: false, isolated: false, pid: null }
    }));
    const loadSettings = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before)
      .mockResolvedValue(after);
    render(<CliRuntimeSettingsCard canManage client={client({
      cliRuntimeSettings: loadSettings,
      restartHarness,
      updateHarnessVpn,
      updateHarnessEnabled
    })} />);

    const row = (await screen.findByText("DeepSeek Harness")).closest(".cli-runtime-settings-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Restart DeepSeek Harness" }));
    await waitFor(() => expect(restartHarness).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Restart DeepSeek Harness?" })).toBeNull();
    expect(await screen.findByText("DeepSeek Harness restarted.")).toBeTruthy();

    fireEvent.click(within(row).getByRole("switch", { name: "Use VPN for DeepSeek Harness" }));
    await waitFor(() => expect(updateHarnessVpn).toHaveBeenCalledWith({ enabled: false }));
    expect(await screen.findByText("DeepSeek Harness now uses Direct network access. Active sessions were restarted when needed.")).toBeTruthy();

    fireEvent.click(within(row).getByRole("switch", { name: "Enable DeepSeek Harness" }));
    await waitFor(() => expect(updateHarnessEnabled).toHaveBeenCalledWith({ enabled: false }));
    expect(await screen.findByText("DeepSeek Harness is now inactive.")).toBeTruthy();
  });

  it("keeps the newest settings response when overlapping refreshes resolve out of order", async () => {
    const first = deferred<CliRuntimeSettingsResponse>();
    const second = deferred<CliRuntimeSettingsResponse>();
    const loadSettings = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<CliRuntimeSettingsCard canManage client={client({ cliRuntimeSettings: loadSettings })} />);

    await waitFor(() => expect(loadSettings).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new CustomEvent(CLI_RUNTIME_VISIBILITY_EVENT, { detail: { source: "server" } })));
    await waitFor(() => expect(loadSettings).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve(settingsResponse(["cli:grok"])));
    const grokToggle = await screen.findByRole("switch", { name: "Enable Grok Build CLI" });
    await waitFor(() => expect(grokToggle).toHaveProperty("checked", false));

    await act(async () => first.resolve(settingsResponse()));
    expect(grokToggle).toHaveProperty("checked", false);
  });

  it("drops removed VPN profiles from the route and profile-manager menus", async () => {
    render(<CliRuntimeSettingsCard canManage client={client({
      cliRuntimeSettings: vi.fn(async () => settingsResponse([], "direct", ["thailand"]))
    })} />);

    const routeSelect = await screen.findByRole("combobox", { name: "VPN route for enabled CLIs" });
    const routeOptions = within(routeSelect).getAllByRole("option").map((option) => option.textContent);
    expect(routeOptions).not.toContain("VPN · Thailand");
    expect(routeOptions).toContain("Direct · Germany");
    expect(routeOptions).toContain("VPN · Greece");
    expect(routeOptions).toContain("VPN · Mullvad");

    const profileManager = screen.getByRole("combobox", { name: "VPN profile to manage" });
    const managerOptions = within(profileManager).getAllByRole("option").map((option) => option.textContent);
    expect(managerOptions).not.toContain("Thailand WireGuard");
    expect(managerOptions).toEqual(["Greece WireGuard", "Mullvad WireGuard", "NordVPN WireGuard"]);
    expect(screen.queryByLabelText("Choose Thailand WireGuard configuration")).toBeNull();
  });

  it("uses one five-choice provider selector and exposes an independent VPN switch for every CLI", async () => {
    const before = settingsResponse();
    const after = settingsResponse([], "greece");
    const loadSettings = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValue(after);
    const updateCliGlobalEgress = vi.fn(async () => ({
      status: after.egress!,
      requestedRestartSessionIds: ["cli_session:legacy"],
      restartedSessionIds: ["cli_session:legacy"],
      replacementSessionIds: ["cli_session:greece"],
      failedSessionIds: []
    }));

    render(<CliRuntimeSettingsCard canManage client={client({
      cliRuntimeSettings: loadSettings,
      updateCliGlobalEgress
    })} />);

    const routeSelect = await screen.findByRole("combobox", { name: "VPN route for enabled CLIs" });
    expect(within(routeSelect).getAllByRole("option")).toHaveLength(5);
    expect(screen.getAllByRole("switch", { name: /Use VPN for/ })).toHaveLength(17);

    fireEvent.change(routeSelect, { target: { value: "greece" } });
    await waitFor(() => expect(updateCliGlobalEgress).toHaveBeenCalledWith("greece"));
    expect(await screen.findByText("VPN · Greece selected for VPN-enabled CLIs; 1 legacy sessions restarted automatically.")).toBeTruthy();

    for (const runtimeId of cliToggleRuntimeIds) {
      const row = document.querySelector<HTMLElement>(`[data-runtime-id="${runtimeId}"]`);
      expect(within(row!).getByRole("switch", { name: /Use VPN for/ })).toHaveProperty("checked", true);
    }
  });

  it("reports global route migration failures while keeping one shared selected route", async () => {
    const before = settingsResponse();
    const after = settingsResponse([], "thailand");
    after.vpnApplications.at(0)!.restartRequiredSessionIds = ["cli_session:failed"];
    const updateCliGlobalEgress = vi.fn(async () => ({
      status: after.egress!,
      requestedRestartSessionIds: ["cli_session:failed"],
      restartedSessionIds: [],
      replacementSessionIds: [],
      failedSessionIds: ["cli_session:failed"]
    }));
    render(<CliRuntimeSettingsCard canManage client={client({
      cliRuntimeSettings: vi.fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValue(after),
      updateCliGlobalEgress
    })} />);

    fireEvent.change(await screen.findByRole("combobox", { name: "VPN route for enabled CLIs" }), { target: { value: "thailand" } });
    await waitFor(() => expect(updateCliGlobalEgress).toHaveBeenCalledWith("thailand"));
    expect(await screen.findByText("VPN · Thailand selected for VPN-enabled CLIs; 1 legacy sessions could not restart.")).toBeTruthy();
    expect(screen.queryByText("Restart failed (1)")).toBeNull();
  });

  it("changes the VPN route for one CLI without changing other CLI switches", async () => {
    const before = settingsResponse([], "mullvad");
    const after = settingsResponse([], "mullvad");
    after.settings = after.settings.map((setting) => setting.runtimeId === "cli:opencode"
      ? { ...setting, vpnEnabled: false }
      : setting);
    const updateCliRuntimeVpn = vi.fn(async () => ({
      setting: after.settings.find((setting) => setting.runtimeId === "cli:opencode")!,
      connection: after.egress!.profiles.mullvad,
      application: {
        effectiveMode: "DIRECT" as const,
        appliedSessionIds: [],
        restartRequiredSessionIds: []
      }
    }));
    const backgroundRefresh = deferred<CliRuntimeSettingsResponse>();
    const loadSettings = vi.fn()
      .mockResolvedValueOnce(before)
      .mockReturnValueOnce(backgroundRefresh.promise);
    render(<CliRuntimeSettingsCard canManage client={client({
      cliRuntimeSettings: loadSettings,
      updateCliRuntimeVpn
    })} />);

    const opencodeVpn = await screen.findByRole("switch", { name: "Use VPN for OpenCode CLI" });
    const codexVpn = screen.getByRole("switch", { name: "Use VPN for Codex CLI" });
    expect(opencodeVpn).toHaveProperty("checked", true);
    expect(codexVpn).toHaveProperty("checked", true);

    fireEvent.click(opencodeVpn);
    await waitFor(() => expect(updateCliRuntimeVpn).toHaveBeenCalledWith("cli:opencode", { enabled: false }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Use VPN for OpenCode CLI" })).toHaveProperty("checked", false));
    expect(screen.getByRole("switch", { name: "Use VPN for Codex CLI" })).toHaveProperty("checked", true);
    expect(await screen.findByText("OpenCode CLI now uses Direct network access. Active sessions were restarted when needed.")).toBeTruthy();
    expect(loadSettings).toHaveBeenCalledTimes(2);

    await act(async () => backgroundRefresh.resolve(after));
  });

  it("manages one separately selected root-only WireGuard profile without changing global egress", async () => {
    const replaceCliEgressProfile = vi.fn(async () => vpnConnection({ egressIpv4: "203.0.113.66" }));
    const verifyCliEgressProfile = vi.fn(async () => vpnConnection({ egressIpv4: "203.0.113.66" }));
    render(<CliRuntimeSettingsCard canManage client={client({
      replaceCliEgressProfile,
      verifyCliEgressProfile
    })} />);

    const profileManager = await screen.findByRole("combobox", { name: "VPN profile to manage" });
    fireEvent.change(profileManager, { target: { value: "thailand" } });
    const thailandInput = await screen.findByLabelText("Choose Thailand WireGuard configuration");
    const profileConfig = `[Interface]\nPrivateKey = ${"A".repeat(48)}\n[Peer]\nPublicKey = ${"B".repeat(48)}\n`;
    const profileFile = {
      name: "thai.conf",
      size: profileConfig.length,
      text: vi.fn(async () => profileConfig)
    } as unknown as File;
    fireEvent.change(thailandInput, {
      target: { files: [profileFile] }
    });
    await waitFor(() => expect(replaceCliEgressProfile).toHaveBeenCalledWith("thailand", profileConfig));
    expect(await screen.findByText("Thailand WireGuard profile imported and verified.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Thailand WireGuard actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Verify profile" }));
    await waitFor(() => expect(verifyCliEgressProfile).toHaveBeenCalledWith("thailand"));
    expect(screen.queryByLabelText("Choose Greece WireGuard configuration")).toBeNull();
    expect(screen.queryByLabelText("Choose Mullvad WireGuard configuration")).toBeNull();
  });

  it("shows Mullvad city and protects the active profile from removal until Direct is selected", async () => {
    const removeCliEgressProfile = vi.fn(async () => vpnConnection());
    const rotateCliMullvadCity = vi.fn(async () => vpnConnection({
      egressIpv4: "198.51.100.92",
      relay: {
        hostname: "se-sto-wg-002",
        cityCode: "sto",
        cityName: "Stockholm",
        countryCode: "se",
        countryName: "Sweden"
      }
    }));
    render(<CliRuntimeSettingsCard canManage client={client({
      cliRuntimeSettings: vi.fn(async () => settingsResponse([], "mullvad")),
      removeCliEgressProfile,
      rotateCliMullvadCity
    })} />);

    const profileManager = await screen.findByRole("combobox", { name: "VPN profile to manage" });
    fireEvent.change(profileManager, { target: { value: "mullvad" } });
    expect(await screen.findByText("Tirana")).toBeTruthy();
    expect(screen.getByText("Albania")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mullvad WireGuard actions" }));
    expect(screen.getByRole("menuitem", { name: "Remove profile" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Select Direct before removing the currently active profile.")).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Change Mullvad city" }));
    await waitFor(() => expect(rotateCliMullvadCity).toHaveBeenCalledTimes(1));
    expect(removeCliEgressProfile).not.toHaveBeenCalled();
    // The new location is sensitive; the notice keeps it maskable.
    const feedback = await screen.findByText(/Mullvad changed to Stockholm, Sweden/);
    expect(feedback.getAttribute("data-sensitive-masked")).toBe("manual");
    expect(feedback.closest(".dock-kit-notice.is-success")).toBeTruthy();
  });

  it("survives the ADMIN role arriving after the first render", async () => {
    const settingsClient = client();
    const view = render(<CliRuntimeSettingsCard canManage={false} client={settingsClient} />);
    expect(view.container.innerHTML).toBe("");
    view.rerender(<CliRuntimeSettingsCard canManage client={settingsClient} />);
    const card = await screen.findByLabelText("CLI runtime visibility settings");
    await waitFor(() => expect(card.querySelectorAll(".cli-runtime-settings-row")).toHaveLength(17));
  });

  it("offers Try again instead of loading forever when the first load fails", async () => {
    const loadSettings = vi.fn()
      .mockRejectedValueOnce(new Error("Settings service unavailable."))
      .mockResolvedValue(settingsResponse());
    render(<CliRuntimeSettingsCard canManage client={client({ cliRuntimeSettings: loadSettings })} />);
    const failure = await screen.findByRole("alert");
    expect(failure.textContent).toContain("CLI runtime settings could not be loaded");
    expect(failure.textContent).toContain("Settings service unavailable.");
    expect(screen.queryByText("Loading CLI runtime settings…")).toBeNull();
    fireEvent.click(within(failure).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("switch", { name: "Enable OpenCode CLI" })).toBeTruthy();
    expect(loadSettings).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows readable VPN states instead of raw status codes", async () => {
    const response = settingsResponse([], "direct");
    response.egress!.profiles.greece = vpnConnection({ profileConfigured: false, status: "NOT_CONFIGURED", egressIpv4: null });
    const view = render(<CliRuntimeSettingsCard canManage client={client({ cliRuntimeSettings: vi.fn(async () => response) })} />);
    await screen.findByRole("combobox", { name: "VPN profile to manage" });
    expect(view.container.querySelector(".cli-vpn-health")?.textContent).toBe("Direct");
    expect(screen.getByText("Not set up")).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/NOT_CONFIGURED|\bDIRECT\b|\bCONNECTED\b/);
  });

  it("shows a failed restart as a dismissible error notice", async () => {
    render(<CliRuntimeSettingsCard canManage client={client({ cliRuntimeRestart: vi.fn(async () => { throw new Error("Pane host is busy."); }) })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Restart OpenCode CLI" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Restart OpenCode CLI?" })).getByRole("button", { name: "Restart OpenCode CLI" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Pane host is busy.");
    expect(alert.classList.contains("dock-kit-notice")).toBe(true);
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("says how many closed panes an enable reopens", async () => {
    const settingsClient = client({
      cliRuntimeSettings: vi.fn(async () => settingsResponse(["cli:deepseek"])),
      updateCliRuntimeSetting: vi.fn(async (runtimeId, input) => ({
        setting: { runtimeId: runtimeId as CliToggleRuntimeId, enabled: input.enabled, vpnEnabled: false, updatedAt: checkedAt, updatedBy: "user:admin" },
        cleanup: null,
        restoredPaneIds: ["pane:restoredOne", "pane:restoredTwo"]
      }))
    });
    render(<CliRuntimeSettingsCard canManage client={settingsClient} />);

    fireEvent.click(await screen.findByRole("switch", { name: "Enable DeepSeek CLI" }));
    expect(await screen.findByText("DeepSeek CLI is now enabled. Reopening 2 panes it closed.")).toBeTruthy();
  });

  it("requires a preview and explicit confirmation even when no sessions or panes are affected", async () => {
    const settingsClient = client();
    const visibilityEvents: unknown[] = [];
    const listener = (event: Event) => visibilityEvents.push((event as CustomEvent).detail);
    window.addEventListener(CLI_RUNTIME_VISIBILITY_EVENT, listener);
    render(<CliRuntimeSettingsCard canManage client={settingsClient} />);

    const toggle = await screen.findByRole("switch", { name: "Enable DeepSeek CLI" });
    fireEvent.click(toggle);
    const dialog = await screen.findByRole("dialog", { name: "Disable DeepSeek CLI?" });
    expect(dialog.textContent).toContain("0 active sessions will stop and 0 open panes will close");
    expect(settingsClient.updateCliRuntimeSetting).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Disable DeepSeek CLI" }));
    await waitFor(() => expect(settingsClient.updateCliRuntimeSetting).toHaveBeenCalledWith("cli:deepseek", {
      enabled: false,
      confirmationToken: "preview_token_12345678901234567890"
    }));
    expect(settingsClient.invalidateCliRuntimes).toHaveBeenCalledTimes(1);
    expect(visibilityEvents).toContainEqual({ runtimeId: "cli:deepseek", enabled: false, source: "settings-card" });
    expect(await screen.findByText("DeepSeek CLI is now disabled.")).toBeTruthy();
    expect(toggle).toHaveProperty("checked", false);
    window.removeEventListener(CLI_RUNTIME_VISIBILITY_EVENT, listener);
  });

  it("replaces stale confirmation counts and token without disabling until the new impact is confirmed", async () => {
    const freshPreview = {
      runtimeId: "cli:deepseek" as const,
      activeSessionCount: 2,
      openPaneCount: 3,
      activeChatRunCount: 0,
      openChatPaneCount: 0,
      activeRoomAgentMissionCount: 0,
      confirmationToken: "fresh_preview_token_12345678901234",
      expiresAt: "2026-07-22T18:03:00.000Z"
    };
    const update = vi.fn()
      .mockRejectedValueOnce(new SpaceApiError("Impact changed", {
        status: 409,
        code: "CLI_RUNTIME_DISABLE_CONFIRMATION_STALE",
        details: freshPreview
      }))
      .mockResolvedValueOnce({
        setting: { runtimeId: "cli:deepseek", enabled: false, vpnEnabled: false, updatedAt: checkedAt, updatedBy: "user:admin" },
        cleanup: {
          requestedActiveSessionCount: 2,
          requestedOpenPaneCount: 3,
          requestedActiveChatRunCount: 0,
          requestedOpenChatPaneCount: 0,
          requestedRoomAgentMissionCount: 0,
          terminatedSessionIds: ["cli_session:one", "cli_session:two"],
          interruptedChatPaneIds: [],
          stoppedRoomAgentMissionIds: [],
          closedPaneIds: ["pane:one", "pane:two", "pane:three"],
          closedChatPaneIds: [],
          unresolvedSessionIds: [],
          unresolvedChatPaneIds: [],
          unresolvedRoomAgentMissionIds: [],
          unresolvedPaneIds: []
        }
      });
    const settingsClient = client({ updateCliRuntimeSetting: update });
    render(<CliRuntimeSettingsCard canManage client={settingsClient} />);

    fireEvent.click(await screen.findByRole("switch", { name: "Enable DeepSeek CLI" }));
    let dialog = await screen.findByRole("dialog", { name: "Disable DeepSeek CLI?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable DeepSeek CLI" }));

    expect(await within(dialog).findByText("The impact changed. Review the updated counts and confirm again.")).toBeTruthy();
    expect(dialog.textContent).toContain("2 active sessions will stop and 3 open panes will close");
    expect(screen.getByRole("switch", { name: "Enable DeepSeek CLI" })).toHaveProperty("checked", true);

    // Open panes need their own confirmation before Disable is available.
    const disable = within(dialog).getByRole("button", { name: "Disable DeepSeek CLI" });
    expect(disable).toHaveProperty("disabled", true);
    fireEvent.click(within(dialog).getByRole("switch", { name: "Close 3 open panes and stop their work" }));
    expect(disable).toHaveProperty("disabled", false);
    fireEvent.click(disable);
    await waitFor(() => expect(update).toHaveBeenLastCalledWith("cli:deepseek", {
      enabled: false,
      confirmationToken: freshPreview.confirmationToken
    }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Disable DeepSeek CLI?" })).toBeNull());
  });

  it("rejects malformed stale confirmation details instead of trusting partial preview fields", async () => {
    const update = vi.fn().mockRejectedValue(new SpaceApiError("Impact changed", {
      status: 409,
      code: "CLI_RUNTIME_DISABLE_CONFIRMATION_STALE",
      details: {
        runtimeId: "cli:deepseek",
        activeSessionCount: -1,
        openPaneCount: 0,
        activeChatRunCount: 0,
        openChatPaneCount: 0,
        activeRoomAgentMissionCount: 0,
        confirmationToken: "short",
        expiresAt: "not-an-iso-date"
      }
    }));
    render(<CliRuntimeSettingsCard canManage client={client({ updateCliRuntimeSetting: update })} />);

    fireEvent.click(await screen.findByRole("switch", { name: "Enable DeepSeek CLI" }));
    const dialog = await screen.findByRole("dialog", { name: "Disable DeepSeek CLI?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable DeepSeek CLI" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("Impact changed");
    expect(dialog.textContent).toContain("0 active sessions will stop and 0 open panes will close");
    expect(within(dialog).queryByText("The impact changed. Review the updated counts and confirm again.")).toBeNull();
  });

  it("rejects a schema-valid stale preview for a different runtime", async () => {
    const update = vi.fn().mockRejectedValue(new SpaceApiError("Impact changed", {
      status: 409,
      code: "CLI_RUNTIME_DISABLE_CONFIRMATION_STALE",
      details: {
        runtimeId: "cli:grok",
        activeSessionCount: 1,
        openPaneCount: 1,
        activeChatRunCount: 0,
        openChatPaneCount: 0,
        activeRoomAgentMissionCount: 0,
        confirmationToken: "grok_preview_token_12345678901234",
        expiresAt: "2026-07-22T18:03:00.000Z"
      }
    }));
    render(<CliRuntimeSettingsCard canManage client={client({ updateCliRuntimeSetting: update })} />);

    fireEvent.click(await screen.findByRole("switch", { name: "Enable DeepSeek CLI" }));
    const dialog = await screen.findByRole("dialog", { name: "Disable DeepSeek CLI?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable DeepSeek CLI" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("Impact changed");
    expect(dialog.textContent).toContain("0 active sessions will stop and 0 open panes will close");
    expect(within(dialog).queryByText("The impact changed. Review the updated counts and confirm again.")).toBeNull();
  });

  it("traps dialog focus, restores the toggle on cancel, and uses a bounded mobile sheet", async () => {
    render(<CliRuntimeSettingsCard canManage client={client()} />);
    const toggle = await screen.findByRole("switch", { name: "Enable DeepSeek CLI" });
    fireEvent.click(toggle);
    const dialog = await screen.findByRole("dialog", { name: "Disable DeepSeek CLI?" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const confirm = within(dialog).getByRole("button", { name: "Disable DeepSeek CLI" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(cancel);
    await act(async () => window.requestAnimationFrame(() => undefined));
    await waitFor(() => expect(document.activeElement).toBe(toggle));

    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toMatch(/@media \(max-width: 480px\)[\s\S]*\.cli-runtime-disable-backdrop\s*\{[^}]*align-items:\s*end/);
    expect(styles).toMatch(/\.cli-runtime-disable-dialog\s*\{[^}]*max-height:\s*calc\(100dvh - 2rem\)/s);
  });

  it("previews every Codex master cleanup category and reports partial cleanup", async () => {
    const settingsClient = client({
      cliRuntimeDisablePreview: vi.fn(async () => ({
        runtimeId: "cli:codex" as const,
        activeSessionCount: 1,
        openPaneCount: 2,
        activeChatRunCount: 3,
        openChatPaneCount: 4,
        activeRoomAgentMissionCount: 5,
        matchingProcessCount: 6,
        confirmationToken: "codex_preview_token_12345678901234",
        expiresAt: "2026-07-22T18:03:00.000Z"
      })),
      updateCliRuntimeSetting: vi.fn(async () => ({
        setting: {
          runtimeId: "cli:codex" as const,
          enabled: false,
          vpnEnabled: false,
          updatedAt: checkedAt,
          updatedBy: "user:admin"
        },
        cleanup: {
          requestedActiveSessionCount: 1,
          requestedOpenPaneCount: 2,
          requestedActiveChatRunCount: 3,
          requestedOpenChatPaneCount: 4,
          requestedRoomAgentMissionCount: 5,
          terminatedSessionIds: [],
          interruptedChatPaneIds: [],
          stoppedRoomAgentMissionIds: [],
          closedPaneIds: [],
          closedChatPaneIds: [],
          unresolvedSessionIds: ["cli_session:one"],
          unresolvedChatPaneIds: ["pane:chat"],
          unresolvedRoomAgentMissionIds: ["mission:one"],
          unresolvedPaneIds: ["pane:cli"],
          killedProcessCount: 2,
          remainingProcessCount: 1,
          processSweepFailed: false
        }
      }))
    });
    render(<CliRuntimeSettingsCard canManage client={settingsClient} />);

    fireEvent.click(await screen.findByRole("switch", { name: "Enable Codex CLI" }));
    const dialog = await screen.findByRole("dialog", { name: "Disable Codex CLI?" });
    expect(dialog.textContent).toContain("1 active Codex CLI session will stop");
    expect(dialog.textContent).toContain("2 open Codex CLI panes will close");
    expect(dialog.textContent).toContain("3 active native Chat runs will stop");
    expect(dialog.textContent).toContain("4 open Chat panes will close");
    expect(dialog.textContent).toContain("5 active Room Agent missions will stop");
    expect(dialog.textContent).toContain("6 running Codex processes will be terminated");

    fireEvent.click(within(dialog).getByRole("switch", { name: "Close 6 open panes and stop their work" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable Codex CLI" }));
    expect(await screen.findByText(/cleanup remains unresolved: 1 CLI sessions, 1 panes, 1 Chat runs\/panes, and 1 Room Agent missions/)).toBeTruthy();
  });

  it("remembers the selected VPN profile to manage across reloads", async () => {
    const settingsClient = client();
    const first = render(<CliRuntimeSettingsCard canManage client={settingsClient} />);
    const profileManager = await screen.findByRole("combobox", { name: "VPN profile to manage" });
    expect(profileManager).toHaveProperty("value", "greece");

    fireEvent.change(profileManager, { target: { value: "mullvad" } });
    expect(window.localStorage.getItem("space.cliVpnProfileManager.profileId")).toBe("mullvad");
    first.unmount();

    render(<CliRuntimeSettingsCard canManage client={settingsClient} />);
    expect(await screen.findByRole("combobox", { name: "VPN profile to manage" }))
      .toHaveProperty("value", "mullvad");
  });

  it("falls back from a remembered profile that was later removed", async () => {
    window.localStorage.setItem("space.cliVpnProfileManager.profileId", "thailand");
    render(<CliRuntimeSettingsCard canManage client={client({
      cliRuntimeSettings: vi.fn(async () => settingsResponse([], "direct", ["thailand"]))
    })} />);

    const profileManager = await screen.findByRole("combobox", { name: "VPN profile to manage" });
    expect(profileManager).toHaveProperty("value", "greece");
    expect(within(profileManager).getAllByRole("option").map((option) => option.textContent))
      .toEqual(["Greece WireGuard", "Mullvad WireGuard", "NordVPN WireGuard"]);
    await waitFor(() => expect(window.localStorage.getItem("space.cliVpnProfileManager.profileId")).toBe("greece"));
  });

  it("suppresses feedback notices when suppressNotifications is enabled", async () => {
    writeStoredSuppressNotifications(true);
    const settingsClient = client();
    try {
      render(<CliRuntimeSettingsCard canManage client={settingsClient} />);
      const toggle = await screen.findByRole("switch", { name: "Enable DeepSeek CLI" });
      fireEvent.click(toggle);
      const dialog = await screen.findByRole("dialog", { name: "Disable DeepSeek CLI?" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Disable DeepSeek CLI" }));
      await waitFor(() => expect(settingsClient.updateCliRuntimeSetting).toHaveBeenCalledWith("cli:deepseek", {
        enabled: false,
        confirmationToken: "preview_token_12345678901234567890"
      }));
      expect(screen.queryByText("DeepSeek CLI is now disabled.")).toBeNull();
    } finally {
      writeStoredSuppressNotifications(false);
    }
  });
});
