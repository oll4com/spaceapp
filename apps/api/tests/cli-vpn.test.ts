import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentRuntime, CliEgressRouteId, CliToggleRuntimeId, CliVpnConnection, PaneCliSession } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { buildCliProcessLaunch } from "../src/cli-terminal.js";
import type { CliVpnBroker } from "../src/cli-vpn.js";
import { getApiConfig } from "../src/config.js";
import type { DeepSeekHarnessServiceController } from "../src/service-restarts.js";

const sessionSecret = "cli-vpn-test-secret";
const checkedAt = "2026-08-01T09:00:00.000Z";
const apps: FastifyInstance[] = [];
const temporaryRoots: string[] = [];

function authHeaders(role: "OPERATOR" | "ADMIN") {
  const session = signSession(
    { id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role },
    sessionSecret
  );
  return {
    cookie: `space_session=${session}`,
    "x-space-csrf-token": createCsrfToken(session, sessionSecret)!
  };
}

function connection(overrides: Partial<CliVpnConnection> = {}): CliVpnConnection {
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

function broker(overrides: Partial<CliVpnBroker> = {}): CliVpnBroker {
  const greece = connection({ egressIpv4: "216.128.13.68" });
  const thailand = connection({ egressIpv4: "203.0.113.66" });
  const mullvad = connection({ egressIpv4: "198.51.100.91" });
  return {
    status: vi.fn(async () => connection()),
    replace: vi.fn(async () => connection()),
    verify: vi.fn(async () => connection()),
    remove: vi.fn(async () => connection({
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
    replaceProfile: vi.fn(async () => connection()),
    verifyProfile: vi.fn(async () => connection()),
    removeProfile: vi.fn(async () => connection({
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
    rotateMullvadCity: vi.fn(async () => connection({
      relay: {
        hostname: "al-tia-wg-001",
        cityCode: "tia",
        cityName: "Tirana",
        countryCode: "al",
        countryName: "Albania"
      }
    })),
    inspectRuntimes: vi.fn(async (runtimes) => ({
      connection: greece,
      selectedRoute: "direct" as const,
      directEgressIpv4: "78.46.128.16",
      removedProfiles: [],
      profiles: { greece, thailand, mullvad, nord: connection({ egressIpv4: "198.51.100.92" }) },
      runtimes: runtimes.map((runtime) => ({
        runtimeId: runtime.runtimeId,
        routeId: "direct" as const,
        mode: "direct" as const,
        isolatedPids: runtime.pids,
        legacyPids: []
      }))
    })),
    setGlobalRoute: vi.fn(async (routeId, runtimes) => ({
      selectedRoute: routeId,
      directEgressIpv4: "78.46.128.16",
      removedProfiles: [],
      profiles: { greece, thailand, mullvad, nord: connection({ egressIpv4: "198.51.100.92" }) },
      runtimes: runtimes.map((runtime) => ({
        runtimeId: runtime.runtimeId,
        routeId,
        isolatedPids: runtime.pids,
        legacyPids: []
      }))
    })),
    setRuntime: vi.fn(async (_runtimeId, enabled, pids) => ({
      mode: enabled ? "vpn" : "direct",
      isolatedPids: pids,
      legacyPids: [],
      connection: connection()
    })),
    ...overrides
  };
}

function addActiveSession(store: InMemorySpaceStore, runtimeId: CliToggleRuntimeId, suffix: string) {
  const room = store.createRoom({ name: `VPN room ${suffix}`, initialPaneCount: 0 });
  const pane = store.createPane({
    roomId: room.id,
    title: `${suffix} CLI`,
    mode: "TERMINAL",
    terminalRuntimeId: runtimeId,
    cwd: "/etc"
  });
  return store.createPaneCliSession({
    paneId: pane.id,
    roomId: room.id,
    runtimeId,
    providerId: runtimeId.slice(4),
    agentId: runtimeId.slice(4),
    modelId: null,
    reasoningEffort: "medium",
    cwd: "/etc",
    status: "RUNNING",
    statusReason: "test session",
    isActive: true
  });
}

async function setup(options: {
  store?: InMemorySpaceStore;
  vpnBroker?: CliVpnBroker;
  pidResolver?: (sessions: readonly ReturnType<typeof addActiveSession>[]) => Promise<Map<string, number>>;
  sessionRestarter?: (session: PaneCliSession, runtime: AgentRuntime, traceId: string) => Promise<PaneCliSession>;
  harnessEnabled?: boolean;
  harnessController?: DeepSeekHarnessServiceController;
} = {}) {
  const store = options.store ?? new InMemorySpaceStore();
  const commandRoot = await mkdtemp(join(tmpdir(), "space-cli-vpn-test-"));
  temporaryRoots.push(commandRoot);
  const openCodeCommand = join(commandRoot, "opencode-vscode-parity");
  await writeFile(openCodeCommand, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(openCodeCommand, 0o755);
  const app = await createApp({
    store,
    config: getApiConfig({
      SPACE_CLI_ENABLED: "true",
      SPACE_CLI_COMMAND_PATH: commandRoot,
      SPACE_CLI_OPENCODE_CREDENTIAL_SMOKE: "true",
      SPACE_CLI_VPN_ENABLED: "true",
      SPACE_HARNESS_ENABLED: options.harnessEnabled ? "true" : "false",
      SPACE_HARNESS_ORIGIN: "http://127.0.0.1:1"
    }),
    auth: { sessionSecret, devLogin: false, secureCookies: false },
    cliVpnBroker: options.vpnBroker ?? broker(),
    cliVpnSessionPidResolver: options.pidResolver,
    cliVpnSessionRestarter: options.sessionRestarter,
    deepSeekHarnessServiceController: options.harnessController ?? {
      mainPid: vi.fn(async () => null),
      restart: vi.fn(async () => undefined),
      setEnabled: vi.fn(async () => undefined)
    }
  });
  apps.push(app);
  return { app, store };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("CLI VPN API", () => {
  it("exposes, restarts, and routes the namespace-isolated Harness service", async () => {
    let harnessVpnEnabled = false;
    const setRuntime = vi.fn(async (_runtimeId, enabled: boolean, pids: number[]) => {
      harnessVpnEnabled = enabled;
      return {
        mode: enabled ? "vpn" as const : "direct" as const,
        isolatedPids: pids,
        legacyPids: [],
        connection: connection({ egressIpv4: "216.128.13.68" })
      };
    });
    const inspectRuntimes = vi.fn(async (runtimes: Parameters<CliVpnBroker["inspectRuntimes"]>[0]) => {
      const greece = connection({ egressIpv4: "216.128.13.68" });
      const thailand = connection({ egressIpv4: "203.0.113.66" });
      const mullvad = connection({ egressIpv4: "198.51.100.91" });
      const nord = connection({ egressIpv4: "198.51.100.92" });
      return {
        connection: greece,
        selectedRoute: "greece" as const,
        directEgressIpv4: "78.46.128.16",
        removedProfiles: [],
        profiles: { greece, thailand, mullvad, nord },
        runtimes: runtimes.map((runtime) => ({
          runtimeId: runtime.runtimeId,
          routeId: harnessVpnEnabled ? "greece" as const : "direct" as const,
          mode: harnessVpnEnabled ? "vpn" as const : "direct" as const,
          isolatedPids: runtime.pids,
          legacyPids: []
        }))
      };
    });
    let harnessRunning = true;
    const setEnabled = vi.fn(async (enabled: boolean) => { harnessRunning = enabled; });
    const harnessController = {
      mainPid: vi.fn(async () => harnessRunning ? 9101 : null),
      restart: vi.fn(async () => undefined),
      setEnabled
    };
    const vpnBroker = broker({ inspectRuntimes, setRuntime });
    const { app } = await setup({ harnessEnabled: true, harnessController, vpnBroker });
    const headers = authHeaders("ADMIN");

    const settings = await app.inject({ method: "GET", url: "/api/cli/runtime-settings", headers });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().harness).toMatchObject({
      runtimeId: "cli:harness",
      enabled: true,
      vpnEnabled: false,
      effectiveMode: "DIRECT",
      isolated: true,
      pid: 9101
    });

    const routed = await app.inject({
      method: "PATCH",
      url: "/api/admin/harness/vpn",
      headers,
      payload: { enabled: true }
    });
    expect(routed.statusCode).toBe(200);
    expect(setRuntime).toHaveBeenCalledWith("cli:harness", true, [9101]);
    expect(routed.json().status).toMatchObject({ vpnEnabled: true, effectiveMode: "VPN", isolated: true });

    const restarted = await app.inject({ method: "POST", url: "/api/admin/harness/restart", headers, payload: {} });
    expect(restarted.statusCode).toBe(200);
    expect(harnessController.restart).toHaveBeenCalledTimes(1);
    expect(restarted.json().status).toMatchObject({ runtimeId: "cli:harness", isolated: true });

    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/harness/enabled",
      headers,
      payload: { enabled: false }
    });
    expect(disabled.statusCode).toBe(200);
    expect(setEnabled).toHaveBeenLastCalledWith(false);
    expect(disabled.json().status).toMatchObject({ enabled: false, pid: null });

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/harness/enabled",
      headers,
      payload: { enabled: true }
    });
    expect(enabled.statusCode).toBe(200);
    expect(setEnabled).toHaveBeenLastCalledWith(true);
    expect(enabled.json().status).toMatchObject({ enabled: true, pid: 9101 });
  });

  it("keeps CLI Maintenance available when Harness status inspection is temporarily unavailable", async () => {
    const vpnBroker = broker({
      inspectRuntimes: vi.fn(async () => {
        throw new Error("broker unavailable");
      })
    });
    const harnessController = {
      mainPid: vi.fn(async () => {
        throw new Error("systemd unavailable");
      }),
      restart: vi.fn(async () => undefined),
      setEnabled: vi.fn(async () => undefined)
    };
    const { app } = await setup({ harnessEnabled: true, harnessController, vpnBroker });

    const settings = await app.inject({
      method: "GET",
      url: "/api/cli/runtime-settings",
      headers: authHeaders("ADMIN")
    });

    expect(settings.statusCode).toBe(200);
    expect(settings.json().harness).toEqual({
      runtimeId: "cli:harness",
      enabled: false,
      vpnEnabled: false,
      effectiveMode: "BLOCKED",
      isolated: false,
      pid: null
    });
  });

  it("wraps policy CLIs but never wraps the privileged root shell", () => {
    const config = { cliVpnEnabled: true, cliVpnLauncherPath: "/opt/spaceapp/bin/space-cli-vpn-launcher" };
    expect(buildCliProcessLaunch(config, {
      id: "cli:codex",
      detectedCommandPath: "/opt/spaceapp/bin/codex-vscode-parity"
    }, ["resume", "thread-id"])).toEqual({
      command: "/opt/spaceapp/bin/space-cli-vpn-launcher",
      args: ["cli:codex", "resume", "thread-id"]
    });
    expect(buildCliProcessLaunch(config, {
      id: "cli:root",
      detectedCommandPath: "/bin/bash"
    }, [])).toEqual({ command: "/bin/bash", args: [] });
  });

  it("requires ADMIN for profile and per-runtime VPN changes", async () => {
    const { app } = await setup();
    const headers = authHeaders("OPERATOR");
    const status = await app.inject({ method: "GET", url: "/api/cli/vpn", headers });
    const toggle = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:codex/vpn",
      headers,
      payload: { enabled: true }
    });
    const globalRoute = await app.inject({
      method: "PUT",
      url: "/api/cli/egress/route",
      headers,
      payload: { routeId: "greece" }
    });
    const rotateMullvad = await app.inject({
      method: "POST",
      url: "/api/cli/egress/profiles/mullvad/random-city",
      headers,
      payload: {}
    });
    const harnessEnabled = await app.inject({
      method: "PATCH",
      url: "/api/admin/harness/enabled",
      headers,
      payload: { enabled: false }
    });
    expect(status.statusCode).toBe(403);
    expect(toggle.statusCode).toBe(403);
    expect(globalRoute.statusCode).toBe(403);
    expect(rotateMullvad.statusCode).toBe(403);
    expect(harnessEnabled.statusCode).toBe(403);
  });

  it("imports and audits a profile without returning or recording its private configuration", async () => {
    const vpnBroker = broker();
    const { app, store } = await setup({ vpnBroker });
    const privateConfig = `[Interface]\nPrivateKey = ${"A".repeat(64)}\n`;
    const response = await app.inject({
      method: "PUT",
      url: "/api/cli/vpn/profile",
      headers: authHeaders("ADMIN"),
      payload: { config: privateConfig }
    });
    expect(response.statusCode).toBe(200);
    expect(vpnBroker.replace).toHaveBeenCalledWith(privateConfig);
    expect(response.body).not.toContain("PrivateKey");
    expect(JSON.stringify(store.listAuditEvents())).not.toContain(privateConfig);
    expect(store.listAuditEvents()[0]).toMatchObject({
      action: "cli.vpn.profile.replace",
      metadata: { profileFingerprint: "0123456789abcdef" }
    });
  });

  it("keeps Greece, Thailand and Mullvad profile operations separate and redacted", async () => {
    const vpnBroker = broker();
    const { app, store } = await setup({ vpnBroker });
    const privateConfig = `[Interface]\nPrivateKey = ${"T".repeat(64)}\n`;
    const replaced = await app.inject({
      method: "PUT",
      url: "/api/cli/egress/profiles/thailand",
      headers: authHeaders("ADMIN"),
      payload: { config: privateConfig }
    });
    const verified = await app.inject({
      method: "POST",
      url: "/api/cli/egress/profiles/thailand/verify",
      headers: authHeaders("ADMIN"),
      payload: {}
    });

    expect(replaced.statusCode).toBe(200);
    expect(verified.statusCode).toBe(200);
    expect(vpnBroker.replaceProfile).toHaveBeenCalledWith("thailand", privateConfig);
    expect(vpnBroker.verifyProfile).toHaveBeenCalledWith("thailand");
    expect(replaced.body).not.toContain("PrivateKey");
    expect(JSON.stringify(store.listAuditEvents())).not.toContain(privateConfig);
    expect(store.listAuditEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "cli.egress.profile.replace", targetId: "thailand" }),
      expect.objectContaining({ action: "cli.egress.profile.verify", targetId: "thailand" })
    ]));
  });

  it("reports removed VPN profiles so the UI drops them from the menus", async () => {
    const store = new InMemorySpaceStore();
    const vpnBroker = broker({
      inspectRuntimes: vi.fn(async (runtimes) => ({
        connection: connection({ egressIpv4: "216.128.13.68" }),
        selectedRoute: "direct" as const,
        directEgressIpv4: "78.46.128.16",
        removedProfiles: ["thailand"],
        profiles: {
          greece: connection({ egressIpv4: "216.128.13.68" }),
          thailand: connection({ egressIpv4: "203.0.113.66" }),
          mullvad: connection({ egressIpv4: "198.51.100.91" }),
          nord: connection({ egressIpv4: "198.51.100.92" })
        },
        runtimes: []
      }))
    });
    const { app } = await setup({ store, vpnBroker });
    const response = await app.inject({
      method: "GET",
      url: "/api/cli/runtime-settings",
      headers: authHeaders("ADMIN")
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().egress.removedProfiles).toEqual(["thailand"]);
  });

  it("rotates Mullvad only through the fixed city endpoint and audits safe relay metadata", async () => {
    const vpnBroker = broker();
    const { app, store } = await setup({ vpnBroker });
    const rotated = await app.inject({
      method: "POST",
      url: "/api/cli/egress/profiles/mullvad/random-city",
      headers: authHeaders("ADMIN"),
      payload: {}
    });

    expect(rotated.statusCode).toBe(200);
    expect(vpnBroker.rotateMullvadCity).toHaveBeenCalledTimes(1);
    expect(rotated.json()).toMatchObject({ relay: { cityName: "Tirana", countryName: "Albania" } });
    expect(store.listAuditEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "cli.egress.mullvad.city.rotate",
        targetId: "mullvad",
        metadata: expect.objectContaining({ relay: expect.objectContaining({ hostname: "al-tia-wg-001" }) })
      })
    ]));
  });

  it("changes the selected VPN provider without enabling Direct CLI runtimes and restarts affected legacy sessions", async () => {
    const store = new InMemorySpaceStore();
    const isolated = addActiveSession(store, "cli:opencode", "isolated");
    const legacy = addActiveSession(store, "cli:opencode", "legacy");
    await store.updateCliRuntimeVpnSetting("cli:opencode", { enabled: true }, "user:setup");
    const greece = connection({ egressIpv4: "216.128.13.68" });
    const thailand = connection({ egressIpv4: "203.0.113.66" });
    const mullvad = connection({ egressIpv4: "198.51.100.91" });
    let selectedRoute: CliEgressRouteId = "direct";
    const setGlobalRoute = vi.fn(async (routeId: CliEgressRouteId, runtimes: Array<{ runtimeId: CliToggleRuntimeId; pids: number[] }>) => {
      selectedRoute = routeId;
      return {
        selectedRoute: routeId,
        directEgressIpv4: "78.46.128.16",
        removedProfiles: [],
        profiles: { greece, thailand, mullvad, nord: connection({ egressIpv4: "198.51.100.92" }) },
        runtimes: runtimes.map((runtime) => ({
          runtimeId: runtime.runtimeId,
          routeId,
          isolatedPids: runtime.pids.filter((pid) => pid !== 4102),
          legacyPids: runtime.pids.filter((pid) => pid === 4102)
        }))
      };
    });
    const inspectRuntimes = vi.fn(async (runtimes: Array<{ runtimeId: CliToggleRuntimeId; pids: number[] }>) => ({
      connection: greece,
      selectedRoute,
      directEgressIpv4: "78.46.128.16",
      removedProfiles: [],
      profiles: { greece, thailand, mullvad, nord: connection({ egressIpv4: "198.51.100.92" }) },
      runtimes: runtimes.map((runtime) => ({
        runtimeId: runtime.runtimeId,
        routeId: selectedRoute,
        mode: selectedRoute === "direct" ? "direct" as const : "vpn" as const,
        isolatedPids: runtime.pids,
        legacyPids: []
      }))
    }));
    const sessionRestarter = vi.fn(async (session: PaneCliSession) => {
      await store.updatePaneCliSession(session.sessionId, {
        status: "EXITED",
        statusReason: "global egress migration",
        isActive: false,
        endedAt: checkedAt
      }, "req:global-egress");
      return store.createPaneCliSession({
        paneId: session.paneId,
        roomId: session.roomId,
        runtimeId: session.runtimeId,
        providerId: session.providerId,
        agentId: session.agentId,
        modelId: session.modelId,
        reasoningEffort: session.reasoningEffort,
        cwd: session.cwd,
        status: "RUNNING",
        statusReason: "global egress replacement",
        isActive: true
      });
    });
    const { app } = await setup({
      store,
      vpnBroker: broker({ setGlobalRoute, inspectRuntimes }),
      pidResolver: async (sessions) => new Map(sessions.flatMap((session) => {
        if (session.sessionId === isolated.sessionId) return [[session.sessionId, 4101] as const];
        if (session.sessionId === legacy.sessionId) return [[session.sessionId, 4102] as const];
        return [];
      })),
      sessionRestarter
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/cli/egress/route",
      headers: authHeaders("ADMIN"),
      payload: { routeId: "greece" }
    });

    expect(response.statusCode).toBe(200);
    expect(setGlobalRoute).toHaveBeenCalledWith("greece", expect.arrayContaining([
      expect.objectContaining({ runtimeId: "cli:opencode", pids: [4101, 4102] })
    ]));
    expect(sessionRestarter).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: legacy.sessionId }),
      expect.objectContaining({ id: "cli:opencode" }),
      expect.any(String)
    );
    expect(response.json()).toMatchObject({
      status: { selectedRoute: "greece" },
      requestedRestartSessionIds: [legacy.sessionId],
      restartedSessionIds: [legacy.sessionId],
      failedSessionIds: []
    });
    expect(store.getCliRuntimeSetting("cli:opencode").vpnEnabled).toBe(true);
    expect((await store.listCliRuntimeSettings())
      .filter((setting) => setting.runtimeId !== "cli:opencode")
      .every((setting) => setting.vpnEnabled === false)).toBe(true);
  });

  it("does not report database-active sessions without a running host PID as VPN restart failures", async () => {
    const store = new InMemorySpaceStore();
    const running = addActiveSession(store, "cli:opencode", "running-host");
    const stopped = addActiveSession(store, "cli:opencode", "stopped-host");
    await store.updateCliRuntimeVpnSetting("cli:opencode", { enabled: true }, "user:setup");
    const setGlobalRoute = vi.fn(async (routeId: CliEgressRouteId, runtimes: Array<{ runtimeId: CliToggleRuntimeId; pids: number[] }>) => ({
      selectedRoute: routeId,
      directEgressIpv4: "78.46.128.16",
      removedProfiles: [],
      profiles: {
        greece: connection({ egressIpv4: "216.128.13.68" }),
        thailand: connection({ egressIpv4: "203.0.113.66" }),
        mullvad: connection({ egressIpv4: "198.51.100.91" }),
        nord: connection({ egressIpv4: "198.51.100.92" })
      },
      runtimes: runtimes.map((runtime) => ({
        runtimeId: runtime.runtimeId,
        routeId,
        isolatedPids: runtime.pids,
        legacyPids: []
      }))
    }));
    const { app } = await setup({
      store,
      pidResolver: async () => new Map([[running.sessionId, 5101]]),
      vpnBroker: broker({
        setGlobalRoute,
        inspectRuntimes: vi.fn(async (runtimes) => ({
          connection: connection({ egressIpv4: "216.128.13.68" }),
          selectedRoute: "greece" as const,
          directEgressIpv4: "78.46.128.16",
          removedProfiles: [],
          profiles: {
            greece: connection({ egressIpv4: "216.128.13.68" }),
            thailand: connection({ egressIpv4: "203.0.113.66" }),
            mullvad: connection({ egressIpv4: "198.51.100.91" }),
            nord: connection({ egressIpv4: "198.51.100.92" })
          },
          runtimes: runtimes.map((runtime) => ({
            runtimeId: runtime.runtimeId,
            routeId: "greece" as const,
            mode: "vpn" as const,
            isolatedPids: runtime.pids,
            legacyPids: []
          }))
        }))
      })
    });

    const status = await app.inject({
      method: "GET",
      url: "/api/cli/vpn/routing-status",
      headers: authHeaders("OPERATOR")
    });
    expect(status.statusCode).toBe(200);
    const openCodeStatus = status.json().applications.find(
      (application: { runtimeId: string }) => application.runtimeId === "cli:opencode"
    );
    expect(openCodeStatus).toMatchObject({
      runtimeId: "cli:opencode",
      appliedSessionIds: [running.sessionId],
      restartRequiredSessionIds: []
    });

    const switched = await app.inject({
      method: "PUT",
      url: "/api/cli/egress/route",
      headers: authHeaders("ADMIN"),
      payload: { routeId: "greece" }
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({
      requestedRestartSessionIds: [],
      failedSessionIds: []
    });
    expect(setGlobalRoute).toHaveBeenCalledWith("greece", expect.arrayContaining([
      expect.objectContaining({ runtimeId: "cli:opencode", pids: [5101] })
    ]));
    expect((await store.getPaneCliSession(stopped.sessionId))?.isActive).toBe(true);
  });
  it("exposes safe per-session routing and VPN egress to authenticated pane UI", async () => {
    const store = new InMemorySpaceStore();
    const applied = addActiveSession(store, "cli:opencode", "applied");
    await store.updateCliRuntimeVpnSetting("cli:opencode", { enabled: true }, "user:setup");
    const { app } = await setup({
      store,
      pidResolver: async () => new Map([[applied.sessionId, 5101]]),
      vpnBroker: broker({
        inspectRuntimes: vi.fn(async (runtimes) => ({
          connection: connection({
            egressIpv4: "150.228.63.199",
            relay: {
              hostname: "gr-ath-wg-001",
              cityCode: "ath",
              cityName: "Athens",
              countryCode: "gr",
              countryName: "Greece"
            }
          }),
          selectedRoute: "greece" as const,
          directEgressIpv4: "78.46.128.16",
          removedProfiles: [],
          profiles: {
            greece: connection({ egressIpv4: "150.228.63.199" }),
            thailand: connection({ egressIpv4: "203.0.113.66" }),
            mullvad: connection({ egressIpv4: "198.51.100.91" }),
            nord: connection({ egressIpv4: "198.51.100.92" })
          },
          runtimes: runtimes.map((runtime) => ({
            runtimeId: runtime.runtimeId,
            routeId: "greece" as const,
            mode: runtime.runtimeId === "cli:opencode" ? "vpn" as const : "direct" as const,
            isolatedPids: runtime.runtimeId === "cli:opencode" ? runtime.pids : [],
            legacyPids: []
          }))
        }))
      })
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/cli/vpn/routing-status",
      headers: authHeaders("OPERATOR")
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      vpnSupported: true,
      connectionStatus: "CONNECTED",
      egressIpv4: "150.228.63.199",
      relay: {
        hostname: "gr-ath-wg-001",
        cityName: "Athens",
        countryCode: "gr"
      },
      applications: expect.arrayContaining([{
        runtimeId: "cli:opencode",
        effectiveMode: "VPN",
        appliedSessionIds: [applied.sessionId],
        restartRequiredSessionIds: []
      }])
    });
    expect(response.body).not.toContain("profileFingerprint");
    expect(response.body).not.toContain("vpn.example.test");
  });

  it("restarts only revalidated VPN-pending sessions after an explicit ADMIN request", async () => {
    const store = new InMemorySpaceStore();
    const legacy = addActiveSession(store, "cli:opencode", "legacy");
    await store.updateCliRuntimeVpnSetting("cli:opencode", { enabled: true }, "user:setup");
    const pidBySessionId = new Map([[legacy.sessionId, 4101]]);
    const isolatedPids = new Set([5101]);
    const sessionRestarter = vi.fn(async (session: PaneCliSession) => {
      await store.updatePaneCliSession(session.sessionId, {
        status: "EXITED",
        statusReason: "test VPN restart",
        isActive: false,
        endedAt: checkedAt
      }, "req:test-vpn-restart");
      const replacement = await store.createPaneCliSession({
        paneId: session.paneId,
        roomId: session.roomId,
        runtimeId: session.runtimeId,
        providerId: session.providerId,
        agentId: session.agentId,
        modelId: session.modelId,
        reasoningEffort: session.reasoningEffort,
        cwd: session.cwd,
        status: "RUNNING",
        statusReason: "test VPN replacement",
        isActive: true
      });
      pidBySessionId.delete(session.sessionId);
      pidBySessionId.set(replacement.sessionId, 5101);
      return replacement;
    });
    const { app } = await setup({
      store,
      sessionRestarter,
      pidResolver: async (sessions) => new Map(sessions.flatMap((session) => {
        const pid = pidBySessionId.get(session.sessionId);
        return pid ? [[session.sessionId, pid] as const] : [];
      })),
      vpnBroker: broker({
        inspectRuntimes: vi.fn(async (runtimes) => ({
          connection: connection({ egressIpv4: "150.228.63.199" }),
          selectedRoute: "greece" as const,
          directEgressIpv4: "78.46.128.16",
          removedProfiles: [],
          profiles: {
            greece: connection({ egressIpv4: "150.228.63.199" }),
            thailand: connection({ egressIpv4: "203.0.113.66" }),
            mullvad: connection({ egressIpv4: "198.51.100.91" }),
            nord: connection({ egressIpv4: "198.51.100.92" })
          },
          runtimes: runtimes.map((runtime) => ({
            runtimeId: runtime.runtimeId,
            routeId: "greece" as const,
            mode: runtime.runtimeId === "cli:opencode" ? "vpn" as const : "direct" as const,
            isolatedPids: runtime.pids.filter((pid) => isolatedPids.has(pid)),
            legacyPids: runtime.pids.filter((pid) => !isolatedPids.has(pid))
          }))
        }))
      })
    });

    const denied = await app.inject({
      method: "POST",
      url: "/api/cli/runtime-settings/cli:opencode/vpn/restart-required",
      headers: authHeaders("OPERATOR"),
      payload: {}
    });
    expect(denied.statusCode).toBe(403);
    expect(sessionRestarter).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "POST",
      url: "/api/cli/runtime-settings/cli:opencode/vpn/restart-required",
      headers: authHeaders("ADMIN"),
      payload: {}
    });
    expect(response.statusCode).toBe(200);
    expect(sessionRestarter).toHaveBeenCalledTimes(1);
    expect(sessionRestarter).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: legacy.sessionId, runtimeId: "cli:opencode" }),
      expect.objectContaining({ id: "cli:opencode" }),
      expect.any(String)
    );
    expect(response.json()).toMatchObject({
      runtimeId: "cli:opencode",
      requestedSessionIds: [legacy.sessionId],
      restartedSessionIds: [legacy.sessionId],
      replacementSessionIds: [expect.stringMatching(/^cli_session:/)],
      failedSessionIds: [],
      connection: { egressIpv4: "150.228.63.199" },
      application: {
        effectiveMode: "VPN",
        appliedSessionIds: [expect.stringMatching(/^cli_session:/)],
        restartRequiredSessionIds: []
      }
    });
    expect((await store.getPaneCliSession(legacy.sessionId))?.isActive).toBe(false);
  });

  it("preserves the active OpenCode session when its exact native task cannot be resolved", async () => {
    const store = new InMemorySpaceStore();
    const legacy = addActiveSession(store, "cli:opencode", "missing-native-task");
    await store.updateCliRuntimeVpnSetting("cli:opencode", { enabled: true }, "user:setup");
    const { app } = await setup({
      store,
      pidResolver: async () => new Map([[legacy.sessionId, 4101]]),
      vpnBroker: broker({
        inspectRuntimes: vi.fn(async (runtimes) => ({
          connection: connection({ egressIpv4: "150.228.63.199" }),
          selectedRoute: "greece" as const,
          directEgressIpv4: "78.46.128.16",
          removedProfiles: [],
          profiles: {
            greece: connection({ egressIpv4: "150.228.63.199" }),
            thailand: connection({ egressIpv4: "203.0.113.66" }),
            mullvad: connection({ egressIpv4: "198.51.100.91" }),
            nord: connection({ egressIpv4: "198.51.100.92" })
          },
          runtimes: runtimes.map((runtime) => ({
            runtimeId: runtime.runtimeId,
            routeId: "greece" as const,
            mode: runtime.runtimeId === "cli:opencode" ? "vpn" as const : "direct" as const,
            isolatedPids: [],
            legacyPids: runtime.runtimeId === "cli:opencode" ? runtime.pids : []
          }))
        }))
      })
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/cli/runtime-settings/cli:opencode/vpn/restart-required",
      headers: authHeaders("ADMIN"),
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requestedSessionIds: [legacy.sessionId],
      restartedSessionIds: [],
      replacementSessionIds: [],
      failedSessionIds: [legacy.sessionId],
      application: {
        appliedSessionIds: [],
        restartRequiredSessionIds: [legacy.sessionId]
      }
    });
    expect(await store.getPaneCliSession(legacy.sessionId)).toMatchObject({
      status: "RUNNING",
      isActive: true,
      endedAt: null
    });
    expect(await store.listActivePaneCliSessions("cli:opencode")).toHaveLength(1);
  });

  it("changes one CLI to Direct without changing the selected Mullvad provider or other CLI settings", async () => {
    const store = new InMemorySpaceStore();
    const session = addActiveSession(store, "cli:opencode", "per-runtime-toggle");
    await store.updateCliRuntimeVpnSetting("cli:opencode", { enabled: true }, "user:setup");
    const mullvad = connection({
      egressIpv4: "198.51.100.91",
      relay: {
        hostname: "nl-ams-wg-001",
        cityCode: "ams",
        cityName: "Amsterdam",
        countryCode: "nl",
        countryName: "Netherlands"
      }
    });
    const setRuntime = vi.fn(async (_runtimeId: CliToggleRuntimeId, enabled: boolean, pids: number[]) => ({
      mode: enabled ? "vpn" as const : "direct" as const,
      isolatedPids: [],
      legacyPids: pids,
      connection: mullvad
    }));
    const inspectRuntimes = vi.fn(async (runtimes: Array<{ runtimeId: CliToggleRuntimeId; pids: number[] }>) => ({
      connection: mullvad,
      selectedRoute: "mullvad" as const,
      directEgressIpv4: "78.46.128.16",
      removedProfiles: [],
      profiles: {
        greece: connection(),
        thailand: connection(),
        mullvad,
        nord: connection({ egressIpv4: "198.51.100.92" })
      },
      runtimes: runtimes.map((runtime) => ({
        runtimeId: runtime.runtimeId,
        routeId: runtime.runtimeId === "cli:opencode" ? "direct" as const : "mullvad" as const,
        mode: runtime.runtimeId === "cli:opencode" ? "direct" as const : "vpn" as const,
        isolatedPids: [],
        legacyPids: runtime.pids
      }))
    }));
    const sessionRestarter = vi.fn(async (current: PaneCliSession) => {
      await store.updatePaneCliSession(current.sessionId, {
        status: "EXITED",
        statusReason: "per-runtime route change",
        isActive: false,
        endedAt: checkedAt
      }, "req:per-runtime-route");
      return store.createPaneCliSession({
        paneId: current.paneId,
        roomId: current.roomId,
        runtimeId: current.runtimeId,
        providerId: current.providerId,
        agentId: current.agentId,
        modelId: current.modelId,
        reasoningEffort: current.reasoningEffort,
        cwd: current.cwd,
        status: "RUNNING",
        statusReason: "per-runtime route replacement",
        isActive: true
      });
    });
    const vpnBroker = broker({ setRuntime, inspectRuntimes });
    const { app } = await setup({
      store,
      vpnBroker,
      pidResolver: async () => new Map([[session.sessionId, 771]]),
      sessionRestarter
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:opencode/vpn",
      headers: authHeaders("ADMIN"),
      payload: { enabled: false }
    });

    expect(response.statusCode).toBe(200);
    expect(setRuntime).toHaveBeenCalledWith("cli:opencode", false, [771]);
    expect(vpnBroker.setGlobalRoute).not.toHaveBeenCalled();
    expect(sessionRestarter).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: session.sessionId }),
      expect.objectContaining({ id: "cli:opencode" }),
      expect.any(String)
    );
    expect(store.getCliRuntimeSetting("cli:opencode").vpnEnabled).toBe(false);
    expect(store.getCliRuntimeSetting("cli:codex").vpnEnabled).toBe(false);
    expect(response.json()).toMatchObject({
      setting: { runtimeId: "cli:opencode", vpnEnabled: false },
      application: { effectiveMode: "DIRECT" }
    });
  });

  it("restores the previous per-CLI VPN mode when database persistence fails", async () => {
    const store = new InMemorySpaceStore();
    vi.spyOn(store, "updateCliRuntimeVpnSetting").mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });
    const vpnBroker = broker();
    const { app } = await setup({ store, vpnBroker });
    const response = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:codex/vpn",
      headers: authHeaders("ADMIN"),
      payload: { enabled: true }
    });
    expect(response.statusCode).toBe(500);
    expect(vpnBroker.setRuntime).toHaveBeenNthCalledWith(1, "cli:codex", true, expect.any(Array));
    expect(vpnBroker.setRuntime).toHaveBeenNthCalledWith(2, "cli:codex", false, expect.any(Array));
    expect((await store.listCliRuntimeSettings()).every((setting) => setting.vpnEnabled === false)).toBe(true);
  });

  it("keeps the persisted VPN policy when disabling one CLI route fails", async () => {
    const store = new InMemorySpaceStore();
    await store.updateCliRuntimeVpnSetting("cli:codex", { enabled: true }, "user:setup");
    const vpnBroker = broker({
      setRuntime: vi.fn(async () => {
        throw new Error("broker unavailable");
      })
    });
    const { app } = await setup({ store, vpnBroker });
    const response = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:codex/vpn",
      headers: authHeaders("ADMIN"),
      payload: { enabled: false }
    });
    expect(response.statusCode).toBe(500);
    expect(vpnBroker.setRuntime).toHaveBeenCalledWith("cli:codex", false, expect.any(Array));
    expect(store.getCliRuntimeSetting("cli:codex").vpnEnabled).toBe(true);
  });
});
