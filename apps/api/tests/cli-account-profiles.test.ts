import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import type { GatewayAdminService } from "../src/gateway/gateway-service.js";

const sessionSecret = "cli-account-profiles-test-secret";
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

async function setup(extraEnv: NodeJS.ProcessEnv = {}, gatewayAdminService?: GatewayAdminService) {
  const store = new InMemorySpaceStore();
  const removedProfileIds: string[] = [];
  const readProfileIds: string[] = [];
  const commandRoot = await mkdtemp(join(tmpdir(), "space-cli-account-profiles-"));
  temporaryRoots.push(commandRoot);
  const geminiCommand = join(commandRoot, "gemini-vscode-parity");
  await writeFile(geminiCommand, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(geminiCommand, 0o755);
  const copilotCommand = join(commandRoot, "copilot-vscode-parity");
  await writeFile(copilotCommand, "#!/bin/sh\ncase \"$1\" in profile-info) printf '%s\\n' '{\"authStatus\":\"CONNECTED\",\"email\":null,\"login\":\"octo-cat\"}' ;; "
    + "usage-info) if [ \"$2\" = work ]; then r=80; else r=20; fi; printf '{\"status\":\"OK\",\"plan\":null,\"remainingPercent\":%s,\"resetAt\":null,\"windows\":[]}\\n' \"$r\" ;; "
    + "credential-status) printf 'READY\\n' ;; remove-profile) exit 0 ;; *) exit 0 ;; esac\n", "utf8");
  await chmod(copilotCommand, 0o755);
  const claudeCommand = join(commandRoot, "claude-vscode-parity");
  await writeFile(claudeCommand, "#!/bin/sh\ncase \"$1\" in profile-info) printf '%s\\n' '{\"authStatus\":\"CONNECTED\",\"email\":\"claude@example.com\"}' ;; remove-profile) exit 0 ;; *) exit 0 ;; esac\n", "utf8");
  await chmod(claudeCommand, 0o755);
  const app = await createApp({
    store,
    config: getApiConfig({ SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: commandRoot, ...extraEnv }),
    removeGeminiAccountProfileState: async (profileId) => { removedProfileIds.push(profileId); },
    readGeminiAccountProfileDetails: async (profileId) => {
      readProfileIds.push(profileId);
      return { authStatus: "CONNECTED", email: `${profileId}@example.com` };
    },
    auth: { sessionSecret, devLogin: false, secureCookies: false },
    ...(gatewayAdminService ? { gatewayAdminService } : {})
  });
  apps.push(app);
  store.createCliAccountProfile(
    "cli:gemini",
    { runtimeId: "cli:gemini", profileId: "main", displayName: "Main account" },
    "user:admin"
  );
  return { app, store, removedProfileIds, readProfileIds };
}

// Closing an app with a configured CLI command path waits several seconds for runtime probes.
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}, 30_000);

describe("CLI account profiles API", () => {
  it("requires ADMIN and exposes only Gemini profiles", async () => {
    const { app } = await setup();
    const denied = await app.inject({
      method: "GET",
      url: "/api/cli/runtimes/cli:gemini/account-profiles",
      headers: authHeaders("OPERATOR")
    });
    expect(denied.statusCode).toBe(403);
    const wrongRuntime = await app.inject({
      method: "GET",
      url: "/api/cli/runtimes/cli:codex/account-profiles",
      headers: authHeaders("ADMIN")
    });
    expect(wrongRuntime.statusCode).toBe(409);
  });

  it("stores and lists more than five profiles without a fixed cap", async () => {
    const { app } = await setup();
    for (let index = 1; index <= 12; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/cli/runtimes/cli:gemini/account-profiles",
        headers: authHeaders("ADMIN"),
        payload: {
          runtimeId: "cli:gemini",
          profileId: `account-${index}`,
          displayName: `Google account ${index}`
        }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().profile.profileId).toBe(`account-${index}`);
    }
    const listed = await app.inject({
      method: "GET",
      url: "/api/cli/runtimes/cli:gemini/account-profiles",
      headers: authHeaders("ADMIN")
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().profiles).toHaveLength(13);
  });

  it("renames main and other profiles without changing their identity", async () => {
    const { app, store } = await setup();
    for (const [profileId, displayName] of [["main", "Primary"], ["work", "Work renamed"]] as const) {
      if (profileId === "work") {
        store.createCliAccountProfile("cli:gemini", { runtimeId: "cli:gemini", profileId, displayName: "Work" }, "user:admin");
      }
      const response = await app.inject({
        method: "PATCH",
        url: `/api/cli/runtimes/cli:gemini/account-profiles/${profileId}`,
        headers: authHeaders("ADMIN"),
        payload: { displayName }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().profile).toMatchObject({ profileId, displayName });
      expect(store.getCliAccountProfile("cli:gemini", profileId)?.displayName).toBe(displayName);
    }
  });

  it("returns only sanitized account identity details on demand", async () => {
    const { app, readProfileIds } = await setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/cli/runtimes/cli:gemini/account-profiles/main/details",
      headers: authHeaders("ADMIN")
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      details: {
        runtimeId: "cli:gemini",
        profileId: "main",
        displayName: "Main account",
        email: "main@example.com",
        authStatus: "CONNECTED"
      }
    });
    expect(JSON.stringify(response.json())).not.toContain("token");
    expect(readProfileIds).toEqual(["main"]);
  });

  it("lists sanitized sign-in identities of every multi-account CLI for linking", async () => {
    const { app, store, readProfileIds } = await setup();
    store.createCliAccountProfile("cli:claude", { runtimeId: "cli:claude", profileId: "ops", displayName: "ops" }, "user:admin");
    store.createCliAccountProfile("cli:copilot", { runtimeId: "cli:copilot", profileId: "ops", displayName: "ops" }, "user:admin");
    const denied = await app.inject({ method: "GET", url: "/api/cli/account-identities", headers: authHeaders("OPERATOR") });
    expect(denied.statusCode).toBe(403);

    const response = await app.inject({ method: "GET", url: "/api/cli/account-identities", headers: authHeaders("ADMIN") });
    expect(response.statusCode).toBe(200);
    expect(response.json().accounts).toEqual([
      { runtimeId: "cli:gemini", profileId: "main", displayName: "Main account", email: "main@example.com", authStatus: "CONNECTED" },
      { runtimeId: "cli:claude", profileId: "ops", displayName: "ops", email: "claude@example.com", authStatus: "CONNECTED" },
      { runtimeId: "cli:copilot", profileId: "ops", displayName: "ops", email: null, login: "octo-cat", authStatus: "CONNECTED" }
    ]);
    expect(JSON.stringify(response.json())).not.toContain("token");

    // A second read inside the cache window does not probe the native profile again.
    await app.inject({ method: "GET", url: "/api/cli/account-identities", headers: authHeaders("ADMIN") });
    expect(readProfileIds).toEqual(["main"]);
    await app.inject({ method: "GET", url: "/api/cli/account-identities?refresh=1", headers: authHeaders("ADMIN") });
    expect(readProfileIds).toEqual(["main", "main"]);
  });

  it("supports Copilot profiles while keeping native task history shared", async () => {
    const { app, store } = await setup();
    store.createCliAccountProfile(
      "cli:copilot",
      { runtimeId: "cli:copilot", profileId: "work", displayName: "Work GitHub" },
      "user:admin"
    );
    const details = await app.inject({
      method: "GET",
      url: "/api/cli/runtimes/cli:copilot/account-profiles/work/details",
      headers: authHeaders("ADMIN")
    });
    expect(details.statusCode).toBe(200);
    expect(details.json().details).toMatchObject({
      runtimeId: "cli:copilot",
      profileId: "work",
      authStatus: "CONNECTED",
      email: null,
      login: "octo-cat"
    });
    const removed = await app.inject({
      method: "DELETE",
      url: "/api/cli/runtimes/cli:copilot/account-profiles/work",
      headers: authHeaders("ADMIN")
    });
    expect(removed.statusCode).toBe(200);
    expect(store.getCliAccountProfile("cli:copilot", "work")).toBeNull();
  });

  it("supports Claude profiles while keeping native task history shared", async () => {
    const { app, store } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/cli/runtimes/cli:claude/account-profiles",
      headers: authHeaders("ADMIN"),
      payload: {
        runtimeId: "cli:claude",
        profileId: "work",
        displayName: "Claude Work"
      }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().profile).toMatchObject({
      runtimeId: "cli:claude",
      profileId: "work",
      displayName: "Claude Work"
    });

    const details = await app.inject({
      method: "GET",
      url: "/api/cli/runtimes/cli:claude/account-profiles/work/details",
      headers: authHeaders("ADMIN")
    });
    expect(details.statusCode).toBe(200);
    expect(details.json().details).toMatchObject({
      runtimeId: "cli:claude",
      profileId: "work",
      authStatus: "CONNECTED",
      email: "claude@example.com"
    });

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/cli/runtimes/cli:claude/account-profiles/work",
      headers: authHeaders("ADMIN")
    });
    expect(removed.statusCode).toBe(200);
    expect(store.getCliAccountProfile("cli:claude", "work")).toBeNull();
  });

  it("tells new Claude panes to start on Space Gateway while it serves Claude", async () => {
    let serving = true;
    const serves = vi.fn(async () => serving);
    const { app, store } = await setup({}, { serves } as unknown as GatewayAdminService);
    const list = async (runtimeId: string) => (await app.inject({
      method: "GET",
      url: `/api/cli/runtimes/${runtimeId}/account-profiles`,
      headers: authHeaders("ADMIN")
    })).json();

    expect((await list("cli:claude")).gatewayProfile).toBeNull();
    store.createCliAccountProfile("cli:claude", { runtimeId: "cli:claude", profileId: "space-gateway", displayName: "Space Gateway" }, "user:admin");
    expect(await list("cli:claude")).toMatchObject({
      profiles: [{ profileId: "space-gateway" }],
      gatewayProfile: { profileId: "space-gateway", ready: true }
    });
    expect(serves).toHaveBeenCalledWith("CLAUDE");
    expect((await list("cli:gemini")).gatewayProfile).toBeNull();

    serving = false;
    const { app: stoppedApp, store: stoppedStore } = await setup({}, { serves } as unknown as GatewayAdminService);
    stoppedStore.createCliAccountProfile("cli:claude", { runtimeId: "cli:claude", profileId: "space-gateway", displayName: "Space Gateway" }, "user:admin");
    const stopped = await stoppedApp.inject({ method: "GET", url: "/api/cli/runtimes/cli:claude/account-profiles", headers: authHeaders("ADMIN") });
    expect(stopped.json().gatewayProfile).toEqual({ profileId: "space-gateway", ready: false });
  });

  it("continues the exact Claude conversation when a pane switches account", async () => {
    const hostRoot = await mkdtemp(join(tmpdir(), "space-claude-profile-host-"));
    temporaryRoots.push(hostRoot);
    const { app, store } = await setup({
      SPACE_CLI_CLAUDE_CREDENTIAL_SMOKE: "true",
      SPACE_CLI_HOST_SOCKET: join(hostRoot, "pane-host.sock")
    });
    for (const profileId of ["main", "work"]) {
      store.createCliAccountProfile(
        "cli:claude",
        { runtimeId: "cli:claude", profileId, displayName: profileId },
        "user:admin"
      );
    }
    const room = store.createRoom({ name: "Claude profiles", initialPaneCount: 0 });
    const pane = store.createPane({
      roomId: room.id,
      title: "Claude Code",
      mode: "TERMINAL",
      terminalRuntimeId: "cli:claude",
      cwd: "/etc"
    });
    const nativeSessionId = "85de09e6-3d1f-4e13-9173-142a9e9a36cf";
    const mainSession = store.createPaneCliSession({
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:claude",
      providerId: "anthropic",
      agentId: "claude",
      modelId: "sonnet",
      reasoningEffort: "medium",
      launchMode: "FRESH",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "Running on the main account.",
      isActive: true
    });
    store.updateCliTaskRevision(mainSession.cliTaskRevisionId!, {
      nativeTaskRef: nativeSessionId,
      displayTitle: "Refactor the deploy guard",
      firstUserMessage: "Refactor the deploy guard"
    });

    const switched = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/session`,
      headers: authHeaders("ADMIN"),
      payload: { runtimeId: "cli:claude", accountProfileId: "work", forceRestart: true, resume: true, includeTranscript: false }
    });
    expect(switched.statusCode, switched.body).toBe(200);
    const workSession = switched.json().session;
    expect(workSession).toMatchObject({
      accountProfileId: "work",
      launchMode: "RESUME",
      cliTaskId: mainSession.cliTaskId
    });
    expect(workSession.cliTaskRevisionId).not.toBe(mainSession.cliTaskRevisionId);
    expect(store.getCliTaskRevision(workSession.cliTaskRevisionId)).toMatchObject({
      nativeTaskRef: nativeSessionId,
      displayTitle: "Refactor the deploy guard",
      firstUserMessage: "Refactor the deploy guard"
    });
    expect(store.getPaneCliSession(mainSession.sessionId)?.status).toBe("EXITED");

    const freshPane = store.createPane({
      roomId: room.id,
      title: "Fresh Claude",
      mode: "TERMINAL",
      terminalRuntimeId: "cli:claude",
      cwd: "/etc"
    });
    const freshSession = store.createPaneCliSession({
      paneId: freshPane.id,
      roomId: room.id,
      runtimeId: "cli:claude",
      providerId: "anthropic",
      agentId: "claude",
      modelId: "sonnet",
      reasoningEffort: "medium",
      launchMode: "FRESH",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "No conversation yet.",
      isActive: true
    });
    const freshSwitch = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(freshPane.id)}/cli/session`,
      headers: authHeaders("ADMIN"),
      payload: { runtimeId: "cli:claude", accountProfileId: "work", forceRestart: true, resume: true, includeTranscript: false }
    });
    expect(freshSwitch.statusCode).toBe(200);
    expect(freshSwitch.json().session).toMatchObject({ accountProfileId: "work", launchMode: "FRESH" });
    expect(freshSwitch.json().session.cliTaskId).not.toBe(freshSession.cliTaskId);
  }, 30_000);

  it("binds independent profiles to different Gemini pane sessions", async () => {
    const { app, store } = await setup();
    for (const profileId of ["work", "personal"]) {
      store.createCliAccountProfile(
        "cli:gemini",
        { runtimeId: "cli:gemini", profileId, displayName: profileId },
        "user:admin"
      );
    }
    const room = store.createRoom({ name: "Gemini profiles", initialPaneCount: 0 });
    const panes = ["work", "personal"].map((profileId) => store.createPane({
      roomId: room.id,
      title: profileId,
      mode: "TERMINAL",
      terminalRuntimeId: "cli:gemini",
      cwd: "/etc"
    }));
    for (const [index, profileId] of ["work", "personal"].entries()) {
      const response = await app.inject({
        method: "POST",
        url: `/api/panes/${encodeURIComponent(panes[index]!.id)}/cli/session`,
        headers: authHeaders("ADMIN"),
        payload: { runtimeId: "cli:gemini", accountProfileId: profileId, includeTranscript: false }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().session.accountProfileId).toBe(profileId);
    }
    expect((await store.getActivePaneCliSession(panes[0]!.id))?.accountProfileId).toBe("work");
    expect((await store.getActivePaneCliSession(panes[1]!.id))?.accountProfileId).toBe("personal");
  });

  it("never writes a Job Copilot pane's account into its pane row", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "space-job-copilot-workspaces-"));
    temporaryRoots.push(workspaceRoot);
    const { app, store } = await setup({ SPACE_CLI_WORKSPACE_ROOT: workspaceRoot, SPACE_CLI_HOST_SOCKET: join(workspaceRoot, "pane-host.sock") });
    store.createCliAccountProfile("cli:gemini", { runtimeId: "cli:gemini", profileId: "work", displayName: "work" }, "user:admin");
    const room = store.createRoom({ name: "Job Copilot account", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Job Copilot", mode: "JOB_APPLY", terminalRuntimeId: "cli:gemini" });
    const response = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/session`,
      headers: authHeaders("ADMIN"),
      payload: { runtimeId: "cli:gemini", accountProfileId: "work", includeTranscript: false }
    });
    expect(response.statusCode).toBe(200);
    // The session keeps the account; the pane row stays as the Browser Host's start-up contracts expect.
    expect(response.json().session.accountProfileId).toBe("work");
    expect(store.getPane(pane.id).jobApplyMetadata ?? null).toBeNull();
  });

  it("rejects unknown profiles and protects profiles used by active panes", async () => {
    const { app, store, removedProfileIds } = await setup();
    const room = store.createRoom({ name: "Gemini profile guard", initialPaneCount: 0 });
    const pane = store.createPane({
      roomId: room.id,
      title: "Gemini",
      mode: "TERMINAL",
      terminalRuntimeId: "cli:gemini",
      cwd: "/etc"
    });
    const missing = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/session`,
      headers: authHeaders("ADMIN"),
      payload: { runtimeId: "cli:gemini", accountProfileId: "missing", includeTranscript: false }
    });
    expect(missing.statusCode).toBe(404);

    store.createCliAccountProfile(
      "cli:gemini",
      { runtimeId: "cli:gemini", profileId: "work", displayName: "Work account" },
      "user:admin"
    );
    store.createPaneCliSession({
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:gemini",
      providerId: "google",
      agentId: "gemini",
      accountProfileId: "work",
      status: "IDLE"
    });
    const inUse = await app.inject({
      method: "DELETE",
      url: "/api/cli/runtimes/cli:gemini/account-profiles/work",
      headers: authHeaders("ADMIN")
    });
    expect(inUse.statusCode).toBe(409);
    expect(removedProfileIds).toEqual([]);

    const main = await app.inject({
      method: "DELETE",
      url: "/api/cli/runtimes/cli:gemini/account-profiles/main",
      headers: authHeaders("ADMIN")
    });
    expect(main.statusCode).toBe(409);
  });

  it("cleans isolated native OAuth state before removing a non-main profile", async () => {
    const { app, store, removedProfileIds } = await setup();
    store.createCliAccountProfile(
      "cli:gemini",
      { runtimeId: "cli:gemini", profileId: "personal", displayName: "Personal" },
      "user:admin"
    );
    const response = await app.inject({
      method: "DELETE",
      url: "/api/cli/runtimes/cli:gemini/account-profiles/personal",
      headers: authHeaders("ADMIN")
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ removed: true });
    expect(removedProfileIds).toEqual(["personal"]);
    expect(store.getCliAccountProfile("cli:gemini", "personal")).toBeNull();
  });
  it("starts an Auto Copilot pane on the account with the most room and leaves Auto when an account is named", async () => {
    const hostRoot = await mkdtemp(join(tmpdir(), "space-copilot-auto-host-"));
    temporaryRoots.push(hostRoot);
    const { app, store } = await setup({ SPACE_CLI_HOST_SOCKET: join(hostRoot, "pane-host.sock") });
    for (const profileId of ["main", "work"]) {
      store.createCliAccountProfile("cli:copilot", { runtimeId: "cli:copilot", profileId, displayName: profileId }, "user:admin");
    }
    const balance = await app.inject({ method: "GET", url: "/api/cli/runtimes/cli:copilot/account-balance", headers: authHeaders("ADMIN") });
    expect(balance.statusCode).toBe(200);
    expect(balance.json()).toMatchObject({ runtimeId: "cli:copilot", next: "work" });
    expect((await app.inject({ method: "GET", url: "/api/cli/runtimes/cli:claude/account-balance", headers: authHeaders("ADMIN") })).statusCode).toBe(409);

    const room = store.createRoom({ name: "Copilot Auto", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Copilot", mode: "TERMINAL", terminalRuntimeId: "cli:copilot", cwd: "/etc" });
    store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:copilot", providerId: "github", agentId: "copilot", modelId: null,
      reasoningEffort: "medium", launchMode: "FRESH", cwd: "/etc", accountProfileId: null, status: "RUNNING", statusReason: "Running on main.", isActive: true });
    // A restart on Auto starts on the account with the most room.
    const auto = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/cli/session`, headers: authHeaders("ADMIN"),
      payload: { runtimeId: "cli:copilot", accountMode: "AUTO", forceRestart: true, includeTranscript: false } });
    expect(auto.statusCode, auto.body).toBe(200);
    expect(auto.json()).toMatchObject({ accountMode: "AUTO", session: { accountProfileId: "work" } });

    const named = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/cli/session`, headers: authHeaders("ADMIN"),
      payload: { runtimeId: "cli:copilot", accountProfileId: "main", forceRestart: true, includeTranscript: false } });
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json()).toMatchObject({ accountMode: "PROFILE", session: { accountProfileId: null } });
    const autoClaude = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/cli/session`, headers: authHeaders("ADMIN"),
      payload: { runtimeId: "cli:claude", accountMode: "AUTO", includeTranscript: false } });
    expect(autoClaude.statusCode).toBe(409);
  });
});
