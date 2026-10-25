import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemorySystemAnalyticsRepository } from "@space/db";
import { SystemAnalyticsService } from "../src/system-analytics-service.js";
import { CliHostClient } from "@space/cli-host";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp, type CreateAppOptions } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createCodexCliModeDefaultsService } from "../src/codex-cli-mode-defaults.js";
import type { SpaceAgentControl } from "../src/space-agent.js";
const csrfHeaderName = "x-space-csrf-token";
// Budget for app setup and close on a heavily loaded shared host.
vi.setConfig({ testTimeout: 60_000 });
const ownedDirectories: string[] = [];
const ownedApps: FastifyInstance[] = [];
async function makeOwnedDirectory(prefix: string) {
  const directory = await mkdtemp(prefix);
  ownedDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  try {
    for (const app of ownedApps.splice(0)) await app.close();
  } finally {
    await Promise.all(ownedDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  }
});

async function authedApp(options: CreateAppOptions = {}) {
  const store = options.store ?? new InMemorySpaceStore();
  const analyticsRoot = await makeOwnedDirectory(join(tmpdir(), "space-model-analytics-"));
  // Model confirmation uses real clocks and the existing deadline. Unrelated
  // analytics ingest only owned empty history and deterministic host samples.
  const analytics = options.systemAnalyticsService ?? new SystemAnalyticsService({
    store, repository: new InMemorySystemAnalyticsRepository(),
    codexHome: analyticsRoot, stateRoot: analyticsRoot, hermesHome: analyticsRoot,
    liveSessions: async () => [], readProcessTable: async () => [],
    readMeminfo: async () => "MemTotal: 1024 kB\nMemAvailable: 1024 kB\n",
    readProcStat: async () => "cpu 0 0 0 100 0 0 0 0 0 0\n", coreCount: 1
  });
  const cliHostClient = options.cliHostClient ?? {
    input: async () => { throw new Error("Model settings must never write terminal input"); },
    health: async () => ({ ok: true, sessions: [] }),
    inspect: async () => null,
    close: async () => undefined
  } as unknown as CliHostClient;
  const codexAgentControl = options.config?.cliEnabled && !Object.hasOwn(options, "codexAgentControl")
    ? testCodexAgentControl
    : options.codexAgentControl;
  const app = await createApp({
    // These synthetic sessions have no native rollout; avoid scanning live history.
    findCurrentCodexCliTurnActivity: async () => ({ status: "IDLE", turnId: null }),
    ...options,
    store,
    systemAnalyticsService: analytics,
    ...(Object.hasOwn(options, "codexAgentControl") || options.config?.cliEnabled
      ? { codexAgentControl: codexAgentControl ?? null }
      : {}),
    cliHostClient,
    auth: {
      sessionSecret: "test-secret-with-enough-length",
      devLogin: true,
      secureCookies: false,
      ...(options.auth ?? {})
    }
  });
  ownedApps.push(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "space@space.local", password: "space-dev" }
  });
  const cookie = login.cookies.find((entry) => entry.name === "space_session")?.value;
  const cookieHeader = `space_session=${cookie}`;
  const csrf = await app.inject({
    method: "GET",
    url: "/api/auth/csrf",
    headers: { cookie: cookieHeader }
  });
  return { app, cookie: cookieHeader, csrfToken: csrf.json().csrfToken as string };
}

const testCodexAgentControl = {
  async readConfigRequirements() {
    return {
      allowedApprovalPolicies: ["on-request", "never"],
      allowedApprovalsReviewers: ["user", "guardian_subagent"],
      allowedSandboxModes: ["workspace-write", "danger-full-access"],
      defaultPermissions: null
    };
  },
  async listModels() {
    return [{
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      description: "Provider-advertised integration-test model.",
      isDefault: true,
      defaultReasoningEffort: "xhigh",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"]
    }];
  },
  async listCollaborationModes() {
    return [{
      name: "Default",
      mode: "default" as const,
      model: "gpt-5.6-sol",
      reasoning_effort: "xhigh"
    }];
  },
  async setGoal() {
    throw new Error("Goal control is not used by CLI runtime tests.");
  },
  async clearGoal() {
    throw new Error("Goal control is not used by CLI runtime tests.");
  }
} satisfies SpaceAgentControl;

async function enabledCliConfig(commandDir: string, extra: NodeJS.ProcessEnv = {}) {
  const workspaceRoot = await makeOwnedDirectory(join(tmpdir(), "space-cli-workspaces-"));
  return getApiConfig({
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_COMMAND_PATH: commandDir,
    SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
    SPACE_CLI_WORKSPACE_ROOT: workspaceRoot,
    ...extra
  });
}


describe("Codex model settings", () => {
  it("returns persisted model settings for a new Codex pane before its first thread exists", async () => {
    const commandDir = await makeOwnedDirectory(join(tmpdir(), "space-cli-persisted-model-command-"));
    const commandPath = join(commandDir, "codex-vscode-parity");
    await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(commandPath, 0o755);
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "New CLI model settings", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", cwd: "/etc" });
    const session = store.createPaneCliSession({
      sessionId: "cli_session:persisted-model",
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "openai",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      codexThreadId: null,
      status: "RUNNING",
      statusReason: "Attached before the first prompt.",
      isActive: true
    });
    const { app, cookie } = await authedApp({
      store,
      config: await enabledCliConfig(commandDir),
      findCodexThreadResumeSettings: async () => null,
      codexSessionSocketProbe: async () => true,
      codexSocketControlFactory: () => ({
        listModels: async () => [{
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          isDefault: true,
          defaultReasoningEffort: "medium" as const,
          supportedReasoningEfforts: ["medium", "high"] as const
        }],
        updateThreadSettings: async () => undefined,
        interruptTurn: async () => undefined,
        startTurn: async () => ({ turnId: "turn:unused", status: "inProgress" as const })
      })
    });

    const status = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings/status`,
      headers: { cookie }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: "AVAILABLE",
      settings: {
        sessionId: session.sessionId,
        threadId: null,
        current: { modelId: "gpt-5.6-sol", reasoningEffort: "high" }
      }
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessionId: session.sessionId,
      threadId: null,
      current: { modelId: "gpt-5.6-sol", reasoningEffort: "high" }
    });

    store.updatePaneCliSession(session.sessionId, { reasoningEffort: "xhigh" });
    const invalidPersistedReasoning = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers: { cookie }
    });
    expect(invalidPersistedReasoning.statusCode).toBe(200);
    expect(invalidPersistedReasoning.json()).toMatchObject({ current: null });
    await app.close();
  });

  it.each(["native", "missing", "ambiguous", "wrong-cwd", "unconfirmed"])("changes fresh Codex settings without composer input: %s", async (mode) => {
    const commandDir = await makeOwnedDirectory(join(tmpdir(), "space-native-model-control-"));
    await writeFile(join(commandDir, "codex-vscode-parity"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Native settings", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Codex", mode: "TERMINAL", cwd: "/etc" });
    const session = store.createPaneCliSession({ sessionId: "cli_session:native-settings", paneId: pane.id, roomId: room.id,
      runtimeId: "cli:codex", providerId: "openai", agentId: "codex", modelId: "gpt-5.5", reasoningEffort: "medium",
      cwd: "/etc", codexThreadId: null, status: "RUNNING", statusReason: "Fresh composer with draft and image", isActive: true });
    const nativeThread = "11111111-1111-4111-8111-111111111111";
    let settings = { modelId: "gpt-5.5", reasoningEffort: "medium", cwd: mode === "wrong-cwd" ? "/other" : "/etc", isTurnActive: false };
    const updateThreadSettings = vi.fn(async (input: { model: string; reasoningEffort: string }) => {
      if (mode !== "unconfirmed") settings = { ...settings, modelId: input.model, reasoningEffort: input.reasoningEffort };
    });
    const hostInput = vi.fn();
    const interruptTurn = vi.fn();
    const startTurn = vi.fn();
    const { app, cookie, csrfToken } = await authedApp({ store, config: await enabledCliConfig(commandDir),
      findCodexThreadId: async () => null,
      findCodexModelControlThreads: async () => mode === "missing" ? [] : mode === "ambiguous" ? [nativeThread, "22222222-2222-4222-8222-222222222222"] : [nativeThread],
      codexSessionSocketProbe: async () => true,
      cliHostClient: { input: hostInput, close: async () => undefined, health: async () => ({ ok: true, sessions: [] }) } as unknown as CliHostClient,
      codexSocketControlFactory: () => ({
        listModels: async () => [{ id: "gpt-5.5", displayName: "GPT", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium", "high"] }],
        readThreadSettings: async () => settings,
        updateThreadSettings, interruptTurn, startTurn
      })
    });
    try {
      const response = await app.inject({ method: "PATCH", url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { expectedSessionId: session.sessionId, modelId: "gpt-5.5", reasoningEffort: "high", continueActiveTurn: true } });
      expect(response.statusCode).toBe(mode === "native" ? 200 : 409);
      if (mode === "native") {
        expect(updateThreadSettings).toHaveBeenCalledExactlyOnceWith({ threadId: nativeThread, model: "gpt-5.5", reasoningEffort: "high", beforeSend: expect.any(Function) });
        expect(response.json()).toMatchObject({ interrupted: false, continuation: "NOT_NEEDED", settings: { current: { modelId: "gpt-5.5", reasoningEffort: "high" } } });
      } else if (mode === "unconfirmed") {
        expect(updateThreadSettings).toHaveBeenCalledOnce();
        expect(store.getPaneCliSession(session.sessionId)?.reasoningEffort).toBe("medium");
      } else expect(updateThreadSettings).not.toHaveBeenCalled();
      expect(hostInput).not.toHaveBeenCalled();
      expect(interruptTurn).not.toHaveBeenCalled();
      expect(startTurn).not.toHaveBeenCalled();
      expect(store.getPaneCliSession(session.sessionId)?.codexThreadId).toBeNull();
    } finally { await app.close(); await rm(commandDir, { recursive: true, force: true }); }
  });

  it.each([
    { modelId: "gpt-5.6-sol", reasoningEffort: "low" },
    { modelId: "gpt-5.6-terra", reasoningEffort: "high" }
  ])("keeps pane model change $modelId/$reasoningEffort isolated from sibling panes and global defaults", async (target) => {
    const commandDir = await makeOwnedDirectory(join(tmpdir(), "space-pane-model-isolation-"));
    const commandPath = join(commandDir, "codex-vscode-parity");
    await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(commandPath, 0o755);
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Model isolation", initialPaneCount: 0 });
    const sessions = [0, 1].map((index) => {
      const pane = store.createPane({ roomId: room.id, title: `Codex ${index}`, mode: "TERMINAL", cwd: "/etc" });
      return store.createPaneCliSession({
        sessionId: `cli_session:isolation-${index}`, paneId: pane.id, roomId: room.id,
        runtimeId: "cli:codex", providerId: "openai", agentId: "codex",
        modelId: "gpt-5.6-sol", reasoningEffort: "high", cwd: "/etc",
        codexThreadId: index === 0 ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
        status: "RUNNING", statusReason: "Attached", isActive: true
      });
    });
    const selected = sessions[0]!;
    const sibling = sessions[1]!;
    const runtime = new Map(sessions.map(session => [session.codexThreadId!, { modelId: session.modelId!, reasoningEffort: "high" }]));
    const updateThreadSettings = vi.fn(async (input: { threadId: string; model: string; reasoningEffort: string }) => {
      runtime.set(input.threadId, { modelId: input.model, reasoningEffort: input.reasoningEffort });
    });
    const { app, cookie, csrfToken } = await authedApp({
      store, config: await enabledCliConfig(commandDir),
      codexAgentControl: {
        ...testCodexAgentControl,
        listModels: async () => ["gpt-5.6-sol", "gpt-5.6-terra"].map(id => ({
          id, displayName: id, isDefault: id === "gpt-5.6-sol",
          defaultReasoningEffort: "high", supportedReasoningEfforts: ["low", "high"]
        }))
      },
      findCodexThreadResumeSettings: async ({ threadId }) => runtime.get(threadId) ?? null,
      codexSessionSocketProbe: async () => true,
      codexSocketControlFactory: () => ({
        listModels: async () => ["gpt-5.6-sol", "gpt-5.6-terra"].map(id => ({
          id, displayName: id, isDefault: id === "gpt-5.6-sol",
          defaultReasoningEffort: "high", supportedReasoningEfforts: ["low", "high"]
        })),
        updateThreadSettings, interruptTurn: async () => undefined,
        startTurn: async () => ({ turnId: "unused", status: "inProgress" as const })
      })
    });
    try {
      const before = await app.inject({ method: "GET", url: "/api/cli/codex-defaults", headers: { cookie } });
      expect(before.statusCode).toBe(200);
      const persistDefaults = vi.spyOn(store, "updateCodexCliModeDefaults");
      const response = await app.inject({
        method: "PATCH", url: `/api/panes/${encodeURIComponent(selected.paneId)}/cli/model-settings`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { expectedSessionId: selected.sessionId, ...target, continueActiveTurn: false }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().settings.current).toEqual(target);
      // 93e473b282 fences each settings write with a beforeSend ownership check.
      expect(updateThreadSettings).toHaveBeenCalledExactlyOnceWith({ threadId: selected.codexThreadId, model: target.modelId, reasoningEffort: target.reasoningEffort, beforeSend: expect.any(Function) });
      expect(persistDefaults).not.toHaveBeenCalled();
      const after = await app.inject({ method: "GET", url: "/api/cli/codex-defaults", headers: { cookie } });
      expect(after.json().defaults).toEqual(before.json().defaults);
      expect(store.getPaneCliSession(sibling.sessionId)).toEqual(sibling);
      expect(runtime.get(sibling.codexThreadId!)).toEqual({ modelId: "gpt-5.6-sol", reasoningEffort: "high" });
    } finally {
      await app.close();
      await rm(commandDir, { recursive: true, force: true });
    }
  });

  it("prefers delayed authoritative Codex state over a stale terminal footer instead of returning a false conflict", async () => {
    const commandDir = await makeOwnedDirectory(join(tmpdir(), "space-cli-runtime-model-command-"));
    const commandPath = join(commandDir, "codex-vscode-parity");
    await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(commandPath, 0o755);
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "CLI runtime model truth", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", cwd: "/etc" });
    const session = store.createPaneCliSession({
      sessionId: "cli_session:runtime-model-truth",
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "openai",
      agentId: "codex",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      cwd: "/etc",
      codexThreadId: "11111111-1111-4111-8111-111111111111",
      status: "RUNNING",
      statusReason: "Attached Codex pane.",
      isActive: true
    });
    const models = [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        isDefault: false,
        defaultReasoningEffort: "high" as const,
        supportedReasoningEfforts: ["high", "xhigh"] as const
      },
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6-Terra",
        isDefault: true,
        defaultReasoningEffort: "medium" as const,
        supportedReasoningEfforts: ["medium", "high"] as const
      }
    ];
    let runtimeSettings: { modelId: string; reasoningEffort: string | null } | null = {
      modelId: "gpt-5.5",
      reasoningEffort: "xhigh"
    };
    let pendingRuntimeSettings: { modelId: string; reasoningEffort: string } | null = null;
    let confirmationReads = 0;
    const updateThreadSettings = vi.fn(async (input: { model: string; reasoningEffort: "xhigh" | "high" }) => {
      pendingRuntimeSettings = {
        modelId: input.model === "gpt-5.6-terra" ? "terra" : input.model,
        reasoningEffort: input.reasoningEffort
      };
    });
    const options = {
      store,
      config: await enabledCliConfig(commandDir),
      findCodexThreadResumeSettings: async () => {
        if (pendingRuntimeSettings && confirmationReads++ >= 5) {
          runtimeSettings = pendingRuntimeSettings;
          pendingRuntimeSettings = null;
        }
        return runtimeSettings;
      },
      codexSessionSocketProbe: async () => true,
      codexSocketControlFactory: () => ({
        listModels: async () => models,
        updateThreadSettings,
        interruptTurn: async () => undefined,
        startTurn: async () => ({ turnId: "turn:unused", status: "inProgress" as const })
      })
    } as unknown as CreateAppOptions;
    const { app, cookie } = await authedApp(options);

    const response = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessionId: session.sessionId,
      threadId: session.codexThreadId,
      current: { modelId: "gpt-5.5", reasoningEffort: "xhigh" }
    });

    runtimeSettings = null;
    const detecting = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers: { cookie }
    });
    expect(detecting.statusCode).toBe(200);
    expect(detecting.json()).toMatchObject({
      current: { modelId: "gpt-5.6-terra", reasoningEffort: "medium" }
    });
    runtimeSettings = { modelId: "gpt-5.6-terra", reasoningEffort: null };
    store.appendPaneCliTranscriptChunk({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      sequence: 0,
      stream: "stdout",
      content: "\u001b[2K gpt-5.6-terra high · /etc \u001b[0m"
    });
    const partialState = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers: { cookie }
    });
    expect(partialState.statusCode).toBe(200);
    expect(partialState.json()).toMatchObject({
      current: { modelId: "gpt-5.6-terra", reasoningEffort: "high" }
    });
    runtimeSettings = { modelId: "gpt-5.5", reasoningEffort: null };
    const mismatchedPartialState = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers: { cookie }
    });
    expect(mismatchedPartialState.statusCode).toBe(200);
    expect(mismatchedPartialState.json()).toMatchObject({ current: null });
    runtimeSettings = { modelId: "gpt-5.5", reasoningEffort: "xhigh" };
    store.appendPaneCliTranscriptChunk({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      sequence: 1,
      stream: "stdout",
      content: "\u001b[2K gpt-5.5 xhigh · /etc \u001b[0m"
    });

    const switched = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers: { cookie, [csrfHeaderName]: (await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } })).json().csrfToken },
      payload: {
        expectedSessionId: session.sessionId,
        modelId: "gpt-5.6-terra",
        reasoningEffort: "high",
        continueActiveTurn: true
      }
    });

    expect(switched.statusCode).toBe(200);
    expect(updateThreadSettings).toHaveBeenCalledWith({
      threadId: session.codexThreadId,
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      beforeSend: expect.any(Function)
    });
    expect(confirmationReads).toBeGreaterThan(5);
    expect(switched.json()).toMatchObject({
      settings: { current: { modelId: "gpt-5.6-terra", reasoningEffort: "high" } },
      session: { session: { modelId: "gpt-5.6-terra", reasoningEffort: "high" } }
    });
    await app.close();
  });

  it("returns safe expected and observed diagnostics when Codex does not confirm runtime model settings", async () => {
    const commandDir = await makeOwnedDirectory(join(tmpdir(), "space-cli-runtime-model-unconfirmed-command-"));
    const commandPath = join(commandDir, "codex-vscode-parity");
    await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(commandPath, 0o755);
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "CLI runtime model confirmation diagnostics", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", cwd: "/etc" });
    const session = store.createPaneCliSession({
      sessionId: "cli_session:runtime-model-unconfirmed",
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "openai",
      agentId: "codex",
      modelId: "gpt-5.5",
      reasoningEffort: "xhigh",
      cwd: "/etc",
      codexThreadId: "55555555-5555-4555-8555-555555555555",
      status: "RUNNING",
      statusReason: "Attached Codex pane.",
      isActive: true
    });
    const observed = { modelId: "gpt-5.5", reasoningEffort: "xhigh" };
    const updateThreadSettings = vi.fn(async () => undefined);
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: await enabledCliConfig(commandDir),
      findCodexThreadResumeSettings: async () => observed,
      codexSessionSocketProbe: async () => true,
      codexSocketControlFactory: () => ({
        listModels: async () => [
          {
            id: "gpt-5.5",
            displayName: "GPT-5.5",
            isDefault: true,
            defaultReasoningEffort: "xhigh" as const,
            supportedReasoningEfforts: ["high", "xhigh"] as const
          },
          {
            id: "gpt-5.6-terra",
            displayName: "GPT-5.6-Terra",
            isDefault: false,
            defaultReasoningEffort: "medium" as const,
            supportedReasoningEfforts: ["medium", "high"] as const
          }
        ],
        updateThreadSettings,
        interruptTurn: async () => undefined,
        startTurn: async () => ({ turnId: "turn:unused", status: "inProgress" as const })
      })
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        expectedSessionId: session.sessionId,
        modelId: "gpt-5.6-terra",
        reasoningEffort: "high",
        continueActiveTurn: true
      }
    });
    const payload = response.json();
    const persistedSession = store.getPaneCliSession(session.sessionId);
    await app.close();

    expect(response.statusCode).toBe(409);
    expect(updateThreadSettings).toHaveBeenCalledWith({
      threadId: session.codexThreadId,
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      beforeSend: expect.any(Function)
    });
    expect(payload).toMatchObject({
      error: {
        code: "CODEX_RUNTIME_MODEL_SETTINGS_UNCONFIRMED",
        message: expect.stringContaining("Expected gpt-5.6-terra · high; last observed gpt-5.5 · xhigh"),
        details: {
          stage: "THREAD_CONFIRMATION",
          expected: { modelId: "gpt-5.6-terra", reasoningEffort: "high" },
          observed: { modelId: "gpt-5.5", reasoningEffort: "xhigh" },
          attempts: 12
        }
      }
    });
    expect(payload.error.details).toEqual({
      stage: "THREAD_CONFIRMATION",
      expected: { modelId: "gpt-5.6-terra", reasoningEffort: "high" },
      observed: { modelId: "gpt-5.5", reasoningEffort: "xhigh" },
      attempts: 12
    });
    expect(persistedSession).toMatchObject({
      sessionId: session.sessionId,
      codexThreadId: session.codexThreadId,
      modelId: "gpt-5.5",
      reasoningEffort: "xhigh",
      status: "RUNNING",
      isActive: true
    });
  }, 60_000);

  it("returns provider descriptions and rejects model settings removed from the fresh live catalog", async () => {
    const commandDir = await makeOwnedDirectory(join(tmpdir(), "space-cli-live-catalog-command-"));
    const commandPath = join(commandDir, "codex-vscode-parity");
    await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(commandPath, 0o755);
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Live catalog", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", cwd: "/etc" });
    const session = store.createPaneCliSession({
      sessionId: "cli_session:live-catalog",
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "openai",
      agentId: "codex",
      modelId: "gpt-5.6-mini",
      reasoningEffort: "medium",
      cwd: "/etc",
      codexThreadId: "44444444-4444-4444-8444-444444444444",
      status: "RUNNING",
      statusReason: "Attached Codex pane.",
      isActive: true
    });
    const sol = {
      id: "gpt-5.6-sol",
      displayName: "Sol",
      description: "Highest-capability provider model.",
      isDefault: true,
      defaultReasoningEffort: "max",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      reasoningOptions: [
        { reasoningEffort: "low", description: "Fast." },
        { reasoningEffort: "medium", description: "Balanced." },
        { reasoningEffort: "high", description: "Thorough." },
        { reasoningEffort: "xhigh", description: "Very thorough." },
        { reasoningEffort: "max", description: "Maximum." },
        { reasoningEffort: "ultra", description: "Ultimate." }
      ]
    };
    const mini = {
      id: "gpt-5.6-mini",
      displayName: "Mini",
      description: "Fast provider model.",
      isDefault: false,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      reasoningOptions: [
        { reasoningEffort: "low", description: "Fast." },
        { reasoningEffort: "medium", description: "Balanced." },
        { reasoningEffort: "high", description: "Thorough." },
        { reasoningEffort: "xhigh", description: "Very thorough." }
      ]
    };
    let catalog = [sol, mini];
    const options = {
      store,
      config: await enabledCliConfig(commandDir),
      findCodexThreadResumeSettings: async () => ({ modelId: "gpt-5.6-mini", reasoningEffort: "medium" }),
      codexSessionSocketProbe: async () => true,
      codexSocketControlFactory: () => ({
        listModels: async () => catalog,
        updateThreadSettings: async () => undefined,
        interruptTurn: async () => undefined,
        startTurn: async () => ({ turnId: "turn:unused", status: "inProgress" as const })
      })
    } as unknown as CreateAppOptions;
    const { app, cookie, csrfToken } = await authedApp(options);

    const listed = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers: { cookie }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      sessionId: session.sessionId,
      models: [
        {
          id: "gpt-5.6-sol",
          description: "Highest-capability provider model.",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
          reasoningOptions: expect.arrayContaining([{ reasoningEffort: "ultra", description: "Ultimate." }])
        },
        {
          id: "gpt-5.6-mini",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"]
        }
      ]
    });

    catalog = [mini];
    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        expectedSessionId: session.sessionId,
        modelId: "gpt-5.6-sol",
        reasoningEffort: "ultra"
      }
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ error: { message: expect.stringContaining("not advertised") } });
    await app.close();
  });

  it("reports model control as unavailable when a fresh Codex rejects thread/read", async () => {
    const commandDir = await makeOwnedDirectory(join(tmpdir(), "space-cli-thread-read-unavailable-"));
    await writeFile(join(commandDir, "codex-vscode-parity"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Thread read unavailable", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Codex", mode: "TERMINAL", cwd: "/etc" });
    store.createPaneCliSession({ sessionId: "cli_session:thread-read-unavailable", paneId: pane.id, roomId: room.id,
      runtimeId: "cli:codex", providerId: "openai", agentId: "codex", modelId: "gpt-5.5", reasoningEffort: "medium",
      cwd: "/etc", codexThreadId: "33333333-3333-4333-8333-333333333333", status: "RUNNING",
      statusReason: "Resumed Codex pane.", isActive: true });
    const { app, cookie } = await authedApp({ store, config: await enabledCliConfig(commandDir),
      codexSessionSocketProbe: async () => true,
      codexSocketControlFactory: () => ({
        listModels: async () => [{ id: "gpt-5.5", displayName: "GPT", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium", "high"] }],
        readThreadSettings: async () => { throw new Error("Codex App Server thread/read returned an error."); },
        updateThreadSettings: async () => undefined,
        interruptTurn: async () => undefined,
        startTurn: async () => ({ turnId: "turn:unused", status: "inProgress" as const })
      })
    });
    try {
      const status = await app.inject({
        method: "GET",
        url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings/status`,
        headers: { cookie }
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ status: "UNAVAILABLE", reasonCode: "CODEX_SESSION_CONTROL_UNAVAILABLE" });
    } finally { await app.close(); await rm(commandDir, { recursive: true, force: true }); }
  });

  it("leaves the active Codex session unchanged when the private socket rejects direct RPC", async () => {
    const commandDir = await makeOwnedDirectory(join(tmpdir(), "space-cli-model-control-unavailable-"));
    const commandPath = join(commandDir, "codex-vscode-parity");
    await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(commandPath, 0o755);
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Unavailable model control", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", cwd: "/etc" });
    const session = store.createPaneCliSession({
      sessionId: "cli_session:model-control-unavailable",
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "openai",
      agentId: "codex",
      modelId: "gpt-5.5",
      reasoningEffort: "high",
      cwd: "/etc",
      codexThreadId: "22222222-2222-4222-8222-222222222222",
      status: "RUNNING",
      statusReason: "Active Codex pane.",
      isActive: true
    });
    const directListModels = vi.fn(async () => {
      throw new Error("single-client upstream rejected the second connection");
    });
    const socketControlFactory = vi.fn(() => ({
      listModels: directListModels,
      updateThreadSettings: async () => undefined,
      interruptTurn: async () => undefined,
      startTurn: async () => ({ turnId: "turn:unused", status: "inProgress" as const })
    }));
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: await enabledCliConfig(commandDir),
      codexSessionSocketProbe: async () => true,
      codexSocketControlFactory: socketControlFactory
    });

    const status = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings/status`,
      headers: { cookie }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: "UNAVAILABLE",
      reasonCode: "CODEX_SESSION_CONTROL_UNAVAILABLE",
      reason: expect.stringContaining("session was left unchanged")
    });

    const listed = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers: { cookie }
    });
    expect(listed.statusCode).toBe(503);
    expect(listed.json()).toMatchObject({ error: { code: "CODEX_SESSION_CONTROL_UNAVAILABLE" } });

    const switched = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        expectedSessionId: session.sessionId,
        modelId: "gpt-5.6-sol",
        reasoningEffort: "high"
      }
    });
    expect(switched.statusCode).toBe(503);
    expect(switched.json()).toMatchObject({ error: { code: "CODEX_SESSION_CONTROL_UNAVAILABLE" } });
    expect(socketControlFactory).toHaveBeenCalled();
    expect(directListModels).toHaveBeenCalled();
    expect(store.listPaneCliSessions(pane.id)).toHaveLength(1);
    expect(store.getPaneCliSession(session.sessionId)).toMatchObject({
      sessionId: session.sessionId,
      codexThreadId: session.codexThreadId,
      status: "RUNNING",
      isActive: true,
      endedAt: null
    });
    await app.close();
  });

  it("lists and switches sticky Codex model settings during an active turn", async () => {
    const commandDir = await makeOwnedDirectory(join(tmpdir(), "space-cli-model-switch-command-"));
    const commandPath = join(commandDir, "codex-vscode-parity");
    await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(commandPath, 0o755);
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "CLI model switch", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", cwd: "/etc" });
    const session = store.createPaneCliSession({
      sessionId: "cli_session:model-switch",
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "openai",
      agentId: "codex",
      modelId: "gpt-5.5",
      reasoningEffort: "high",
      cwd: "/etc",
      codexThreadId: "11111111-1111-4111-8111-111111111111",
      status: "RUNNING",
      statusReason: "Active Codex turn.",
      isActive: true
    });
    const models = [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        isDefault: true,
        defaultReasoningEffort: "high" as const,
        supportedReasoningEfforts: ["medium", "high", "xhigh"] as const
      },
      {
        id: "gpt-5.6",
        displayName: "GPT-5.6",
        isDefault: false,
        defaultReasoningEffort: "high" as const,
        supportedReasoningEfforts: ["high", "xhigh"] as const
      }
    ];
    let runtimeSettings = { modelId: "gpt-5.5", reasoningEffort: "high" };
    const interruptTurn = vi.fn(async () => undefined);
    const updateThreadSettings = vi.fn(async (input: { model: string; reasoningEffort: string }) => {
      runtimeSettings = { modelId: input.model, reasoningEffort: input.reasoningEffort };
    });
    const startTurn = vi.fn(async (input: { model: string; reasoningEffort: string }) => {
      runtimeSettings = { modelId: input.model, reasoningEffort: input.reasoningEffort };
      return { turnId: "turn:continued", status: "inProgress" as const };
    });
    const codexCliModeDefaultsService = createCodexCliModeDefaultsService({
      control: {
        async listModels() { return models; },
        async readConfiguredModel() { return { model: "gpt-5.5", reasoningEffort: "high" }; }
      }
    });
    const options = {
      store,
      config: await enabledCliConfig(commandDir),
      codexCliModeDefaultsService,
      findCurrentCodexCliTurnActivity: async () => ({ status: "RUNNING" as const, turnId: "turn:active" }),
      findCodexThreadResumeSettings: async () => runtimeSettings,
      codexSessionSocketProbe: async () => true,
      codexSocketControlFactory: () => ({ listModels: async () => models,
        readThreadSettings: async () => ({ ...runtimeSettings, cwd: "/etc", isTurnActive: true }),
        updateThreadSettings, interruptTurn, startTurn })
    } as unknown as CreateAppOptions;
    const { app, cookie, csrfToken } = await authedApp(options);

    const before = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers: { cookie }
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      sessionId: session.sessionId,
      threadId: session.codexThreadId,
      current: { modelId: "gpt-5.5", reasoningEffort: "high" },
      controlMode: "DIRECT",
      isTurnActive: true
    });

    const switched = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        expectedSessionId: session.sessionId,
        modelId: "gpt-5.6",
        reasoningEffort: "xhigh",
        continueActiveTurn: true
      }
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({
      appliedScope: "MODEL_AND_REASONING",
      wasActive: true,
      interrupted: false,
      continuation: "NOT_NEEDED",
      transport: "DIRECT",
      warning: null,
      settings: { current: { modelId: "gpt-5.6", reasoningEffort: "xhigh" } },
      session: { session: { sessionId: session.sessionId, modelId: "gpt-5.6", reasoningEffort: "xhigh" } }
    });
    expect(interruptTurn).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
    expect(updateThreadSettings).toHaveBeenCalledWith({ threadId: session.codexThreadId, model: "gpt-5.6", reasoningEffort: "xhigh", beforeSend: expect.any(Function) });
    await expect(codexCliModeDefaultsService.build()).resolves.toEqual({ modelId: "gpt-5.5", reasoningEffort: "high" });
    expect(store.listPaneCliSessions(pane.id)).toHaveLength(1);
    expect(store.getPaneCliSession(session.sessionId)).toMatchObject({
      sessionId: session.sessionId,
      codexThreadId: session.codexThreadId,
      status: "RUNNING",
      isActive: true,
      endedAt: null
    });

    updateThreadSettings.mockRejectedValueOnce(new Error("Selected model rejected."));
    const rejected = await app.inject({ method: "PATCH", url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { expectedSessionId: session.sessionId,
        modelId: "gpt-5.5", reasoningEffort: "high", continueActiveTurn: true } });
    expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
    expect(startTurn).not.toHaveBeenCalled();
    expect(interruptTurn).not.toHaveBeenCalled();
    expect(store.getPaneCliSession(session.sessionId)?.modelId).toBe("gpt-5.6");

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        expectedSessionId: "cli_session:stale",
        modelId: "gpt-5.6",
        reasoningEffort: "high",
        continueActiveTurn: true
      }
    });
    expect(stale.statusCode).toBe(409);

    await app.close();
  });

  it("detects an active turn from the terminal screen when Codex thread settings report idle", async () => {
    const commandDir = await mkdtemp(join(tmpdir(), "space-cli-screen-turn-command-"));
    const commandPath = join(commandDir, "codex-vscode-parity");
    await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(commandPath, 0o755);
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Screen Running Room", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", cwd: "/etc" });
    const session = store.createPaneCliSession({
      sessionId: "cli_session:screen-running",
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "openai",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      codexThreadId: "019ce297-a45b-7c40-9a3c-b9b2e987c654",
      status: "RUNNING",
      statusReason: "Attached before the first prompt.",
      isActive: true
    });

    store.appendPaneCliTranscriptChunkAtNextSequence({
      roomId: room.id,
      paneId: pane.id,
      sessionId: session.sessionId,
      stream: "stdout",
      content: "Working (31m 27s • esc to interrupt)\nDoing deep analysis...\n"
    });

    const { app, cookie } = await authedApp({
      store,
      config: await enabledCliConfig(commandDir),
      findCodexThreadResumeSettings: async () => null,
      findCurrentCodexCliTurnActivity: async () => ({ status: "IDLE" as const, turnId: null }),
      codexSessionSocketProbe: async () => true,
      codexSocketControlFactory: () => ({
        listModels: async () => [{
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          isDefault: true,
          defaultReasoningEffort: "medium" as const,
          supportedReasoningEfforts: ["medium", "high"] as const
        }],
        readThreadSettings: async () => ({
          modelId: "gpt-5.6-sol",
          reasoningEffort: "high" as const,
          cwd: "/etc",
          isTurnActive: false
        }),
        updateThreadSettings: async () => undefined,
        interruptTurn: async () => undefined,
        startTurn: async () => ({ turnId: "turn:unused", status: "inProgress" as const })
      })
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
        headers: { cookie }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.isTurnActive).toBe(true);
    } finally {
      await app.close();
      await rm(commandDir, { recursive: true, force: true });
    }
  });

});

