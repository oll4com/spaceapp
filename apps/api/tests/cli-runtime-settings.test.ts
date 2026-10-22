import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { cliToggleRuntimeIds } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import {
  CliRuntimeDisableConfirmationStaleError,
  CliRuntimeVisibilityPolicy
} from "../src/cli-runtime-visibility.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { createCodexParityService, type CodexParityService } from "../src/codex-parity.js";
import type { RuntimeProcessSweepResult } from "../src/cli-runtime-process-sweeper.js";

const noopKill = async (): Promise<RuntimeProcessSweepResult> => ({
  matchedPids: [],
  killedPids: [],
  remainingPids: []
});

const sessionSecret = "cli-runtime-settings-test-secret";
const csrfHeaderName = "x-space-csrf-token";
const apps: FastifyInstance[] = [];
const artifactRoots: string[] = [];

function authHeaders(role: "OPERATOR" | "ADMIN") {
  const session = signSession(
    { id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role },
    sessionSecret
  );
  return {
    cookie: `space_session=${session}`,
    [csrfHeaderName]: createCsrfToken(session, sessionSecret)!
  };
}

async function setup(options: {
  store?: InMemorySpaceStore;
  terminateSession?: (sessionId: string) => Promise<boolean>;
  interruptChatPane?: (paneId: string, reason: string, traceId: string) => Promise<boolean>;
  stopRoomAgentMission?: (roomId: string, missionId: string, reason: string, traceId: string) => Promise<boolean>;
  killRuntimeProcesses?: (runtimeId: string, traceId: string) => Promise<RuntimeProcessSweepResult>;
  countRuntimeProcesses?: (runtimeId: string) => Promise<number>;
  codexParity?: CodexParityService;
} = {}) {
  const store = options.store ?? new InMemorySpaceStore();
  const artifactRoot = await mkdtemp(join(tmpdir(), "runtime-settings-"));
  artifactRoots.push(artifactRoot);
  const app = await createApp({
    store,
    config: getApiConfig({ SPACE_ARTIFACT_ROOT: artifactRoot }),
    auth: { sessionSecret, devLogin: false, secureCookies: false },
    cliRuntimeSessionTerminator: options.terminateSession,
    codexMasterChatInterrupter: options.interruptChatPane,
    codexMasterRoomAgentStopper: options.stopRoomAgentMission,
    killRuntimeProcesses: options.killRuntimeProcesses ?? noopKill,
    countRuntimeProcesses: options.countRuntimeProcesses,
    codexParity: options.codexParity,
    // Never the host's ~/.codex goals database.
    codexGoals: { list: async () => [], update: async () => { throw new Error("Codex goals are read-only in this test."); } }
  });
  apps.push(app);
  return { app, store };
}

function addActiveChatAndMission(store: InMemorySpaceStore, suffix: string) {
  const room = store.createRoom({ name: `Codex room ${suffix}`, initialPaneCount: 0 });
  const chatPane = store.createPane({
    roomId: room.id,
    title: `${suffix} Chat`,
    mode: "CHAT"
  });
  const chatSession = store.createSpaceAgentSession({
    paneId: chatPane.id,
    roomId: room.id,
    status: "RUNNING",
    title: chatPane.title,
    selectedProviderId: "codex-lb",
    selectedModelId: "gpt-5.6-sol",
    selectedModelConfigId: "gpt-5.6-sol:high",
    selectedProviderName: "Codex-LB",
    selectedModelName: "GPT-5.6",
    selectedReasoningKey: "high",
    selectedToolIds: [],
    isActive: true
  });
  const chatPrompt = store.createSpaceAgentMessage({
    sessionId: chatSession.sessionId,
    role: "user",
    content: "Keep working."
  });
  const chatResponse = store.createSpaceAgentMessage({
    sessionId: chatSession.sessionId,
    role: "assistant",
    content: "",
    status: "RUNNING"
  });
  const chatRun = store.createSpaceAgentRun({
    sessionId: chatSession.sessionId,
    roomId: room.id,
    paneId: chatPane.id,
    workflowId: `workflow:${suffix}`,
    status: "RUNNING",
    promptMessageId: chatPrompt.messageId,
    responseMessageId: chatResponse.messageId
  });
  const roomAgentPane = store.getOrCreateRoomAgentPane(room.id);
  const roomAgentSession = store.createSpaceAgentSession({
    paneId: roomAgentPane.id,
    roomId: room.id,
    status: "RUNNING",
    title: "Room Agent",
    selectedProviderId: null,
    selectedModelId: "gpt-5.6-sol",
    selectedModelConfigId: "gpt-5.6-sol:high",
    selectedProviderName: null,
    selectedModelName: "GPT-5.6",
    selectedReasoningKey: "high",
    selectedToolIds: [],
    isActive: true
  });
  const missionPrompt = store.createSpaceAgentMessage({
    sessionId: roomAgentSession.sessionId,
    role: "user",
    content: "Supervise this room."
  });
  const missionResponse = store.createSpaceAgentMessage({
    sessionId: roomAgentSession.sessionId,
    role: "assistant",
    content: "",
    status: "RUNNING"
  });
  const request = store.createRoomAgentRequest({
    requestId: `room_agent_request:${suffix}`,
    roomId: room.id,
    sessionId: roomAgentSession.sessionId,
    clientRequestId: `room-agent-${suffix}-0001`,
    promptMessageId: missionPrompt.messageId,
    responseMessageId: missionResponse.messageId
  });
  const mission = store.createRoomAgentMission({
    id: `room_agent_mission:${suffix}`,
    requestId: request.requestId,
    roomId: room.id,
    sessionId: roomAgentSession.sessionId,
    workflowId: `room-supervisor:${suffix}`,
    status: "RUNNING",
    currentPaneId: chatPane.id,
    statusReason: "Running."
  });
  return { room, chatPane, chatSession, chatRun, mission };
}

function addActiveSession(store: InMemorySpaceStore, runtimeId: "cli:codex" | "cli:deepseek" | "cli:root", suffix: string) {
  const room = store.createRoom({ name: `Room ${suffix}`, initialPaneCount: 0 });
  const pane = store.createPane({
    roomId: room.id,
    title: `${suffix} CLI`,
    mode: "TERMINAL",
    terminalRuntimeId: runtimeId,
    cwd: "/etc"
  });
  const session = store.createPaneCliSession({
    paneId: pane.id,
    roomId: room.id,
    runtimeId,
    providerId: runtimeId === "cli:deepseek" ? "deepseek" : runtimeId === "cli:root" ? "root" : "codex",
    agentId: runtimeId.slice(4),
    modelId: runtimeId === "cli:deepseek" ? "deepseek-v4-flash" : runtimeId === "cli:root" ? null : "gpt-5.6-sol",
    reasoningEffort: "medium",
    cwd: "/etc",
    status: "RUNNING",
    statusReason: "test session",
    isActive: true
  });
  store.appendPaneCliTranscriptChunk({
    sessionId: session.sessionId,
    paneId: pane.id,
    roomId: room.id,
    sequence: 0,
    stream: "stdin",
    content: `${suffix} prompt`
  });
  store.appendPaneCliTranscriptChunk({
    sessionId: session.sessionId,
    paneId: pane.id,
    roomId: room.id,
    sequence: 1,
    stream: "stdout",
    content: `${suffix} answer`
  });
  return { room, pane, session };
}

afterEach(async () => {
  try { await Promise.all(apps.splice(0).map((app) => app.close())); }
  finally { await Promise.all(artifactRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); }
});

describe("CLI runtime visibility policy", () => {
  it("expires and consumes opaque disable confirmations and rejects wrong-runtime reuse", async () => {
    const store = new InMemorySpaceStore();
    let nowMs = Date.parse("2026-07-22T12:00:00.000Z");
    const policy = new CliRuntimeVisibilityPolicy({
      store,
      terminateSession: async () => true,
      now: () => nowMs,
      confirmationTtlMs: 1_000
    });

    const wrongRuntimeToken = (await policy.createDisablePreview("cli:deepseek")).confirmationToken;
    await expect(policy.disable("cli:codex", wrongRuntimeToken, "user:admin", "req:test"))
      .rejects.toBeInstanceOf(CliRuntimeDisableConfirmationStaleError);

    const preview = await policy.createDisablePreview("cli:deepseek");
    nowMs += 1_001;
    const expired = await policy.disable("cli:deepseek", preview.confirmationToken, "user:admin", "req:test")
      .catch((error: unknown) => error);
    expect(expired).toBeInstanceOf(CliRuntimeDisableConfirmationStaleError);
    expect((expired as CliRuntimeDisableConfirmationStaleError).preview.confirmationToken)
      .not.toBe(preview.confirmationToken);

    const freshToken = (expired as CliRuntimeDisableConfirmationStaleError).preview.confirmationToken;
    await expect(policy.disable("cli:deepseek", freshToken, "user:admin", "req:test")).resolves.toMatchObject({
      setting: { runtimeId: "cli:deepseek", enabled: false },
      cleanup: { requestedActiveSessionCount: 0, requestedOpenPaneCount: 0 }
    });
    await expect(policy.disable("cli:deepseek", freshToken, "user:admin", "req:test"))
      .rejects.toBeInstanceOf(CliRuntimeDisableConfirmationStaleError);
  });
});

describe("CLI runtime settings API", () => {
  it("requires ADMIN for settings, preview, and updates", async () => {
    const { app } = await setup();
    const headers = authHeaders("OPERATOR");

    const settings = await app.inject({ method: "GET", url: "/api/cli/runtime-settings", headers });
    const preview = await app.inject({
      method: "POST",
      url: "/api/cli/runtime-settings/cli:deepseek/disable-preview",
      headers,
      payload: {}
    });
    const update = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:deepseek",
      headers,
      payload: { enabled: true }
    });

    for (const response of [settings, preview, update]) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("ADMIN_REQUIRED");
    }
  });

  it("defaults all runtimes to enabled and requires a preview even with zero impact", async () => {
    const { app } = await setup();
    const headers = authHeaders("ADMIN");

    const settings = await app.inject({ method: "GET", url: "/api/cli/runtime-settings", headers });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().settings.map((setting: {runtimeId:string})=>setting.runtimeId).sort()).toEqual([...cliToggleRuntimeIds].sort());
    expect(settings.json().settings.every((setting: { enabled: boolean }) => setting.enabled)).toBe(true);

    const missingConfirmation = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:deepseek",
      headers,
      payload: { enabled: false }
    });
    expect(missingConfirmation.statusCode).toBe(422);

    const preview = await app.inject({
      method: "POST",
      url: "/api/cli/runtime-settings/cli:deepseek/disable-preview",
      headers,
      payload: {}
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      runtimeId: "cli:deepseek",
      activeSessionCount: 0,
      openPaneCount: 0
    });

    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:deepseek",
      headers,
      payload: { enabled: false, confirmationToken: preview.json().confirmationToken }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({
      setting: { runtimeId: "cli:deepseek", enabled: false },
      cleanup: { requestedActiveSessionCount: 0, requestedOpenPaneCount: 0 }
    });

    const reused = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:deepseek",
      headers,
      payload: { enabled: false, confirmationToken: preview.json().confirmationToken }
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({
      error: {
        code: "CLI_RUNTIME_DISABLE_CONFIRMATION_STALE",
        details: { runtimeId: "cli:deepseek", activeSessionCount: 0, openPaneCount: 0 }
      }
    });
  });

  it("treats an identity change as stale even when impact counts are unchanged", async () => {
    const store = new InMemorySpaceStore();
    const first = addActiveSession(store, "cli:deepseek", "first");
    const { app } = await setup({ store });
    const headers = authHeaders("ADMIN");

    const preview = await app.inject({
      method: "POST",
      url: "/api/cli/runtime-settings/cli:deepseek/disable-preview",
      headers,
      payload: {}
    });
    store.updatePaneCliSession(first.session.sessionId, { status: "EXITED", isActive: false });
    const replacement = store.createPaneCliSession({
      paneId: first.pane.id,
      roomId: first.room.id,
      runtimeId: "cli:deepseek",
      providerId: "deepseek",
      agentId: "deepseek",
      modelId: "deepseek-v4-flash",
      reasoningEffort: "medium",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "replacement",
      isActive: true
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:deepseek",
      headers,
      payload: { enabled: false, confirmationToken: preview.json().confirmationToken }
    });
    expect(response.statusCode, JSON.stringify(response.json().error ?? {status:response.statusCode})).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "CLI_RUNTIME_DISABLE_CONFIRMATION_STALE",
        details: { activeSessionCount: 1, openPaneCount: 1 }
      }
    });
    expect(response.json().error.details.confirmationToken).not.toBe(preview.json().confirmationToken);
    expect(store.getPaneCliSession(replacement.sessionId)?.isActive).toBe(true);
    expect(store.getCliRuntimeSetting("cli:deepseek").enabled).toBe(true);
  });

  it("terminates and soft-closes only the disabled runtime, then re-enables and reopens the panes it closed", async () => {
    const store = new InMemorySpaceStore();
    const deepseek = addActiveSession(store, "cli:deepseek", "deepseek");
    const codex = addActiveSession(store, "cli:codex", "codex");
    const terminateSession = vi.fn(async () => true);
    const { app } = await setup({ store, terminateSession });
    const headers = authHeaders("ADMIN");

    const preview = await app.inject({
      method: "POST",
      url: "/api/cli/runtime-settings/cli:deepseek/disable-preview",
      headers,
      payload: {}
    });
    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:deepseek",
      headers,
      payload: { enabled: false, confirmationToken: preview.json().confirmationToken }
    });

    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({
      setting: { enabled: false },
      cleanup: {
        requestedActiveSessionCount: 1,
        requestedOpenPaneCount: 1,
        terminatedSessionIds: [deepseek.session.sessionId],
        closedPaneIds: [deepseek.pane.id],
        unresolvedSessionIds: [],
        unresolvedPaneIds: []
      }
    });
    expect(terminateSession).toHaveBeenCalledTimes(1);
    expect(terminateSession).toHaveBeenCalledWith(deepseek.session.sessionId);
    expect(store.getPaneCliSession(deepseek.session.sessionId)).toMatchObject({ status: "EXITED", isActive: false });
    expect(store.getPane(deepseek.pane.id).isClosed).toBe(true);
    expect(store.getPaneCliSession(codex.session.sessionId)).toMatchObject({ status: "RUNNING", isActive: true });
    expect(store.getPane(codex.pane.id).isClosed).toBe(false);

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:deepseek",
      headers,
      payload: { enabled: true }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ setting: { enabled: true }, cleanup: null, restoredPaneIds: [deepseek.pane.id] });
    await vi.waitFor(() => expect(store.getPane(deepseek.pane.id).isClosed).toBe(false));
    expect(store.getPaneCliSession(deepseek.session.sessionId)?.isActive).toBe(false);
    expect(store.getPane(codex.pane.id).isClosed).toBe(false);
  });

  it("restores only panes still closed by the last disable, and only once", async () => {
    const store = new InMemorySpaceStore();
    const kept = addActiveSession(store, "cli:deepseek", "kept");
    const closedAgain = addActiveSession(store, "cli:deepseek", "closed-again");
    const { app } = await setup({ store, terminateSession: async () => true });
    const headers = authHeaders("ADMIN");
    const preview = await app.inject({ method: "POST", url: "/api/cli/runtime-settings/cli:deepseek/disable-preview", headers, payload: {} });
    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:deepseek",
      headers,
      payload: { enabled: false, confirmationToken: preview.json().confirmationToken }
    });
    expect(disabled.json().cleanup.closedPaneIds).toEqual([kept.pane.id, closedAgain.pane.id].sort());
    // The operator closes this pane again after the disable (a later change), so it stays closed.
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.updatePane(closedAgain.pane.id, { title: "Closed on purpose" });

    const enabled = await app.inject({ method: "PATCH", url: "/api/cli/runtime-settings/cli:deepseek", headers, payload: { enabled: true } });
    expect(enabled.json().restoredPaneIds).toEqual([kept.pane.id]);
    await vi.waitFor(() => expect(store.getPane(kept.pane.id).isClosed).toBe(false));
    expect(store.getPane(closedAgain.pane.id).isClosed).toBe(true);

    store.updatePane(kept.pane.id, { isClosed: true, status: "CLOSED" });
    const enabledAgain = await app.inject({ method: "PATCH", url: "/api/cli/runtime-settings/cli:deepseek", headers, payload: { enabled: true } });
    expect(enabledAgain.json().restoredPaneIds).toBeUndefined();
    expect(store.getPane(kept.pane.id).isClosed).toBe(true);
  });

  it("disables Codex while preserving Room Agent and shared native hosts", async () => {
    const store = new InMemorySpaceStore();
    const cli = addActiveSession(store, "cli:codex", "master-cli");
    const native = addActiveChatAndMission(store, "master-native");
    const order: string[] = [];
    const terminateSession = vi.fn(async () => {
      expect(store.getCliRuntimeSetting("cli:codex").enabled).toBe(false);
      order.push("cli");
      return true;
    });
    const interruptChatPane = vi.fn(async (paneId: string) => {
      expect(store.getCliRuntimeSetting("cli:codex").enabled).toBe(false);
      order.push("chat");
      const session = store.getActiveSpaceAgentSession(paneId)!;
      const run = store.getLatestSpaceAgentRun(session.sessionId)!;
      store.updateSpaceAgentRun(run.runId, {
        status: "INTERRUPTED",
        errorCode: "CODEX_MASTER_DISABLED",
        errorMessage: "Codex disabled by an administrator."
      });
      store.updateSpaceAgentSession(session.sessionId, { status: "READY" });
      return true;
    });
    const stopRoomAgentMission = vi.fn(async (roomId: string, missionId: string) => {
      expect(store.getCliRuntimeSetting("cli:codex").enabled).toBe(false);
      order.push("room-agent");
      expect(roomId).toBe(native.room.id);
      store.updateRoomAgentMission(missionId, {
        status: "INTERRUPTED",
        statusReason: "Codex disabled by an administrator."
      });
      return true;
    });
    const killRuntimeProcesses = vi.fn(async (runtimeId: string) => {
      expect(runtimeId).toBe("cli:codex");
      order.push("processes");
      return { matchedPids: [910747, 910809], killedPids: [910747, 910809], remainingPids: [] };
    });
    const countRuntimeProcesses = vi.fn(async (runtimeId: string) => {
      expect(runtimeId).toBe("cli:codex");
      return 2;
    });
    const { app } = await setup({ store, terminateSession, interruptChatPane, stopRoomAgentMission, killRuntimeProcesses, countRuntimeProcesses });
    const headers = authHeaders("ADMIN");

    const preview = await app.inject({
      method: "POST",
      url: "/api/cli/runtime-settings/cli:codex/disable-preview",
      headers,
      payload: {}
    });
    expect(preview.json()).toMatchObject({
      runtimeId: "cli:codex",
      activeSessionCount: 1,
      openPaneCount: 1,
      activeChatRunCount: 1,
      openChatPaneCount: 1,
      activeRoomAgentMissionCount: 0,
      matchingProcessCount: 0
    });

    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:codex",
      headers,
      payload: { enabled: false, confirmationToken: preview.json().confirmationToken }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({
      setting: { runtimeId: "cli:codex", enabled: false },
      cleanup: {
        requestedActiveSessionCount: 1,
        requestedOpenPaneCount: 1,
        requestedActiveChatRunCount: 1,
        requestedOpenChatPaneCount: 1,
        requestedRoomAgentMissionCount: 0,
        terminatedSessionIds: [cli.session.sessionId],
        interruptedChatPaneIds: [native.chatPane.id],
        stoppedRoomAgentMissionIds: [],
        closedPaneIds: [cli.pane.id],
        closedChatPaneIds: [native.chatPane.id],
        unresolvedSessionIds: [],
        unresolvedChatPaneIds: [],
        unresolvedRoomAgentMissionIds: [],
        unresolvedPaneIds: [],
        killedProcessCount: 0,
        remainingProcessCount: 0,
        processSweepFailed: false
      }
    });
    expect(order).toEqual(["cli", "chat"]);
    expect(killRuntimeProcesses).not.toHaveBeenCalled();
    expect(countRuntimeProcesses).not.toHaveBeenCalled();
    expect(store.getPane(cli.pane.id).isClosed).toBe(true);
    expect(store.getPane(native.chatPane.id).isClosed).toBe(true);
    expect(store.getLatestSpaceAgentRun(native.chatSession.sessionId)?.status).toBe("INTERRUPTED");
    expect(store.getRoomAgentMission(native.room.id, native.mission.id)?.status).toBe("RUNNING");

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:codex",
      headers,
      payload: { enabled: true }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().restoredPaneIds).toEqual([cli.pane.id]);
    await vi.waitFor(() => expect(store.getPane(cli.pane.id).isClosed).toBe(false));
    expect(store.getPane(native.chatPane.id).isClosed).toBe(true);
    expect(store.getLatestSpaceAgentRun(native.chatSession.sessionId)?.status).toBe("INTERRUPTED");
    expect(store.getRoomAgentMission(native.room.id, native.mission.id)?.status).toBe("RUNNING");
  });

  it("records processSweepFailed when the runtime process sweep throws, but still disables", async () => {
    const store = new InMemorySpaceStore();
    const killRuntimeProcesses = vi.fn(async () => {
      throw new Error("sweep failed");
    });
    const countRuntimeProcesses = vi.fn(async () => 1);
    const { app } = await setup({ store, killRuntimeProcesses, countRuntimeProcesses });
    const headers = authHeaders("ADMIN");

    const preview = await app.inject({
      method: "POST",
      url: "/api/cli/runtime-settings/cli:deepseek/disable-preview",
      headers,
      payload: {}
    });
    expect(preview.json()).toMatchObject({ matchingProcessCount: 1 });

    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:deepseek",
      headers,
      payload: { enabled: false, confirmationToken: preview.json().confirmationToken }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({
      setting: { runtimeId: "cli:deepseek", enabled: false },
      cleanup: {
        killedProcessCount: 0,
        remainingProcessCount: 0,
        processSweepFailed: true
      }
    });
  });

  it("interrupts an active Chat run even when its pane was already closed", async () => {
    const store = new InMemorySpaceStore();
    const native = addActiveChatAndMission(store, "closed-chat-run");
    await store.updatePane(native.chatPane.id, { isClosed: true, status: "CLOSED" });
    const interruptChatPane = vi.fn(async () => true);
    const stopRoomAgentMission = vi.fn(async () => true);
    const { app } = await setup({ store, interruptChatPane, stopRoomAgentMission, killRuntimeProcesses: noopKill });
    const headers = authHeaders("ADMIN");

    const preview = await app.inject({
      method: "POST",
      url: "/api/cli/runtime-settings/cli:codex/disable-preview",
      headers,
      payload: {}
    });
    expect(preview.json()).toMatchObject({
      activeChatRunCount: 1,
      openChatPaneCount: 0
    });

    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:codex",
      headers,
      payload: { enabled: false, confirmationToken: preview.json().confirmationToken }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({
      cleanup: {
        requestedActiveChatRunCount: 1,
        requestedOpenChatPaneCount: 0,
        interruptedChatPaneIds: [native.chatPane.id],
        closedChatPaneIds: []
      }
    });
    expect(interruptChatPane).toHaveBeenCalledWith(
      native.chatPane.id,
      "Codex disabled by an administrator.",
      expect.any(String)
    );
  });

  it("remains fail-closed and reports exact unresolved sessions after partial cleanup", async () => {
    const store = new InMemorySpaceStore();
    const first = addActiveSession(store, "cli:deepseek", "first");
    const second = addActiveSession(store, "cli:deepseek", "second");
    const terminateSession = vi.fn(async (sessionId: string) => sessionId !== second.session.sessionId);
    const { app } = await setup({ store, terminateSession });
    const headers = authHeaders("ADMIN");

    const preview = await app.inject({
      method: "POST",
      url: "/api/cli/runtime-settings/cli:deepseek/disable-preview",
      headers,
      payload: {}
    });
    const response = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:deepseek",
      headers,
      payload: { enabled: false, confirmationToken: preview.json().confirmationToken }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      setting: { runtimeId: "cli:deepseek", enabled: false },
      cleanup: {
        terminatedSessionIds: [first.session.sessionId],
        unresolvedSessionIds: [second.session.sessionId],
        closedPaneIds: [first.pane.id],
        unresolvedPaneIds: [second.pane.id]
      }
    });
    expect(store.getCliRuntimeSetting("cli:deepseek").enabled).toBe(false);
    expect(store.getPaneCliSession(second.session.sessionId)).toMatchObject({ status: "RUNNING", isActive: true });
    expect(response.json().cleanup.unresolvedPaneIds).toEqual([second.pane.id]);
    expect(store.getPane(second.pane.id).isClosed).toBe(false);
  });

  it("reports unresolved Chat cleanup while preserving Room Agent", async () => {
    const store = new InMemorySpaceStore();
    const native = addActiveChatAndMission(store, "partial-native");
    const { app } = await setup({
      store,
      interruptChatPane: async () => false,
      stopRoomAgentMission: async () => false,
      killRuntimeProcesses: noopKill
    });
    const headers = authHeaders("ADMIN");
    const preview = await app.inject({
      method: "POST",
      url: "/api/cli/runtime-settings/cli:codex/disable-preview",
      headers,
      payload: {}
    });
    const response = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:codex",
      headers,
      payload: { enabled: false, confirmationToken: preview.json().confirmationToken }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      setting: { runtimeId: "cli:codex", enabled: false },
      cleanup: {
        unresolvedChatPaneIds: [native.chatPane.id],
        unresolvedRoomAgentMissionIds: [],
        closedChatPaneIds: [native.chatPane.id]
      }
    });
    expect(store.getCliRuntimeSetting("cli:codex").enabled).toBe(false);
    expect(store.getLatestSpaceAgentRun(native.chatSession.sessionId)?.status).toBe("RUNNING");
    expect(store.getRoomAgentMission(native.room.id, native.mission.id)?.status).toBe("RUNNING");
  });

  it("filters disabled runtimes, panes, history, and activity before pagination and restores records unchanged", async () => {
    const store = new InMemorySpaceStore();
    const deepseek = addActiveSession(store, "cli:deepseek", "newest-deepseek");
    const codex = addActiveSession(store, "cli:codex", "older-codex");
    const root = addActiveSession(store, "cli:root", "root-remains-visible");
    store.updateCliRuntimeSetting(
      "cli:deepseek",
      { enabled: false, confirmationToken: "d".repeat(32) },
      "user:admin"
    );
    const { app } = await setup({ store });
    const headers = authHeaders("ADMIN");

    const runtimes = await app.inject({ method: "GET", url: "/api/cli/runtimes", headers });
    expect(runtimes.statusCode).toBe(200);
    expect(runtimes.json().data.map((runtime: { id: string }) => runtime.id)).not.toContain("cli:deepseek");

    const tasks = await app.inject({ method: "GET", url: "/api/cli/tasks?page=1&pageSize=1", headers });
    expect(tasks.statusCode).toBe(200);
    expect(tasks.json()).toMatchObject({
      total: 2,
      page: 1,
      pageSize: 1
    });
    expect(tasks.json().threads[0].runtimeId).not.toBe("cli:deepseek");
    const rootTask = await app.inject({ method: "GET", url: "/api/cli/tasks?page=1&pageSize=1&q=root-remains-visible", headers });
    expect(rootTask.json()).toMatchObject({
      total: 1,
      threads: [{ runtimeId: "cli:root", taskId: root.session.sessionId }]
    });

    const panes = await app.inject({
      method: "GET",
      url: `/api/panes?roomId=${encodeURIComponent(deepseek.room.id)}&includeClosed=true`,
      headers
    });
    expect(panes.statusCode).toBe(200);
    expect(panes.json().data).toEqual([]);

    const activity = await app.inject({ method: "GET", url: "/api/rooms/cli-activity", headers });
    expect(activity.statusCode).toBe(200);
    // Room activity also reports open panes (7929588575); disabled runtimes stay hidden.
    expect(activity.json().data).toEqual(expect.arrayContaining([
      { roomId: deepseek.room.id, paneCount: 1, runningCliCount: 0, runtimeIds: [] },
      { roomId: codex.room.id, paneCount: 1, runningCliCount: 1, runtimeIds: ["cli:codex"] }
    ]));

    store.updateCliRuntimeSetting("cli:deepseek", { enabled: true }, "user:admin");
    const restored = await app.inject({ method: "GET", url: "/api/cli/tasks?page=1&pageSize=10", headers });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().total).toBe(3);
    expect(restored.json().threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtimeId: "cli:deepseek", taskId: deepseek.session.sessionId })
    ]));
    expect(store.getPaneCliSession(deepseek.session.sessionId)).toMatchObject({
      sessionId: deepseek.session.sessionId,
      runtimeId: "cli:deepseek",
      status: "RUNNING",
      isActive: true
    });
  });

  it("hides the Codex runtime from the launcher registry while the master is Off", async () => {
    const store = new InMemorySpaceStore();
    store.updateCliRuntimeSetting(
      "cli:codex",
      { enabled: false, confirmationToken: "c".repeat(32) },
      "user:admin"
    );
    const { app } = await setup({ store });

    const runtimes = await app.inject({
      method: "GET",
      url: "/api/cli/runtimes",
      headers: authHeaders("ADMIN")
    });

    expect(runtimes.statusCode).toBe(200);
    expect(runtimes.json().data.map((runtime: { id: string }) => runtime.id)).not.toContain("cli:codex");
    expect(runtimes.json().data.map((runtime: { id: string }) => runtime.id)).toContain("cli:root");
  });

  it("rejects disabled runtimes on direct create, login, attach, and session routes", async () => {
    const store = new InMemorySpaceStore();
    const deepseek = addActiveSession(store, "cli:deepseek", "disabled-routes");
    store.updateCliRuntimeSetting(
      "cli:deepseek",
      { enabled: false, confirmationToken: "e".repeat(32) },
      "user:admin"
    );
    const { app } = await setup({ store });
    const headers = authHeaders("ADMIN");

    const requests = [
      app.inject({
        method: "POST",
        url: "/api/panes",
        headers,
        payload: {
          roomId: deepseek.room.id,
          title: "Blocked DeepSeek",
          mode: "TERMINAL",
          terminalRuntimeId: "cli:deepseek"
        }
      }),
      app.inject({
        method: "POST",
        url: `/api/rooms/${encodeURIComponent(deepseek.room.id)}/panes`,
        headers,
        payload: { panes: [{ mode: "TERMINAL", terminalRuntimeId: "cli:deepseek" }] }
      }),
      app.inject({
        method: "POST",
        url: `/api/rooms/${encodeURIComponent(deepseek.room.id)}/cli-login`,
        headers,
        payload: { runtimeId: "cli:deepseek" }
      }),
      app.inject({
        method: "GET",
        url: `/api/panes/${encodeURIComponent(deepseek.pane.id)}/cli/session`,
        headers
      }),
      app.inject({
        method: "POST",
        url: `/api/panes/${encodeURIComponent(deepseek.pane.id)}/cli/session`,
        headers,
        payload: { runtimeId: "cli:deepseek", resume: false }
      })
    ];

    for (const [index,response] of (await Promise.all(requests)).entries()) {
      // Batch pane creation reports a catalog conflict for an unavailable type.
      expect(response.statusCode, `request ${index}: ${JSON.stringify(response.json().error ?? {status:response.statusCode})}`).toBe(index === 1 ? 409 : 503);
      expect(response.json()).toMatchObject({ error: { code: index === 1 ? "CONFLICT" : "CLI_RUNTIME_DISABLED" } });
    }
  });

  it("hides disabled task sources from resume and rejects a disabled resume target", async () => {
    const store = new InMemorySpaceStore();
    const deepseek = addActiveSession(store, "cli:deepseek", "deepseek-source");
    const codex = addActiveSession(store, "cli:codex", "codex-source");
    store.updateCliRuntimeSetting(
      "cli:deepseek",
      { enabled: false, confirmationToken: "f".repeat(32) },
      "user:admin"
    );
    const { app } = await setup({ store });
    const headers = authHeaders("ADMIN");

    const hiddenSource = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(codex.pane.id)}/cli/resume`,
      headers,
      payload: { taskId: deepseek.session.sessionId }
    });
    expect(hiddenSource.statusCode).toBe(404);
    expect(hiddenSource.json().error.code).toBe("NOT_FOUND");

    const disabledTarget = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(deepseek.pane.id)}/cli/resume`,
      headers,
      payload: { taskId: codex.session.sessionId }
    });
    expect(disabledTarget.statusCode).toBe(503);
    expect(disabledTarget.json().error.code).toBe("CLI_RUNTIME_DISABLED");
  });

  it("accepts DeepSeek uploads into the standard pipeline and blocks all disabled CLI scoped queries", async () => {
    const store = new InMemorySpaceStore();
    const deepseek = addActiveSession(store, "cli:deepseek", "deepseek-upload");
    const { app } = await setup({ store });
    const headers = authHeaders("ADMIN");

    const emptyUpload = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(deepseek.pane.id)}/cli/uploads`,
      headers: { ...headers, "content-type": "multipart/form-data; boundary=unused" },
      payload: "--unused--\r\n"
    });
    expect(emptyUpload.statusCode).toBe(422);
    expect(emptyUpload.json().error.code).toBe("EMPTY_UPLOAD");

    store.updateCliRuntimeSetting(
      "cli:deepseek",
      { enabled: false, confirmationToken: "g".repeat(32) },
      "user:admin"
    );
    const scopedResponses = await Promise.all([
      app.inject({
        method: "GET",
        url: `/api/panes/${encodeURIComponent(deepseek.pane.id)}/cli/model-settings`,
        headers
      }),
      app.inject({
        method: "POST",
        url: `/api/panes/${encodeURIComponent(deepseek.pane.id)}/cli/uploads`,
        headers: { ...headers, "content-type": "multipart/form-data; boundary=unused" },
        payload: "--unused--\r\n"
      }),
      app.inject({
        method: "POST",
        url: `/api/panes/${encodeURIComponent(deepseek.pane.id)}/cli/clipboard-debug`,
        headers,
        payload: { severity: "info", title: "blocked", detail: "blocked" }
      })
    ]);
    for (const response of scopedResponses) {
      expect(response.statusCode, JSON.stringify(response.json().error ?? {status:response.statusCode})).toBe(503);
      expect(response.json().error.code).toBe("CLI_RUNTIME_DISABLED");
    }
  });

  it("preserves read-only Codex history and goals while blocking goal mutations", async () => {
    const store = new InMemorySpaceStore();
    store.updateCliRuntimeSetting(
      "cli:codex",
      { enabled: false, confirmationToken: "h".repeat(32) },
      "user:admin"
    );
    // An empty Codex state database instead of the host's ~/.codex, and no host environment inspector.
    const codexHome = await mkdtemp(join(tmpdir(), "runtime-settings-codex-"));
    artifactRoots.push(codexHome);
    execFileSync("sqlite3", [join(codexHome, "state_5.sqlite"), "create table threads(id text primary key, rollout_path text, title text, preview text, model text, reasoning_effort text, cwd text, archived integer, source text, model_provider text, thread_source text, first_user_message text, updated_at integer, updated_at_ms integer, recency_at integer, recency_at_ms integer);"]);
    const { app } = await setup({ store, codexParity: createCodexParityService({ codexHome, environmentInspectorCommand: null, threadRenameCommand: null }) });
    const headers = authHeaders("ADMIN");

    const history = await app.inject({ method: "GET", url: "/api/codex/history?page=1&pageSize=1", headers });
    expect(history.statusCode).toBe(200);
    expect(Array.isArray(history.json().data)).toBe(true);
    expect(history.json().pagination).toMatchObject({ page: 1, pageSize: 1 });

    const environment = await app.inject({ method: "GET", url: "/api/codex/environment", headers });
    expect(environment.statusCode).toBe(200);
    expect(environment.json().isCodexEnabled).toBe(false);

    const goals = await app.inject({ method: "GET", url: "/api/tasks?source=codex_goal&page=1&pageSize=1", headers });
    expect(goals.statusCode).toBe(200);
    expect(Array.isArray(goals.json().data)).toBe(true);
    expect(goals.json().pagination).toMatchObject({ page: 1, pageSize: 1 });

    const updateGoal = await app.inject({
      method: "PATCH",
      url: "/api/tasks/codex-goals/thread:disabled",
      headers,
      payload: { status: "complete" }
    });
    expect(updateGoal.statusCode).toBe(409);
    expect(updateGoal.json().error.code).toBe("CODEX_MASTER_DISABLED");
  });

  it("blocks Codex mutations with one master error while leaving emergency interrupt and stop routes available", async () => {
    const store = new InMemorySpaceStore();
    store.upsertUser({ id: "user:admin", email: "admin@space.local", role: "ADMIN" });
    const room = store.createRoom({ name: "Disabled Codex resume", initialPaneCount: 0 });
    const codexPane = store.createPane({
      roomId: room.id,
      title: "Disabled Codex",
      mode: "TERMINAL",
      terminalRuntimeId: "cli:codex"
    });
    const chatPane = store.createPane({
      roomId: room.id,
      title: "Disabled Chat",
      mode: "CHAT",
      providerId: "codex-lb",
      modelId: "gpt-5.6-sol"
    });
    store.updateCliRuntimeSetting(
      "cli:codex",
      { enabled: false, confirmationToken: "i".repeat(32) },
      "user:admin"
    );
    const { app } = await setup({ store });
    const headers = authHeaders("ADMIN");

    const roomAgent = await app.inject({ method: "GET", url: `/api/rooms/${encodeURIComponent(room.id)}/room-agent`, headers });
    expect(roomAgent.statusCode).toBe(200);

    const blocked = await Promise.all([
      app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(chatPane.id)}/agent-session`, headers, payload: {} }),
      app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(chatPane.id)}/agent/messages`, headers, payload: {} }),
      app.inject({ method: "PATCH", url: `/api/panes/${encodeURIComponent(chatPane.id)}/agent/settings`, headers, payload: {} }),
      app.inject({ method: "PUT", url: `/api/panes/${encodeURIComponent(chatPane.id)}/agent/goal`, headers, payload: {} }),
      app.inject({ method: "GET", url: "/api/admin/codex-usage-accounts", headers }),
      app.inject({ method: "GET", url: "/api/admin/provider-switch-targets", headers }),
      app.inject({ method: "GET", url: "/api/admin/codex-lb-speed-defaults", headers }),
      app.inject({ method: "PATCH", url: "/api/provider-settings", headers, payload: {} }),
      app.inject({ method: "POST", url: "/api/integrations/telegram/pairings", headers, payload: {} }),
      app.inject({ method: "POST", url: "/api/admin/codex-app-server/handshake", headers, payload: {} }),
      app.inject({
        method: "POST",
        url: "/api/rooms",
        headers,
        payload: { name: "Blocked Chat room", initialPaneCount: 1 }
      }),
      app.inject({
        method: "POST",
        url: `/api/rooms/${encodeURIComponent(room.id)}/panes`,
        headers,
        payload: { panes: [{ mode: "CHAT" }] }
      }),
      app.inject({
        method: "POST",
        url: "/api/panes",
        headers,
        payload: { roomId: room.id, title: "Blocked Chat", mode: "CHAT" }
      }),
      app.inject({
        method: "PATCH",
        url: `/api/panes/${encodeURIComponent(chatPane.id)}`,
        headers,
        payload: { isClosed: false }
      }),
      app.inject({
        method: "POST",
        url: `/api/panes/${encodeURIComponent(codexPane.id)}/cli/resume`,
        headers,
        payload: { taskId: "cli_task:missing" }
      })
    ]);
    for (const response of blocked) {
      expect(response.statusCode, JSON.stringify(response.json().error ?? {status:response.statusCode})).toBe(409);
      expect(response.json().error.code).toBe("CODEX_MASTER_DISABLED");
    }

    const sharedHistoryPreview = await app.inject({
      method: "POST",
      url: "/api/admin/codex-history-purge-previews",
      headers,
      payload: {}
    });
    expect(sharedHistoryPreview.statusCode).toBe(200);
    expect(sharedHistoryPreview.json().candidates).toMatchObject({
      threads: 0,
      indexEntries: 0,
      rolloutFiles: 0,
      shellSnapshots: 0
    });

    const emergency = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/panes/pane:missing/agent/interrupt",
        headers,
        payload: {}
      }),
      app.inject({
        method: "POST",
        url: "/api/rooms/room:missing/room-agent/stop",
        headers,
        payload: { reason: "Emergency cleanup." }
      }),
      app.inject({
        method: "POST",
        url: "/api/rooms/room:missing/room-agent/control",
        headers,
        payload: { action: "STOP", reason: "Emergency cleanup." }
      })
    ]);
    for (const response of emergency) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("NOT_FOUND");
    }
  });
});
