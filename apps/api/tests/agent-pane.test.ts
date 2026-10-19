import { afterEach, describe, expect, it, vi } from "vitest";
import { agentPaneSessionSchema, type DummyTurnInput, type TurnStartResult } from "@space/contracts";
import { resolveOpenCodeTitleFallbackControl } from "@space/opencode-control";
import { attachedRequestRules } from "../src/attachment-context.js";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp, type CreateAppOptions } from "../src/app.js";
import type { BrowserSessionManager } from "../src/browser-sessions.js";
import { getApiConfig } from "../src/config.js";
import { cliChatProviderEnabledByRuntimeToggle, cliRuntimeModelsChatProviderAdapter } from "../src/chat-providers.js";
import { createSpaceAgentAdapter as createCachedSpaceAgentAdapter } from "../src/space-agent.js";
import { cookieName } from "../src/auth.js";
import { createDecisionsService } from "../src/decisions-service.js";
import type { TurnStarter } from "../src/turns.js";

// API fixtures must never discover a live OpenCode server or project their
// in-memory runtime settings into the production visibility cache.
vi.mock("@space/opencode-control", async (importOriginal) => ({
  ...await importOriginal<typeof import("@space/opencode-control")>(),
  resolveOpenCodeTitleFallbackControl: vi.fn(async () => null)
}));
vi.mock("../src/cli-runtime-visibility.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/cli-runtime-visibility.js")>();
  return { ...original, CliRuntimeVisibilityPolicy: class extends original.CliRuntimeVisibilityPolicy {
    override async syncVisibilityFile() {}
  } };
});

vi.mock("../src/system-health-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/system-health-service.js")>();
  return { ...original, SystemHealthMonitor: class extends original.SystemHealthMonitor {
    // Health checks include real Temporal/host probes; they are not Chat fixtures.
    override start() {}
  } };
});

const csrfHeaderName = "x-space-csrf-token";
// These fixtures mutate catalog responses synchronously between operations.
// Cache behavior has its own clock-controlled and default-adapter coverage.
function createSpaceAgentAdapter(options: Parameters<typeof createCachedSpaceAgentAdapter>[0]) {
  return createCachedSpaceAgentAdapter({ ...options, modelCatalogCacheMaxAgeMs: 0 });
}
const redactionQueryKey = "tok" + "en";
const redactionFixtureValue = "fixture-credential";
const frameTicketTokenKey = "tok" + "en" as "token";

class FakeCodexTurnStarter implements TurnStarter {
  readonly started: DummyTurnInput[] = [];

  plan(input: DummyTurnInput): TurnStartResult {
    return {
      workflowId: `workflow:codex-app-server:${input.roomId}:${input.paneId}:${input.traceId}`,
      runId: null,
      roomId: input.roomId,
      paneId: input.paneId,
      traceId: input.traceId,
      status: "QUEUED",
      runtime: "CODEX_APP_SERVER",
      artifactIds: input.artifactIds ?? []
    };
  }

  async start(input: DummyTurnInput): Promise<TurnStartResult> {
    this.started.push(input);
    return {
      ...this.plan(input),
      runId: "temporal:test-run"
    };
  }
}

class FakeCodexAgentControl {
  requirementsCalls = 0;
  modelCalls = 0;
  collaborationCalls = 0;
  failRequirements = false;
  failModels = false;
  requirementsGate: Promise<void> | null = null;
  requirementsGates: Promise<void>[] = [];
  onRequirementsStarted: (() => void) | null = null;
  modelListGate: Promise<void> | null = null;
  onModelListStarted: (() => void) | null = null;
  requirements = {
    allowedApprovalPolicies: ["on-request", "never"],
    allowedApprovalsReviewers: ["user", "guardian_subagent"],
    allowedSandboxModes: ["workspace-write", "danger-full-access"],
    defaultPermissions: null
  };
  models = [
    {
      id: "gpt-provider-verified",
      displayName: "gpt-provider-verified",
      description: "Default fake Codex model.",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"]
    }
  ];
  collaborationModes = [
    { name: "Default", mode: "default" as const, model: null, reasoning_effort: null },
    { name: "Plan", mode: "plan" as const, model: null, reasoning_effort: null }
  ];
  readonly goals = new Map<string, {
    threadId: string;
    objective: string;
    status: "active";
    tokenBudget: number | null;
    tokensUsed: number;
    timeUsedSeconds: number;
    createdAt: string;
    updatedAt: string;
  }>();

  async readConfigRequirements() {
    this.requirementsCalls += 1;
    this.onRequirementsStarted?.();
    const gate = this.requirementsGates.shift() ?? this.requirementsGate;
    if (gate) await gate;
    if (this.failRequirements) throw new Error("requirements unavailable");
    return this.requirements;
  }

  async listModels() {
    this.modelCalls += 1;
    this.onModelListStarted?.();
    if (this.modelListGate) await this.modelListGate;
    if (this.failModels) throw new Error("model catalog unavailable");
    return this.models;
  }

  async listCollaborationModes() {
    this.collaborationCalls += 1;
    return this.collaborationModes;
  }

  goalTokenBudgets: Array<number | null | undefined> = [];

  async setGoal(input: { threadId?: string | null; objective: string; status?: string | null; tokenBudget?: number | null }) {
    this.goalTokenBudgets.push(input.tokenBudget);
    const threadId = input.threadId ?? "thread:goal-created";
    const now = "2026-07-10T12:00:00.000Z";
    const goal = {
      threadId,
      objective: input.objective,
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now
    };
    this.goals.set(threadId, goal);
    return { threadId, goal };
  }

  async clearGoal(threadId: string) {
    const cleared = this.goals.delete(threadId);
    return { threadId, goal: null, cleared };
  }

  codexGoalsAdapter() {
    return {
      list: async () =>
        Array.from(this.goals.values()).map((goal) => ({
          id: `codex_goal:${goal.threadId}`,
          source: "codex_goal" as const,
          threadId: goal.threadId,
          goalId: `goal:${goal.threadId}`,
          title: goal.objective,
          status: goal.status,
          tokenBudget: goal.tokenBudget,
          tokensUsed: goal.tokensUsed,
          timeUsedSeconds: goal.timeUsedSeconds,
          createdAt: goal.createdAt,
          updatedAt: goal.updatedAt
        })),
      update: async () => null
    };
  }
}

function fakeBrowserSessionManager(store: InMemorySpaceStore) {
  const actionInputs: unknown[] = [];
  const manager: BrowserSessionManager = {
    status: () => ({
      enabled: true,
      statusReason: "Browser sessions enabled for test.",
      defaultUrl: "https://www.google.com/",
      checkedAt: "2026-07-05T00:00:00.000Z"
    }),
    startOrRestore: async () => {
      throw new Error("not needed in this test");
    },
    getActive: async () => null,
    navigate: async () => {
      throw new Error("not needed in this test");
    },
    setViewport: async () => {
      throw new Error("not needed in this test");
    },
    action: async (pane, input) => {
      actionInputs.push(input);
      const session = store.getActivePaneBrowserSession(pane.id);
      if (!session) throw new Error("missing browser session");
      return {
        session: {
          ...session,
          currentUrl: `https://www.google.com/?${redactionQueryKey}=${redactionFixtureValue}&category=tea`,
          title: `Olla ${redactionQueryKey}=${redactionFixtureValue}`
        },
        frame: {
          sessionId: session.sessionId,
          paneId: session.paneId,
          roomId: session.roomId,
          status: "READY",
          viewport: session.viewport,
          currentUrl: `https://www.google.com/?${redactionQueryKey}=${redactionFixtureValue}&category=tea`,
          title: `Olla ${redactionQueryKey}=${redactionFixtureValue}`,
          screenshotDataUrl: "data:image/png;base64,aGVsbG8=",
          capturedAt: "2026-07-05T00:00:00.000Z"
        },
        text: `Observed page text with ${redactionQueryKey}=${redactionFixtureValue}`
      };
    },
    captureFrame: async () => {
      throw new Error("not needed in this test");
    },
    stopPane: async () => {},
    stopRoom: async () => {},
    closeAll: async () => {},
    issueFrameTicket: () => ({
      paneId: "pane:test",
      sessionId: "browser_session:test",
      [frameTicketTokenKey]: "browser-frame-ticket-test-value",
      expiresAt: "2026-07-05T00:01:00.000Z"
    }),
    acceptFrameTicket: () => true
  };
  return { manager, actionInputs };
}

function enabledConfig() {
  return getApiConfig({
    SPACE_AGENT_PANE_ENABLED: "true",
    SPACE_ENABLE_CODEX_TURNS: "true",
    SPACE_CODEX_APP_SERVER_ENABLED: "true",
    SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
    SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
    SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
  });
}

function verifiedModel(providerId: string, id = "gpt-provider-verified", reasoning = "medium" as const) {
  return {
    id,
    providerId,
    displayName: id,
    status: "VERIFIED" as const,
    contextWindow: 128000,
    supportsTools: true,
    supportsVision: false,
    supportsRealtime: false,
    supportsReasoning: true,
    defaultReasoningEffort: reasoning
  };
}

function verifyProvider(
  store: InMemorySpaceStore,
  providerId = "codex-lb",
  models = [verifiedModel(providerId)]
) {
  if (!store.listProviders().some((provider) => provider.id === providerId)) {
    store.createProvider({
      id: providerId,
      displayName: providerId === "direct-246-primary" ? "Direct .246 Primary" : "Route Provider",
      type: "CODEX_LB",
      routeProfile: providerId === "direct-246-primary" ? "direct-primary" : "custom",
      backingProviderId: "codex-lb"
    });
  }
  store.recordProviderValidation({
    providerId,
    status: "VERIFIED",
    code: "VERIFIED",
    statusReason: "Credential smoke passed.",
    checkedAt: "2026-07-06T00:00:00.000Z",
    maskedKeyPrefix: "sk-c...test",
    credentialLabel: "space-test",
    modelCount: models.length
  });
  store.replaceProviderModels(providerId, models);
}

function useVerifiedDefaultProvider(
  store: InMemorySpaceStore,
  providerId = "codex-lb",
  models = [verifiedModel(providerId)]
) {
  if (providerId !== "codex-lb") {
    store.updateProviderSettings({ defaultProviderId: providerId });
  }
  verifyProvider(store, providerId, models);
}

const ownedApps = new Set<Awaited<ReturnType<typeof createApp>>>();
afterEach(async () => {
  const apps = [...ownedApps];
  ownedApps.clear();
  await Promise.all(apps.map(app => app.close()));
});

async function authedApp(options: CreateAppOptions = {}) {
  const defaultControl = new FakeCodexAgentControl();
  if (options.store) {
    const storedModels = (await options.store.listModels()).filter((model) => model.status === "VERIFIED");
    if (storedModels.length) {
      defaultControl.models = storedModels.map((model, index) => ({
        id: model.runtimeId ?? model.id.replace(`${model.providerId}:`, ""),
        displayName: model.displayName,
        isDefault: index === 0,
        defaultReasoningEffort: model.defaultReasoningEffort ?? "medium",
        supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"]
      }));
    }
  }
  const codexAgentControl = Object.hasOwn(options, "codexAgentControl") ? options.codexAgentControl : defaultControl;
  const app = await createApp({
    config: enabledConfig(),
    decisionsService: createDecisionsService({ enabled: false, readFileImpl: async () => "" }),
    modelCatalogCacheMaxAgeMs: 0,
    cancelWorkflow: async () => {},
    ...options,
    codexAgentControl,
    codexGoals: options.codexGoals ?? (codexAgentControl instanceof FakeCodexAgentControl ? codexAgentControl.codexGoalsAdapter() : undefined),
    auth: {
      sessionSecret: "test-secret-with-enough-length",
      devLogin: true,
      secureCookies: false,
      ...(options.auth ?? {})
    }
  });
  ownedApps.add(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "space@space.local", password: "space-dev" }
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.find(item => item.name === cookieName && item.value)?.value;
  expect(cookie).toBeTruthy();
  const cookieHeader = `${cookieName}=${cookie}`;
  const csrf = await app.inject({
    method: "GET",
    url: "/api/auth/csrf",
    headers: { cookie: cookieHeader }
  });
  expect(csrf.statusCode).toBe(200);
  return { app, cookie: cookieHeader, csrfToken: csrf.json().csrfToken as string };
}

describe("Space API native agent panes", () => {
  describe("durable Chat submissions", () => {
    async function fixture() {
      const store = new InMemorySpaceStore();
      useVerifiedDefaultProvider(store);
      const room = store.createRoom({ name: "Submission receipts", initialPaneCount: 1 });
      const pane = store.listPanes(room.id)[0]!;
      const starter = new FakeCodexTurnStarter();
      const options = { store, config: enabledConfig(), codexTurnStarter: starter, codexAgentControl: new FakeCodexAgentControl() };
      const adapter = createSpaceAgentAdapter(options);
      await adapter.loadSession({ pane });
      const input = { pane, content: "Check this request.", clientRequestId: "request:once", traceId: "trace:first", operatorUserId: "user:operator" };
      return { store, pane, starter, options, adapter, input };
    }

    it("accepts concurrent duplicate requests once and replays after adapter reconstruction", async () => {
      const f = await fixture();
      const other = createSpaceAgentAdapter(f.options);
      const [a, b] = await Promise.all([f.adapter.sendMessage(f.input), other.sendMessage({ ...f.input, traceId: "trace:second" })]);
      expect(a.submission).toEqual(b.submission);
      expect(f.starter.started).toHaveLength(1);
      expect(f.store.listSpaceAgentMessages(a.submission!.sessionId)).toHaveLength(2);
      const replay = await createSpaceAgentAdapter(f.options).sendMessage({ ...f.input, traceId: "trace:recovered" });
      expect(replay.submission).toEqual(a.submission);
      expect(f.starter.started).toHaveLength(1);
    });

    it("persists declared checks and rejects changed checks on replay", async () => {
      const f = await fixture();
      const acceptance = { version: 1 as const, checks: [{ id: "answer", kind: "TEXT_EQUALS" as const,
        expected: "42", normalization: "TRIM" as const, critical: true }] };
      const accepted = await f.adapter.sendMessage({ ...f.input, acceptance });
      expect(f.store.getLatestSpaceAgentRun(accepted.submission!.sessionId)?.execution?.acceptance).toEqual(acceptance);
      expect((await f.adapter.sendMessage({ ...f.input, acceptance })).submission).toEqual(accepted.submission);
      for (const changed of [undefined, { ...acceptance, checks: [{ ...acceptance.checks[0]!, expected: "43" }] }]) {
        await expect(f.adapter.sendMessage({ ...f.input, acceptance: changed })).rejects.toThrow("different request");
      }
      expect(f.starter.started).toHaveLength(1);
      f.store.updateSpaceAgentRun(accepted.submission!.runId, { status: "FAILED" });
      expect((await f.adapter.prepareRetry({ pane: f.pane })).acceptance).toEqual(acceptance);
    });

    it("rejects changed content, attachments, actor, model and tools under an accepted key", async () => {
      const f = await fixture();
      await f.adapter.sendMessage(f.input);
      for (const change of [{ content: "Another request" }, { artifactIds: ["artifact:other"] },
        { operatorUserId: "user:another" }, { selectedModelConfigId: "other:model" }, { selectedToolIds: ["browser"] }]) {
        await expect(f.adapter.sendMessage({ ...f.input, ...change })).rejects.toThrow("different request");
      }
      expect(f.starter.started).toHaveLength(1);
    });

    it("replays accepted requests even when their original attachment is subsequently deleted", async () => {
      const f = await fixture();
      const artifact = f.store.createArtifact({ roomId: f.pane.roomId, paneId: f.pane.id, kind: "IMAGE", mimeType: "image/png",
        storageUri: "space-artifact://user-uploads/retry.png", sha256: "a".repeat(64), byteSize: 100, metadata: {} }).artifact;
      const input = { ...f.input, artifactIds: [artifact.id] };
      const accepted = await f.adapter.sendMessage(input);
      f.store.updateArtifactRetention(artifact.id, { deletedAt: new Date().toISOString() });
      expect((await f.adapter.sendMessage(input)).submission).toEqual(accepted.submission);
      expect(f.starter.started).toHaveLength(1);
    });

    it("does not leave transcript messages when planning fails", async () => {
      const f = await fixture();
      vi.spyOn(f.starter, "plan").mockImplementation(() => { throw Error("planning unavailable"); });
      await expect(f.adapter.sendMessage(f.input)).rejects.toThrow("planning unavailable");
      const session = f.store.getActiveSpaceAgentSession(f.pane.id)!;
      expect(f.store.listSpaceAgentMessages(session.sessionId)).toHaveLength(0);
      expect(f.store.getSpaceAgentSubmission(f.pane.id, f.input.clientRequestId)).toBeNull();
    });

    it("never restarts an accepted submission after an ambiguous runtime start failure", async () => {
      const f = await fixture();
      const start = vi.spyOn(f.starter, "start").mockRejectedValue(Error("connection lost after start"));
      await expect(f.adapter.sendMessage(f.input)).rejects.toThrow("runtime unavailable");
      const replay = await createSpaceAgentAdapter(f.options).sendMessage(f.input);
      expect(replay.session.latestRun?.status).toBe("FAILED");
      expect(start).toHaveBeenCalledTimes(1);
      expect(f.store.listSpaceAgentMessages(replay.submission!.sessionId)).toHaveLength(2);
    });

    it("rejects a distinct request while this pane already has an active task", async () => {
      const f = await fixture();
      const sent = await f.adapter.sendMessage(f.input);
      await expect(f.adapter.sendMessage({ ...f.input, clientRequestId: "request:another" })).rejects.toThrow("active task");
      expect(f.store.listSpaceAgentMessages(sent.submission!.sessionId)).toHaveLength(2);
      expect(f.starter.started).toHaveLength(1);
    });

    it("prepares exact original content and files without executing and rejects missing attachments", async () => {
      const f = await fixture();
      const artifact = f.store.createArtifact({ roomId: f.pane.roomId, paneId: f.pane.id, kind: "IMAGE", mimeType: "image/png",
        storageUri: "space-artifact://user-uploads/review.png", sha256: "b".repeat(64), byteSize: 100, metadata: {} }).artifact;
      const sent = await f.adapter.sendMessage({ ...f.input, content: "", artifactIds: [artifact.id] });
      await expect(f.adapter.prepareRetry({ pane: f.pane })).rejects.toThrow("failed or interrupted");
      f.store.updateSpaceAgentRun(sent.submission!.runId, { status: "FAILED" });
      expect(await f.adapter.prepareRetry({ pane: f.pane })).toEqual({ content: "", artifacts: [artifact] });
      expect(f.starter.started).toHaveLength(1);
      f.store.updateArtifactRetention(artifact.id, { deletedAt: new Date().toISOString() });
      await expect(f.adapter.prepareRetry({ pane: f.pane })).rejects.toThrow("attachments are unavailable");
    });

    it("roundtrips the optional request key through the real HTTP route", async () => {
      const f = await fixture();
      const { app, cookie, csrfToken } = await authedApp({ store: f.store, codexTurnStarter: f.starter });
      try {
        const send = () => app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(f.pane.id)}/agent/messages`,
          headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { content: f.input.content, clientRequestId: f.input.clientRequestId,
            acceptance: { version: 1, checks: [{ id: "answer", kind: "NUMBER_EQUALS", expected: 42 }] } } });
        const a = await send(), b = await send();
        expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200);
        expect(a.json().latestRun.runId).toBe(b.json().latestRun.runId);
        expect(a.json().latestRun.execution.acceptance.checks[0]).toMatchObject({ kind: "NUMBER_EQUALS", expected: 42, critical: true });
        expect(f.starter.started).toHaveLength(1);
      } finally { await app.close(); }
    }, 15_000);
  });

  it("keeps exact submitted attachment receipts across reload without scanning room history", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const room = store.createRoom({ name: "Saved attachments", initialPaneCount: 1 });
    const pane = store.listPanes(room.id)[0]!;
    const create = (name: string, image = false) => store.createArtifact({ roomId: room.id, paneId: pane.id,
      kind: image ? "IMAGE" : "EXPORT", mimeType: image ? "image/png" : "application/pdf",
      storageUri: `space-artifact://user-uploads/${name}`, sha256: "a".repeat(64), byteSize: 1200,
      metadata: { originalFilename: name } }).artifact;
    const oldImage = create("old.png", true);
    const document = create("notes.pdf");
    for (let i = 0; i < 101; i += 1) create(`newer-${i}.pdf`);
    vi.spyOn(store, "listArtifacts").mockImplementation(() => { throw new Error("A submission must not scan room history."); });
    const starter = new FakeCodexTurnStarter();
    const adapter = createSpaceAgentAdapter({ store, config: enabledConfig(), codexTurnStarter: starter, codexAgentControl: new FakeCodexAgentControl() });
    const sent = await adapter.sendMessage({ pane, content: "Use these files.", traceId: "trace:attachments",
      artifactIds: [oldImage.id, document.id, oldImage.id] });
    const receipts = sent.session.latestRun?.execution?.attachments;
    expect(receipts?.map(item => item.artifactId)).toEqual([oldImage.id, document.id]);
    expect(receipts?.map(item => item.name)).toEqual(["old.png", "notes.pdf"]);
    expect(starter.started[0]?.artifactIds).toEqual([oldImage.id]);
    expect(starter.started[0]?.prompt).toContain(document.id);
    store.updateArtifactRetention(oldImage.id, { deletedAt: new Date().toISOString() });
    oldImage.metadata.originalFilename = "changed.png";
    const loaded = await adapter.loadSession({ pane });
    expect(loaded.latestRun?.execution?.attachments).toEqual(receipts);
    expect(loaded.latestRun?.execution?.attachments?.[0]?.name).toBe("old.png");
    expect(starter.started).toHaveLength(1);
  });

  it("rejects a mixed missing attachment submission before creating messages or a run", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Rejected attachments", initialPaneCount: 1 });
    const pane = store.listPanes(room.id)[0]!;
    const valid = store.createArtifact({ roomId: room.id, paneId: pane.id, kind: "IMAGE", mimeType: "image/png",
      storageUri: "space-artifact://user-uploads/valid.png", sha256: "a".repeat(64), byteSize: 100, metadata: {} }).artifact;
    const messages = vi.spyOn(store, "createSpaceAgentMessage");
    const runs = vi.spyOn(store, "createSpaceAgentRun");
    const sessions = vi.spyOn(store, "createSpaceAgentSession");
    const starter = new FakeCodexTurnStarter();
    const adapter = createSpaceAgentAdapter({ store, config: enabledConfig(), codexTurnStarter: starter, codexAgentControl: new FakeCodexAgentControl() });
    await expect(adapter.sendMessage({ pane, content: "Use both.", traceId: "trace:missing-file",
      artifactIds: [valid.id, "artifact:missing"] })).rejects.toThrow("attachments are unavailable");
    expect(messages).not.toHaveBeenCalled();
    expect(runs).not.toHaveBeenCalled();
    expect(sessions).not.toHaveBeenCalled();
    expect(starter.started).toHaveLength(0);
  });

  it("retains the submitted model and run timing after settings changes and reload", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const room = store.createRoom({ name: "Saved task facts", initialPaneCount: 1 });
    const pane = store.listPanes(room.id)[0]!;
    const starter = new FakeCodexTurnStarter();
    const adapter = createSpaceAgentAdapter({ store, config: enabledConfig(), codexTurnStarter: starter, codexAgentControl: new FakeCodexAgentControl() });
    const initial = await adapter.loadSession({ pane });
    expect(initial.latestRun).toBeNull();
    const sent = await adapter.sendMessage({ pane, content: "Keep this task identifiable.", traceId: "trace:saved-task-facts" });
    const saved = sent.session.latestRun!;
    expect(saved).toMatchObject({ status: "QUEUED", startedAt: null, runtimeModelAtStart: null,
      costStatus: "UNKNOWN", evaluationStatus: "NOT_EVALUATED", ledger: { evaluation: { status: "PENDING" } },
      execution: { traceId: "trace:saved-task-facts", modelConfigId: initial.selectedModelConfigId,
        requestedModel: starter.started[0]!.modelId, requestedReasoning: starter.started[0]!.reasoningEffort } });
    const running = store.updateSpaceAgentRun(saved.runId, { status: "RUNNING", runtimeModelAtStart: "runtime-reported-variant" });
    expect(running.startedAt).toBeTruthy();
    store.updateSpaceAgentRun(saved.runId, { status: "RUNNING" });
    store.updateSpaceAgentRun(saved.runId, { status: "COMPLETED" });
    store.updateSpaceAgentSession(sent.binding.sessionId!, { status: "READY" });
    const alternate = initial.modelOptions.find(option => option.id !== initial.selectedModelConfigId)!;
    expect(alternate).toBeTruthy();
    await adapter.updateSettings({ pane, selectedModelConfigId: alternate.id });
    const loaded = await adapter.loadSession({ pane });
    expect(loaded.selectedModelConfigId).toBe(alternate.id);
    expect(loaded.latestRun).toMatchObject({ runId: saved.runId, status: "COMPLETED", execution: saved.execution,
      startedAt: running.startedAt, runtimeModelAtStart: "runtime-reported-variant",
      evaluationStatus: "NOT_EVALUATED", ledger: { evaluation: { status: "UNSCORABLE" },
        model: { source: "RUNTIME_START", value: "runtime-reported-variant", observedAt: running.ledger!.model.observedAt } } });
    expect(loaded.latestRun?.completedAt).toBeTruthy();
    expect(starter.started).toHaveLength(1);
  });

  it("keeps first browser loads and Room Agent preparation on one Chat session", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const room = store.createRoom({ name: "Concurrent room preparation", initialPaneCount: 1 });
    const pane = store.listPanes(room.id)[0]!;
    const starter = new FakeCodexTurnStarter();
    const adapter = createSpaceAgentAdapter({ store, config: enabledConfig(), codexTurnStarter: starter, codexAgentControl: new FakeCodexAgentControl() });
    const sessions = await Promise.all([adapter.loadSession({ pane }), adapter.createOrRestoreSession({ pane }), adapter.loadSession({ pane })]);
    expect(new Set(sessions.map(session => session.binding.sessionId)).size).toBe(1);
    const sent = await adapter.sendMessage({ pane, content: "Write the room story.", traceId: "trace:concurrent-room-story" });
    const loaded = await adapter.loadSession({ pane });
    expect(loaded.binding.sessionId).toBe(sent.binding.sessionId);
    const submittedRun = store.getLatestSpaceAgentRun(sent.binding.sessionId!)!;
    expect(sent.submission).toEqual({ sessionId: sent.binding.sessionId,
      responseMessageId: submittedRun.responseMessageId, runId: submittedRun.runId });
    expect(loaded.messages.some(message => message.role === "user" && message.content === "Write the room story.")).toBe(true);
    expect(loaded.runStatus).toBe("QUEUED");
    expect(store.listSpaceAgentHistory(room.id)).toHaveLength(1);
  });
  it("shows only the enabled Codex provider inside Chat panes", async () => {
    const store = new InMemorySpaceStore();
    const control = new FakeCodexAgentControl();
    const starter = new FakeCodexTurnStarter();
    const room = store.createRoom({ name: "Enabled Chat providers", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const adapter = createSpaceAgentAdapter({
      store,
      config: enabledConfig(),
      codexTurnStarter: starter,
      codexAgentControl: control,
      isChatProviderEnabled: async (providerId) => providerId === "codex"
    });

    const session = await adapter.loadSession({ pane });

    expect(session.modelProviders.map((provider) => provider.providerId)).toEqual(["codex"]);
    expect(session.binding.selectedProviderName).toBeNull();
    expect(session.modelOptions.every((option) => option.id.startsWith("codex-v1|"))).toBe(true);
  });

  it("does not expose the retired GPT-5.2 model advertised by the raw Codex catalog", async () => {
    const store = new InMemorySpaceStore();
    const control = new FakeCodexAgentControl();
    control.models = [
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        description: "Current model.",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["high"]
      },
      {
        id: "gpt-5.2",
        displayName: "GPT-5.2",
        description: "Retired model.",
        isDefault: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium"]
      }
    ];
    const room = store.createRoom({ name: "Filtered Chat models", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const adapter = createSpaceAgentAdapter({
      store,
      config: enabledConfig(),
      codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: control
    });

    const session = await adapter.loadSession({ pane });

    expect(session.modelCatalog.map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
    expect(session.modelOptions.every((option) => !option.id.includes("gpt-5.2"))).toBe(true);
  });

  it("never reads stable's OpenCode access file or reaches its shared server for Chat on dev", async () => {
    for (const instance of ["stable", "dev"] as const) {
      vi.mocked(resolveOpenCodeTitleFallbackControl).mockClear();
      const store = new InMemorySpaceStore();
      const room = store.createRoom({ name: `OpenCode Chat on ${instance}`, initialPaneCount: 1 }, "trace:room");
      const pane = store.listPanes(room.id)[0]!;
      const { app, cookie } = await authedApp({ store, config: { ...enabledConfig(), instance } });
      const loaded = await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`, headers: { cookie } });
      const provider = agentPaneSessionSchema.parse(loaded.json()).modelProviders.find((entry) => entry.providerId === "opencode");
      // The fallback control is the reader of the shared server's access file; dev must never call it.
      expect([instance, vi.mocked(resolveOpenCodeTitleFallbackControl).mock.calls.length > 0]).toEqual([instance, instance === "stable"]);
      if (instance === "dev") expect(provider?.statusReason).toBe("OpenCode Chat is unavailable on dev: it runs only on the stable instance.");
    }
  });

  it("shows enabled OpenCode inside Chat panes", async () => {
    const store = new InMemorySpaceStore();
    const control = new FakeCodexAgentControl();
    const room = store.createRoom({ name: "Enabled OpenCode Chat", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      providers: [
        { id: "opencode", name: "OpenCode Zen", models: {
          "nemotron-3-ultra-free": { name: "Nemotron 3 Ultra Free" },
          "north-mini-code-free": { name: "North Mini Code Free" },
          "retired": { name: "Retired", status: "deprecated" }
        } },
        { id: "opencode-go", name: "OpenCode Go", models: {
          "deepseek-v4-pro": { name: "DeepSeek V4 Pro", variants: { high: {}, max: {} } },
          "qwen3.7-plus": { name: "Qwen3.7 Plus", variants: { minimal: {}, high: {} } }
        } }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const adapter = createSpaceAgentAdapter({
        store,
        config: enabledConfig(),
        codexTurnStarter: new FakeCodexTurnStarter(),
        codexAgentControl: control,
        openCodeControlResolver: async () => ({
          version: 1,
          spaceSessionId: "cli_session:catalog-only",
          nativeSessionId: "ses_catalogOnly123",
          serverPort: 47047,
          serverHost: "127.0.0.1",
          serverUsername: "test",
          serverPassword: "test",
          updatedAt: "2026-08-28T00:00:00.000Z"
        }),
        isChatProviderEnabled: async (providerId) => providerId === "opencode"
      });

      const session = await adapter.loadSession({ pane });

      expect(session.modelProviders.map((provider) => provider.providerId)).toEqual(["opencode"]);
      expect(session.binding.selectedProviderName).toBe("OpenCode");
      expect(session.modelProviders[0]!.models.map(model => model.id)).toEqual([
        "opencode/nemotron-3-ultra-free", "opencode/north-mini-code-free",
        "opencode-go/deepseek-v4-pro", "opencode-go/qwen3.7-plus"
      ]);
      expect(session.modelOptions.map((option) => option.id)).toEqual([
        "opencode-v1|opencode/nemotron-3-ultra-free|medium",
        "opencode-v1|opencode/north-mini-code-free|medium",
        "opencode-v1|opencode-go/deepseek-v4-pro|high", "opencode-v1|opencode-go/deepseek-v4-pro|max",
        "opencode-v1|opencode-go/qwen3.7-plus|minimal", "opencode-v1|opencode-go/qwen3.7-plus|high"
      ]);
      // One catalog request; the other is the cached OpenCode API version probe.
      expect(fetchMock.mock.calls.filter(([url]) => !String(url).endsWith("/api/info"))).toHaveLength(1);
      control.collaborationModes = [];
      const updated = await adapter.updateSettings({ pane, collaborationMode: "plan" });
      expect(updated.session.collaborationMode).toBe("plan");
      expect(updated.session.capabilities.canSend).toBe(true);
      for (const permissionMode of ["ask_for_approval", "approve_for_me"] as const) {
        await expect(adapter.updateSettings({ pane, permissionMode })).rejects.toThrow(/permission approvals are unavailable/);
      }
      expect(store.getActiveSpaceAgentSession(pane.id)?.permissionMode).toBe("full_access");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("exposes the configured DeepSeek CLI catalog inside Chat panes", async () => {
    const store = new InMemorySpaceStore();
    const control = new FakeCodexAgentControl();
    const room = store.createRoom({ name: "DeepSeek Chat provider", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const deepSeekAdapter = cliRuntimeModelsChatProviderAdapter({
      runtimeId: "cli:deepseek",
      executeModels: async () => "deepseek-pro/deepseek-v4-pro\tDeepSeek V4 Pro\tdisabled,high,max\thigh",
      resolveState: async () => ({ enabled: true, reason: null })
    });
    const adapter = createSpaceAgentAdapter({
      store,
      config: enabledConfig(),
      codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: control,
      cliChatProviderAdapters: [deepSeekAdapter]
    });

    const session = await adapter.createOrRestoreSession({
      pane,
      selectedModelConfigId: "cli:deepseek-v1|deepseek-pro/deepseek-v4-pro|max"
    });

    expect(session.modelProviders.map((provider) => provider.providerId)).toEqual(["codex", "cli:deepseek"]);
    expect(session.modelProviders[1]!.models[0]).toMatchObject({
      id: "deepseek-pro/deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      supportedReasoningEfforts: ["disabled", "high", "max"]
    });
    expect(session.selectedModelConfigId).toBe("cli:deepseek-v1|deepseek-pro/deepseek-v4-pro|max");
    expect(session.binding.selectedProviderName).toBe("DeepSeek");
  });

  it("hides a CLI Chat provider while its runtime toggle is off and restores it automatically", async () => {
    const store = new InMemorySpaceStore();
    const control = new FakeCodexAgentControl();
    const room = store.createRoom({ name: "Disabled CLI Chat provider", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    // cli:codex stays on: every Chat provider follows its own runtime toggle.
    const enabledRuntimes = new Set<string>(["cli:codex"]);
    const adapter = createSpaceAgentAdapter({
      store,
      config: enabledConfig(),
      codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: control,
      cliChatProviderAdapters: [
        cliRuntimeModelsChatProviderAdapter({
          runtimeId: "cli:claude",
          executeModels: async () => "claude-opus-4.6\tClaude Opus 4.6\thigh\thigh",
          resolveState: async () => ({ enabled: true, reason: null })
        })
      ],
      isChatProviderEnabled: cliChatProviderEnabledByRuntimeToggle(async (runtimeId) =>
        enabledRuntimes.has(runtimeId)
      )
    });

    const hidden = await adapter.loadSession({ pane });
    expect(hidden.modelProviders.map((provider) => provider.providerId)).toEqual(["codex"]);

    // No restart or pane reopen: the same adapter restores the provider because
    // visibility is resolved on every session read.
    enabledRuntimes.add("cli:claude");
    const restored = await adapter.loadSession({ pane });
    expect(restored.modelProviders.map((provider) => provider.providerId)).toEqual(["codex", "cli:claude"]);
    expect(restored.modelProviders[1]!.models.map((model) => model.id)).toEqual(["claude-opus-4.6"]);
  });

  it("serves the selected Chat provider while an unrelated catalog remains pending", async () => {
    const store = new InMemorySpaceStore(), control = new FakeCodexAgentControl();
    const room = store.createRoom({ name: "Nonblocking catalog", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    let release!: (value: { models: []; current: null; error: null }) => void;
    const slowCatalog = new Promise<{ models: []; current: null; error: null }>(resolve => { release = resolve; });
    const adapter = createCachedSpaceAgentAdapter({ store, config: enabledConfig(), codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: control, cliChatProviderAdapters: [{ providerId: "cli:slow", providerName: "Slow", configIdPrefix: "cli:slow-v1|",
        loadCatalog: () => slowCatalog }] });
    try {
      const first = await adapter.loadSession({ pane });
      const second = await adapter.loadSession({ pane });
      expect(first.capabilities.canSend).toBe(true);
      expect(second.selectedModelConfigId).toBe(first.selectedModelConfigId);
      expect(first.modelProviders.find(p => p.providerId === "cli:slow")).toMatchObject({ isInactive: true, models: [] });
      expect(control.modelCalls).toBe(1);
    } finally { release({ models: [], current: null, error: null }); }
  });

  it("keeps the selected provider fixed when its catalog becomes unavailable", async () => {
    const store = new InMemorySpaceStore();
    const control = new FakeCodexAgentControl();
    const room = store.createRoom({ name: "Inactive Codex provider", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const adapter = createSpaceAgentAdapter({
      store,
      config: enabledConfig(),
      codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: control,
      cliChatProviderAdapters: [
        cliRuntimeModelsChatProviderAdapter({
          runtimeId: "cli:deepseek",
          executeModels: async () => "deepseek-pro/deepseek-v4-pro\tDeepSeek V4 Pro\tdisabled,high,max\thigh",
          resolveState: async () => ({ enabled: true, reason: null })
        })
      ]
    });

    const healthy = await adapter.loadSession({ pane });
    expect(healthy.modelProviders.map((provider) => provider.providerId)).toEqual(["codex", "cli:deepseek"]);
    expect(healthy.binding.status).toBe("READY");

    // Codex is offered as unavailable while its catalog fails. The pane remains bound
    // to Codex and blocks instead of silently sending through DeepSeek.
    control.failModels = true;
    const degraded = await adapter.loadSession({ pane });
    expect(degraded.modelProviders.map((provider) => provider.providerId)).toEqual(["codex", "cli:deepseek"]);
    expect(degraded.modelProviders[0]).toMatchObject({ providerId: "codex", isInactive: true, models: [] });
    expect(degraded.modelProviders[0]!.statusReason).toContain("model catalog");
    expect(degraded.modelProviders[1]).toMatchObject({ providerId: "cli:deepseek", isInactive: false });
    expect(degraded.modelProviders[1]!.models.map((model) => model.id)).toEqual(["deepseek-pro/deepseek-v4-pro"]);
    // The selected model/provider stays unchanged while the unavailable provider is
    // shown as inactive.
    expect(degraded.selectedModelConfigId).toBe("codex-v1|gpt-provider-verified|medium");
    expect(store.getActiveSpaceAgentSession(pane.id)?.selectedModelConfigId).toBe("codex-v1|gpt-provider-verified|medium");
    expect(degraded.modelProviders[1]).toMatchObject({ providerId: "cli:deepseek", isCurrent: false });
    expect(degraded.modelProviders[0]).toMatchObject({ providerId: "codex", isCurrent: true });
    expect(degraded.binding.status).toBe("BLOCKED");
    expect(degraded.capabilities.canSend).toBe(false);
    expect(degraded.capabilities.canSelectModel).toBe(true);

    // No restart, no pane reopen: the moment Codex works again the same selection is
    // usable again. No fallback model was ever used.
    control.failModels = false;
    const restored = await adapter.loadSession({ pane });
    expect(restored.modelProviders.map((provider) => provider.providerId)).toEqual(["codex", "cli:deepseek"]);
    expect(restored.modelProviders[0]).toMatchObject({ providerId: "codex", isCurrent: true, isInactive: false });
    expect(restored.selectedModelConfigId).toBe("codex-v1|gpt-provider-verified|medium");
    expect(restored.binding.status).toBe("READY");
    expect(restored.capabilities.canSend).toBe(true);
  });

  it("remembers the selected model when the pane session is closed and reopened", async () => {
    const store = new InMemorySpaceStore();
    const control = new FakeCodexAgentControl();
    control.models = [
      { id: "gpt-6-astra", displayName: "GPT-6-Astra", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: ["low", "high"] },
      { id: "gpt-6-mini", displayName: "GPT-6-Mini", isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: ["low"] }
    ];
    const room = store.createRoom({ name: "Remembered model", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const adapter = createSpaceAgentAdapter({
      store,
      config: enabledConfig(),
      codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: control
    });

    const opened = await adapter.createOrRestoreSession({
      pane,
      selectedModelConfigId: "codex-v1|gpt-6-mini|low"
    });
    expect(opened.selectedModelConfigId).toBe("codex-v1|gpt-6-mini|low");
    const openedSessionId = opened.binding.sessionId;

    // Closing the pane deactivates the session (it is not deleted).
    await store.updateSpaceAgentSession(openedSessionId!, { status: "READY", isActive: false });

    const reopened = await adapter.loadSession({ pane });

    expect(reopened.binding.sessionId).toBe(openedSessionId);
    expect(reopened.selectedModelConfigId).toBe("codex-v1|gpt-6-mini|low");
    expect(reopened.binding.selectedModelName).toBe("gpt-6-mini");
  });

  it("starts a brand-new session when the pane explicitly requests one", async () => {
    const store = new InMemorySpaceStore();
    const control = new FakeCodexAgentControl();
    const room = store.createRoom({ name: "Explicit new task", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const adapter = createSpaceAgentAdapter({
      store,
      config: enabledConfig(),
      codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: control
    });

    const first = await adapter.loadSession({ pane });
    await store.updateSpaceAgentSession(first.binding.sessionId!, { status: "READY", isActive: false });
    const brandNew = await adapter.createOrRestoreSession({ pane, sessionId: null });

    expect(brandNew.binding.sessionId).not.toBe(first.binding.sessionId);
  });

  it("does not expose a disabled Chat provider", async () => {
    const store = new InMemorySpaceStore();
    const control = new FakeCodexAgentControl();
    const room = store.createRoom({ name: "Disabled OpenCode Chat", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const resolver = vi.fn(async () => {
      throw new Error("Disabled OpenCode must not be loaded.");
    });
    const adapter = createSpaceAgentAdapter({
      store,
      config: enabledConfig(),
      codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: control,
      openCodeControlResolver: resolver,
      isChatProviderEnabled: async (providerId) => providerId === "codex"
    });

    const session = await adapter.loadSession({ pane });

    expect(session.modelProviders.map((provider) => provider.providerId)).toEqual(["codex"]);
    expect(session.binding.selectedProviderName).toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each(["cli:kimi", "cli:deepseek", "cli:hermes"])(
    "rejects removed %s providers inside Chat",
    async (runtimeId) => {
      const store = new InMemorySpaceStore();
      const control = new FakeCodexAgentControl();
      const room = store.createRoom({ name: `Removed ${runtimeId}`, initialPaneCount: 1 }, "trace:room");
      const pane = store.listPanes(room.id)[0]!;
      const adapter = createSpaceAgentAdapter({
        store,
        config: enabledConfig(),
        codexTurnStarter: new FakeCodexTurnStarter(),
        codexAgentControl: control
      });

      await expect(adapter.createOrRestoreSession({
        pane,
        selectedModelConfigId: `${runtimeId}-v1|auto|none`
      })).rejects.toMatchObject({ errorCode: "SPACE_AGENT_PROVIDER_UNSUPPORTED" });
      expect(store.getActiveSpaceAgentSession(pane.id)).toBeNull();
    }
  );

  it("starts OpenCode turns with a control bound to the exact Space Chat session", async () => {
    const store = new InMemorySpaceStore();
    const control = new FakeCodexAgentControl();
    const starter = new FakeCodexTurnStarter();
    const room = store.createRoom({ name: "Isolated OpenCode Chat", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      providers: [{ id: "opencode-go", models: {
        "deepseek-v4-pro": { name: "DeepSeek V4 Pro", variants: { high: {}, max: {} } }
      } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const sessionControlResolver = vi.fn(async (spaceAgentSessionId: string) => ({
      version: 1 as const,
      spaceSessionId: spaceAgentSessionId,
      nativeSessionId: "ses_isolatedChat123",
      serverPort: 47047,
      serverHost: "127.0.0.1",
      serverUsername: "test",
      serverPassword: "test",
      updatedAt: "2026-08-28T00:00:00.000Z"
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const adapter = createSpaceAgentAdapter({
        store,
        config: enabledConfig(),
        codexTurnStarter: starter,
        codexAgentControl: control,
        openCodeControlResolver: sessionControlResolver.bind(null, "agent_session:catalog-only"),
        openCodeSessionControlResolver: sessionControlResolver,
        isChatProviderEnabled: async () => true
      });

      const result = await adapter.sendMessage({
        pane,
        content: "Keep this conversation isolated.",
        selectedModelConfigId: "opencode-v1|opencode-go/deepseek-v4-pro|max",
        selectedToolIds: [],
        traceId: "trace:isolated-opencode"
      });

      const agentSessionId = result.session.binding.sessionId!;
      expect(agentSessionId).toMatch(/^agent_session:/);
      expect(sessionControlResolver).toHaveBeenLastCalledWith(agentSessionId);
      expect(starter.started).toHaveLength(1);
      expect(starter.started[0]).toMatchObject({
        providerId: "opencode",
        modelId: "opencode-go/deepseek-v4-pro",
        reasoningEffort: "max",
        providerSessionId: agentSessionId,
        agentSessionId
      });
      expect(starter.started[0]?.providerSessionId).not.toBe("cli_session:catalog-only");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("creates a Space-native session when loading a CHAT pane", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const control = new FakeCodexAgentControl();
    const room = store.createRoom({ name: "Agents", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie } = await authedApp({
      store,
      codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: control
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    const session = agentPaneSessionSchema.parse(response.json());
    expect(session.binding).toMatchObject({
      paneId: pane.id,
      source: "SPACE",
      coderChatId: null,
      status: "READY",
      title: pane.title
    });
    expect(session.binding.sessionId).toMatch(/^agent_session:/);
    expect(store.getActiveSpaceAgentSession(pane.id)?.sessionId).toBe(session.binding.sessionId);
    expect(control.modelCalls).toBe(1);
    expect(JSON.stringify(session)).not.toMatch(new RegExp("10\\.100\\.0\\.216|api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));
  });

  it("starts runtime capability discovery while the one catalog snapshot is pending", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const control = new FakeCodexAgentControl();
    let releaseCatalog!: () => void;
    let markCatalogStarted!: () => void;
    const catalogStarted = new Promise<void>((resolve) => {
      markCatalogStarted = resolve;
    });
    control.modelListGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    control.onModelListStarted = markCatalogStarted;
    const room = store.createRoom({ name: "Concurrent Catalog", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie } = await authedApp({
      store,
      codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: control
    });

    const responsePromise = app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
      headers: { cookie }
    });
    await catalogStarted;
    const capabilitiesStartedBeforeCatalogRelease =
      control.requirementsCalls === 1 && control.collaborationCalls === 1;
    releaseCatalog();
    const response = await responsePromise;

    expect(response.statusCode).toBe(200);
    expect(capabilitiesStartedBeforeCatalogRelease).toBe(true);
    expect(control.modelCalls).toBe(1);
    expect(control.requirementsCalls).toBe(1);
    expect(control.collaborationCalls).toBe(1);
  });

  it("starts the one catalog snapshot while settings validation is waiting on runtime capabilities", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const control = new FakeCodexAgentControl();
    let releaseRequirements!: () => void;
    let markRequirementsStarted!: () => void;
    const requirementsStarted = new Promise<void>((resolve) => {
      markRequirementsStarted = resolve;
    });
    const room = store.createRoom({ name: "Concurrent Settings Catalog", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({
      store,
      codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: control,
      requirementsCacheTtlMs: 0
    });
    // Activate the pane session before the gate is installed: this test measures catalog
    // and requirements concurrency, not session creation.
    await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {}
    });
    control.modelCalls = 0;
    control.requirementsCalls = 0;
    control.collaborationCalls = 0;
    control.requirementsGate = new Promise<void>((resolve) => {
      releaseRequirements = resolve;
    });
    control.onRequirementsStarted = markRequirementsStarted;

    const responsePromise = app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/settings`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { permissionMode: "full_access" }
    });
    await requirementsStarted;
    try {
      // Provider enablement resolves in a later microtask. Require catalog
      // discovery while requirements are still blocked, without assuming the
      // synchronous ordering of those independent promises.
      await vi.waitFor(() => expect(control.modelCalls).toBe(1), { timeout: 1000 });
    } finally {
      releaseRequirements();
    }
    const response = await responsePromise;

    expect(response.statusCode).toBe(200);
    expect(control.modelCalls).toBe(1);
    expect(control.requirementsCalls).toBe(1);
    expect(control.collaborationCalls).toBe(1);
  });

  it("does not let an older load overwrite newer model and collaboration settings", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const control = new FakeCodexAgentControl();
    const starter = new FakeCodexTurnStarter();
    const room = store.createRoom({ name: "Concurrent Agent Settings", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const setupAdapter = createSpaceAgentAdapter({
      store,
      config: enabledConfig(),
      codexTurnStarter: starter,
      codexAgentControl: control
    });
    const initial = await setupAdapter.loadSession({ pane });
    const highModel = initial.modelOptions.find((option) => option.reasoningKey === "high")!;
    // A pane that was closed and reopened has no active session: activate one first so
    // this exercises the concurrency guard rather than session creation.
    await store.updateSpaceAgentSession(initial.binding.sessionId!, { status: "READY", isActive: false });
    await setupAdapter.loadSession({ pane });

    let releaseOlderLoad!: () => void;
    control.requirementsGates.push(
      new Promise<void>((resolve) => {
        releaseOlderLoad = resolve;
      }),
      Promise.resolve()
    );
    const racingAdapter = createSpaceAgentAdapter({
      store,
      config: enabledConfig(),
      codexTurnStarter: starter,
      codexAgentControl: control
    });
    const originalUpdate = store.updateSpaceAgentSession.bind(store);
    let markOlderEnsurePersisted!: () => void;
    const olderEnsurePersisted = new Promise<void>((resolve) => {
      markOlderEnsurePersisted = resolve;
    });
    let trackOlderEnsure = true;
    store.updateSpaceAgentSession = ((sessionId, input, traceId) => {
      const updated = originalUpdate(sessionId, input, traceId);
      if (trackOlderEnsure) {
        trackOlderEnsure = false;
        markOlderEnsurePersisted();
      }
      return updated;
    }) as typeof store.updateSpaceAgentSession;

    const olderLoadPromise = racingAdapter.loadSession({ pane });
    await olderEnsurePersisted;
    const settingsResult = await racingAdapter.updateSettings({
      pane,
      selectedModelConfigId: highModel.id,
      collaborationMode: "plan"
    });
    expect(settingsResult.session.selectedModelConfigId).toBe(highModel.id);
    expect(settingsResult.session.collaborationMode).toBe("plan");

    releaseOlderLoad();
    const olderLoad = await olderLoadPromise;
    const persisted = store.getActiveSpaceAgentSession(pane.id);
    expect(olderLoad.selectedModelConfigId).toBe(highModel.id);
    expect(olderLoad.collaborationMode).toBe("plan");
    expect(persisted?.selectedModelConfigId).toBe(highModel.id);
    expect(persisted?.collaborationMode).toBe("plan");
  });

  it.each(["active", "explicit", "reactivated"] as const)("preserves a completed native thread during a concurrent %s session refresh", async (path) => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const room = store.createRoom({ name: "Concurrent native completion", initialPaneCount: 1 });
    const pane = store.listPanes(room.id)[0]!;
    const adapter = createSpaceAgentAdapter({ store, config: enabledConfig(),
      codexTurnStarter: new FakeCodexTurnStarter(), codexAgentControl: new FakeCodexAgentControl() });
    const sent = await adapter.sendMessage({ pane, content: "A native completion must survive refresh.", traceId: "trace:refresh-completion" });
    const run = store.getLatestSpaceAgentRun(sent.binding.sessionId!)!;
    store.updateSpaceAgentSession(run.sessionId, { status: "RUNNING", isActive: path !== "reactivated" });
    const originalUpdate = store.updateSpaceAgentSession.bind(store);
    let completed = false;
    vi.spyOn(store, "updateSpaceAgentSession").mockImplementation((sessionId, input, traceId) => {
      if (!completed && input.permissionMode !== undefined) {
        completed = true;
        store.completeSpaceAgentRun({ runId: run.runId, sessionId: run.sessionId,
          responseMessageId: run.responseMessageId, responseContent: "Native answer.", finalResponse: "Native answer.",
          codexThreadId: "thread:native-refresh-completion", codexTurnId: "turn:native-refresh-completion",
          sourceType: "CHAT", traceId: "trace:refresh-completed", completedAt: new Date().toISOString() });
      }
      return originalUpdate(sessionId, input, traceId);
    });
    const refreshed = path === "explicit"
      ? await adapter.createOrRestoreSession({ pane, sessionId: run.sessionId })
      : await adapter.loadSession({ pane });
    expect(completed).toBe(true);
    expect(store.getSpaceAgentSession(run.sessionId)).toMatchObject({ status: "READY", threadId: "thread:native-refresh-completion" });
    expect(refreshed).toMatchObject({ threadId: "thread:native-refresh-completion", latestRun: { status: "COMPLETED" } });
    expect(refreshed.messages.some(message => message.role === "assistant" && message.content === "Native answer.")).toBe(true);
  });

  it("preserves a newly accepted run during a concurrent session refresh", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const room = store.createRoom({ name: "Concurrent native submission", initialPaneCount: 1 });
    const pane = store.listPanes(room.id)[0]!;
    const adapter = createSpaceAgentAdapter({ store, config: enabledConfig(),
      codexTurnStarter: new FakeCodexTurnStarter(), codexAgentControl: new FakeCodexAgentControl() });
    const initial = await adapter.loadSession({ pane });
    const originalUpdate = store.updateSpaceAgentSession.bind(store);
    let accepted = false;
    vi.spyOn(store, "updateSpaceAgentSession").mockImplementation((sessionId, input, traceId) => {
      if (!accepted && input.permissionMode !== undefined) {
        accepted = true;
        store.createSpaceAgentSubmission({ content: "Concurrent accepted task", run: {
          sessionId, paneId: pane.id, roomId: room.id, workflowId: "workflow:concurrent-refresh", status: "QUEUED",
          promptMessageId: "agent_msg:concurrent-user", responseMessageId: "agent_msg:concurrent-answer" } });
      }
      return originalUpdate(sessionId, input, traceId);
    });
    const refreshed = await adapter.loadSession({ pane });
    expect(accepted).toBe(true);
    expect(store.getSpaceAgentSession(initial.binding.sessionId!)?.status).toBe("RUNNING");
    expect(refreshed.binding.status).toBe("RUNNING");
  });

  it("uses the exact Codex CLI model catalog and forwards advertised reasoning identifiers", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store, "codex-lb", [verifiedModel("codex-lb", "registry-only-model", "high")]);
    const starter = new FakeCodexTurnStarter();
    const control = new FakeCodexAgentControl();
    control.models = [
      {
        id: "gpt-cli-reasoning",
        displayName: "GPT CLI Reasoning",
        description: "Advertised directly by Codex App Server.",
        isDefault: true,
        defaultReasoningEffort: "research",
        supportedReasoningEfforts: ["low", "research"],
        reasoningOptions: [
          { reasoningEffort: "low", description: "Quick work." },
          { reasoningEffort: "research", description: "Deep source-backed work." }
        ]
      }
    ];
    const room = store.createRoom({ name: "Reasoning Agents", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({
      store,
      codexTurnStarter: starter,
      codexAgentControl: control,
      codexGoals: control.codexGoalsAdapter()
    });

    const loaded = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
      headers: { cookie }
    });
    expect(loaded.statusCode).toBe(200);
    const session = agentPaneSessionSchema.parse(loaded.json());
    expect(session.modelCatalog).toEqual(control.models);
    expect(session.modelOptions.map((option) => option.id)).toEqual([
      "codex-v1|gpt-cli-reasoning|low",
      "codex-v1|gpt-cli-reasoning|research"
    ]);
    expect(session.modelOptions.map((option) => option.id)).not.toContain("codex-v1|registry-only-model|high");
    expect(session.selectedModelConfigId).toBe("codex-v1|gpt-cli-reasoning|research");
    expect(session.binding.selectedReasoningKey).toBe("research");

    const sent = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { content: "Use the advertised research effort.", selectedModelConfigId: "gpt-cli-reasoning:research" }
    });

    expect(sent.statusCode).toBe(200);
    expect(starter.started[0]).toMatchObject({
      providerId: null,
      modelId: "gpt-cli-reasoning",
      reasoningEffort: "research",
      permissionMode: "full_access"
    });
  });

  it("blocks when the Codex CLI model catalog is unavailable without falling back to provider models", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store, "codex-lb", [verifiedModel("codex-lb", "registry-fallback-must-not-appear")]);
    const starter = new FakeCodexTurnStarter();
    const control = new FakeCodexAgentControl();
    control.failModels = true;
    const room = store.createRoom({ name: "Unavailable Catalog", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({
      store,
      codexTurnStarter: starter,
      codexAgentControl: control,
      codexGoals: control.codexGoalsAdapter()
    });

    const loaded = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
      headers: { cookie }
    });
    expect(loaded.statusCode).toBe(200);
    const session = agentPaneSessionSchema.parse(loaded.json());
    expect(session.binding.status).toBe("BLOCKED");
    expect(session.modelCatalog).toEqual([]);
    expect(session.modelOptions).toEqual([]);
    expect(session.statusReason).toContain("model catalog");
    expect(control.modelCalls).toBe(1);

    const sent = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { content: "This must not fall back." }
    });

    expect(sent.statusCode).toBe(200);
    expect(agentPaneSessionSchema.parse(sent.json()).binding.status).toBe("BLOCKED");
    expect(starter.started).toHaveLength(0);
    expect(store.listSpaceAgentMessages(session.binding.sessionId!)).toHaveLength(0);
    expect(control.modelCalls).toBe(2);
  });

  it("preserves a non-default model selection across a transient catalog failure", async () => {
    const store = new InMemorySpaceStore();
    const control = new FakeCodexAgentControl();
    control.models = [
      {
        id: "gpt-default",
        displayName: "GPT Default",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium"]
      },
      {
        id: "gpt-cli-only",
        displayName: "GPT CLI Only",
        isDefault: false,
        defaultReasoningEffort: "xhigh",
        supportedReasoningEfforts: ["medium", "xhigh"]
      }
    ];
    const room = store.createRoom({ name: "Transient Catalog", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({
      store,
      codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: control
    });

    const selected = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { selectedModelConfigId: "gpt-cli-only:xhigh" }
    });
    expect(selected.statusCode).toBe(200);
    expect(agentPaneSessionSchema.parse(selected.json()).selectedModelConfigId).toBe("codex-v1|gpt-cli-only|xhigh");
    expect(control.modelCalls).toBe(1);

    control.failModels = true;
    const unavailable = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
      headers: { cookie }
    });
    expect(unavailable.statusCode).toBe(200);
    const unavailableSession = agentPaneSessionSchema.parse(unavailable.json());
    expect(unavailableSession.binding.status).toBe("BLOCKED");
    expect(unavailableSession.selectedModelConfigId).toBe("codex-v1|gpt-cli-only|xhigh");
    expect(store.getActiveSpaceAgentSession(pane.id)?.selectedModelConfigId).toBe("codex-v1|gpt-cli-only|xhigh");
    expect(control.modelCalls).toBe(2);

    control.failModels = false;
    const recovered = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
      headers: { cookie }
    });
    expect(recovered.statusCode).toBe(200);
    const recoveredSession = agentPaneSessionSchema.parse(recovered.json());
    expect(recoveredSession.binding.status).toBe("READY");
    expect(recoveredSession.selectedModelConfigId).toBe("codex-v1|gpt-cli-only|xhigh");
    expect(store.getActiveSpaceAgentSession(pane.id)?.selectedModelConfigId).toBe("codex-v1|gpt-cli-only|xhigh");
    expect(control.modelCalls).toBe(3);
  });

  it("loads a stale persisted selection as recoverable blocked state until the client selects a fresh option", async () => {
    const store = new InMemorySpaceStore();
    const control = new FakeCodexAgentControl();
    control.models = [{
      id: "gpt-fresh",
      displayName: "GPT Fresh",
      isDefault: true,
      defaultReasoningEffort: "research",
      supportedReasoningEfforts: ["research"]
    }];
    const room = store.createRoom({ name: "Stale Catalog Selection", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const persisted = store.createSpaceAgentSession({
      paneId: pane.id,
      roomId: room.id,
      status: "READY",
      title: "Retired model task",
      threadId: null,
      selectedProviderId: null,
      selectedModelId: "gpt-retired",
      selectedModelConfigId: "codex-v1|gpt-retired|high",
      selectedProviderName: null,
      selectedModelName: "GPT Retired",
      selectedReasoningKey: "high",
      selectedToolIds: [],
      permissionMode: "full_access",
      collaborationMode: "default",
      isActive: true
    });
    const { app, cookie, csrfToken } = await authedApp({
      store,
      codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: control
    });

    const loaded = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
      headers: { cookie }
    });

    expect(loaded.statusCode).toBe(200);
    const stale = agentPaneSessionSchema.parse(loaded.json());
    expect(stale.binding.status).toBe("BLOCKED");
    // The stale selection remains attached to the pane while blocked; it is not
    // replaced by the current default until the operator explicitly picks one.
    expect(stale.binding.selectedModelConfigId).toBe("codex-v1|gpt-retired|high");
    expect(stale.selectedModelConfigId).toBe("codex-v1|gpt-retired|high");
    expect(stale.modelCatalog).toEqual(control.models);
    expect(stale.capabilities.canSend).toBe(false);
    expect(stale.capabilities.canSelectModel).toBe(true);
    expect(store.getSpaceAgentSession(persisted.sessionId)).toMatchObject({
      status: "BLOCKED",
      selectedModelConfigId: "codex-v1|gpt-retired|high"
    });
    expect(stale.history.find((item) => item.sessionId === persisted.sessionId)?.status).toBe("BLOCKED");

    const repaired = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/settings`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { selectedModelConfigId: "codex-v1|gpt-fresh|research" }
    });

    expect(repaired.statusCode).toBe(200);
    const ready = agentPaneSessionSchema.parse(repaired.json());
    expect(ready.binding.status).toBe("READY");
    expect(ready.selectedModelConfigId).toBe("codex-v1|gpt-fresh|research");
    expect(ready.capabilities.canSend).toBe(true);
    expect(store.getSpaceAgentSession(persisted.sessionId)).toMatchObject({
      status: "READY",
      selectedModelConfigId: "codex-v1|gpt-fresh|research"
    });
  });

  it("ignores Space provider registry routing for native Chat turns", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store, "codex-lb", [verifiedModel("codex-lb", "registry-headroom-model", "medium")]);
    const starter = new FakeCodexTurnStarter();
    const control = new FakeCodexAgentControl();
    control.models = [{
      id: "gpt-cli-only",
      displayName: "GPT CLI Only",
      isDefault: true,
      defaultReasoningEffort: "xhigh",
      supportedReasoningEfforts: ["medium", "xhigh"]
    }];
    const room = store.createRoom({ name: "CLI Routed Model", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({
      store,
      codexTurnStarter: starter,
      codexAgentControl: control,
      codexGoals: control.codexGoalsAdapter()
    });

    const loaded = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
      headers: { cookie }
    });

    expect(loaded.statusCode).toBe(200);
    const session = agentPaneSessionSchema.parse(loaded.json());
    expect(session.selectedModelConfigId).toBe("codex-v1|gpt-cli-only|xhigh");
    expect(session.binding.selectedProviderName).toBeNull();

    const sent = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { content: "Use direct Codex control.", selectedModelConfigId: "gpt-cli-only:xhigh" }
    });

    expect(sent.statusCode).toBe(200);
    expect(starter.started[0]).toMatchObject({
      providerId: null,
      modelId: "gpt-cli-only",
      reasoningEffort: "xhigh"
    });
  });

  it("rejects unadvertised composite model ids before creating a session or turn", async () => {
    const store = new InMemorySpaceStore();
    const starter = new FakeCodexTurnStarter();
    const control = new FakeCodexAgentControl();
    control.models = [
      {
        id: "gpt-default",
        displayName: "GPT Default",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium"]
      },
      {
        id: "gpt-cli-only",
        displayName: "GPT CLI Only",
        isDefault: false,
        defaultReasoningEffort: "xhigh",
        supportedReasoningEfforts: ["medium", "xhigh"]
      }
    ];
    const room = store.createRoom({ name: "Strict CLI Model", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({
      store,
      codexTurnStarter: starter,
      codexAgentControl: control
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { content: "Do not silently change my selection.", selectedModelConfigId: "gpt-cli-only:not-advertised" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SPACE_AGENT_MODEL_CONFIG_NOT_ADVERTISED");
    expect(store.getActiveSpaceAgentSession(pane.id)).toBeNull();
    expect(store.listSpaceAgentHistory(room.id)).toEqual([]);
    expect(starter.started).toHaveLength(0);
    expect(control.modelCalls).toBe(1);
  });

  it("migrates an exact legacy raw model id while using one catalog snapshot for the send", async () => {
    const store = new InMemorySpaceStore();
    const starter = new FakeCodexTurnStarter();
    const control = new FakeCodexAgentControl();
    control.models = [
      {
        id: "gpt-default",
        displayName: "GPT Default",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium"]
      },
      {
        id: "gpt-cli-only",
        displayName: "GPT CLI Only",
        isDefault: false,
        defaultReasoningEffort: "xhigh",
        supportedReasoningEfforts: ["medium", "xhigh"]
      }
    ];
    const room = store.createRoom({ name: "Legacy CLI Model", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({
      store,
      codexTurnStarter: starter,
      codexAgentControl: control
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { content: "Migrate this legacy selection.", selectedModelConfigId: "gpt-cli-only" }
    });

    expect(response.statusCode).toBe(200);
    expect(agentPaneSessionSchema.parse(response.json()).selectedModelConfigId).toBe("codex-v1|gpt-cli-only|xhigh");
    expect(starter.started[0]).toMatchObject({
      modelId: "gpt-cli-only",
      reasoningEffort: "xhigh"
    });
    expect(control.modelCalls).toBe(1);
  });

  it("migrates an unambiguous legacy composite id to the opaque model config id", async () => {
    const store = new InMemorySpaceStore();
    const starter = new FakeCodexTurnStarter();
    const control = new FakeCodexAgentControl();
    control.models = [{
      id: "gpt-cli-only",
      displayName: "GPT CLI Only",
      isDefault: true,
      defaultReasoningEffort: "xhigh",
      supportedReasoningEfforts: ["medium", "xhigh"]
    }];
    const room = store.createRoom({ name: "Legacy Composite Model", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({
      store,
      codexTurnStarter: starter,
      codexAgentControl: control
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { content: "Migrate this legacy composite.", selectedModelConfigId: "gpt-cli-only:xhigh" }
    });

    expect(response.statusCode).toBe(200);
    expect(agentPaneSessionSchema.parse(response.json()).selectedModelConfigId).toBe("codex-v1|gpt-cli-only|xhigh");
    expect(starter.started[0]).toMatchObject({ modelId: "gpt-cli-only", reasoningEffort: "xhigh" });
    expect(control.modelCalls).toBe(1);
  });

  it("fails closed when a legacy composite collides with an exact raw model id", async () => {
    const store = new InMemorySpaceStore();
    const starter = new FakeCodexTurnStarter();
    const control = new FakeCodexAgentControl();
    control.models = [
      {
        id: "foo",
        displayName: "Foo",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["high"]
      },
      {
        id: "foo:high",
        displayName: "Foo High",
        isDefault: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium"]
      }
    ];
    const room = store.createRoom({ name: "Ambiguous Legacy Model", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({
      store,
      codexTurnStarter: starter,
      codexAgentControl: control
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { content: "Do not guess this model.", selectedModelConfigId: "foo:high" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SPACE_AGENT_MODEL_CONFIG_NOT_ADVERTISED");
    expect(store.getActiveSpaceAgentSession(pane.id)).toBeNull();
    expect(store.listSpaceAgentHistory(room.id)).toEqual([]);
    expect(starter.started).toHaveLength(0);
  });

  it("resolves legacy raw model ids to the default reasoning config", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store, "codex-lb", [
      {
        id: "gpt-legacy",
        providerId: "codex-lb",
        displayName: "GPT Legacy",
        status: "VERIFIED",
        contextWindow: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsRealtime: false,
        supportsReasoning: true,
        defaultReasoningEffort: "medium"
      }
    ]);
    const room = store.createRoom({ name: "Legacy Reasoning", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    store.createSpaceAgentSession({
      paneId: pane.id,
      roomId: room.id,
      title: "Legacy",
      threadId: null,
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-legacy",
      selectedModelConfigId: "gpt-legacy",
      selectedProviderName: "Codex-LB",
      selectedModelName: "gpt-legacy",
      selectedReasoningKey: "medium",
      selectedToolIds: [],
      isActive: true
    });
    const { app, cookie } = await authedApp({ store, codexTurnStarter: new FakeCodexTurnStarter() });

    const response = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    const session = agentPaneSessionSchema.parse(response.json());
    expect(session.selectedModelConfigId).toBe("codex-v1|gpt-legacy|medium");
    expect(session.binding.selectedModelConfigId).toBe("codex-v1|gpt-legacy|medium");
    expect(session.binding.selectedReasoningKey).toBe("medium");
  });

  it("keeps shared chat available without asking ordinary conversation to read it", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const starter = new FakeCodexTurnStarter();
    const room = store.createRoom({ name: "Simple conversation", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({ store, codexTurnStarter: starter });
    const response = await app.inject({
      method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { content: "τεστ" }
    });
    expect(response.statusCode).toBe(200);
    expect(starter.started).toHaveLength(1);
    expect(starter.started[0]?.selectedToolIds).toContain("chat:read");
    expect(starter.started[0]?.selectedToolIds).toContain("chat:send");
    expect(starter.started[0]?.prompt).toContain("Answer ordinary conversation, greetings, and test messages directly in this pane without reading shared chat.");
    expect(starter.started[0]?.prompt).toContain("For a requested shared chat reply, use chat:read before chat:send.");
    expect(starter.started[0]?.prompt).not.toContain("Use chat:read first to follow the conversation");
    const session = agentPaneSessionSchema.parse(response.json());
    expect(session.messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["τεστ"]);
  });

  it("sends independent native agent runs per pane and persists transcripts", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store, "codex-lb", [verifiedModel("codex-lb", "gpt-default")]);
    const starter = new FakeCodexTurnStarter();
    const room = store.createRoom({ name: "Agents", initialPaneCount: 2 }, "trace:room");
    const [firstPane, secondPane] = store.listPanes(room.id);
    const { app, cookie, csrfToken } = await authedApp({ store, codexTurnStarter: starter });

    const first = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(firstPane!.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { content: "First pane prompt", selectedModelConfigId: "gpt-default:medium", selectedToolIds: ["mcp-gateway"] }
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(secondPane!.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { content: "Second pane prompt" }
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstSession = agentPaneSessionSchema.parse(first.json());
    const secondSession = agentPaneSessionSchema.parse(second.json());
    expect(firstSession.binding.source).toBe("SPACE");
    expect(secondSession.binding.source).toBe("SPACE");
    expect(firstSession.binding.sessionId).not.toBe(secondSession.binding.sessionId);
    expect(firstSession.runStatus).toBe("QUEUED");
    expect(starter.started).toHaveLength(2);
    expect(starter.started[0]).toMatchObject({
      paneId: firstPane!.id,
      providerId: null,
      modelId: "gpt-default",
      permissionMode: "full_access",
      agentSessionId: firstSession.binding.sessionId,
      agentThreadId: null
    });
    expect(starter.started[0]!.prompt).toContain("Space private clipboard tools selected:");
    expect(starter.started[0]!.prompt).toContain("User prompt:\nFirst pane prompt");
    expect(starter.started[0]!.prompt).not.toContain("Space Agent Bootstrap:");
    expect(starter.started[0]!.prompt).not.toContain(`Space room id: ${room.id}.`);
    expect(starter.started[0]!.prompt).not.toContain("skills:list");
    expect(store.listSpaceAgentMessages(firstSession.binding.sessionId!)).toHaveLength(2);
    expect(store.getLatestSpaceAgentRun(firstSession.binding.sessionId!)?.workflowId).toContain("workflow:codex-app-server");
  });

  it("keeps follow-up Codex turns on the existing thread without polluting the canonical prompt", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const starter = new FakeCodexTurnStarter();
    const room = store.createRoom({ name: "Transcript Agents", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({ store, codexTurnStarter: starter });

    const first = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { content: "Remember that the launch code is alpha-42." }
    });
    const firstSession = agentPaneSessionSchema.parse(first.json());
    const firstRun = store.getLatestSpaceAgentRun(firstSession.binding.sessionId!)!;
    store.updateSpaceAgentMessage(firstRun.responseMessageId, {
      content: "I will remember launch code alpha-42 for this room.",
      status: "COMPLETED"
    });
    store.updateSpaceAgentRun(firstRun.runId, {
      status: "COMPLETED",
      codexThreadId: "thread:stale-alpha",
      codexTurnId: "turn:first-alpha",
      completedAt: "2026-07-05T00:00:00.000Z"
    });
    store.updateSpaceAgentSession(firstSession.binding.sessionId!, {
      status: "READY",
      threadId: "thread:stale-alpha",
      lastSyncedAt: "2026-07-05T00:00:00.000Z"
    });

    const second = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { content: "What launch code did I give you?" }
    });

    expect(second.statusCode).toBe(200);
    expect(starter.started).toHaveLength(2);
    expect(starter.started[1]).toMatchObject({
      agentThreadId: "thread:stale-alpha"
    });
    expect(starter.started[1]!.prompt).toContain("Space private clipboard tools selected:");
    expect(starter.started[1]!.prompt).toContain("User prompt:\nWhat launch code did I give you?");
    expect(starter.started[1]!.prompt).not.toContain("Space persistent conversation context");
    expect(starter.started[1]!.prompt).not.toContain("Remember that the launch code is alpha-42.");
    expect(starter.started[1]!.prompt).not.toContain("RUNNING");
  });

  it("exposes active managed browser sessions as native browser tools for web agents", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const room = store.createRoom({ name: "Browser Agents", initialPaneCount: 0 }, "trace:room");
    const chatPane = store.createPane({ roomId: room.id, title: "Researcher", mode: "CHAT" }, "trace:chat");
    const browserPane = store.createPane({ roomId: room.id, title: "Browser 1", mode: "BROWSER" }, "trace:browser");
    store.createPaneBrowserSession({
      sessionId: "browser_session:olla-1",
      paneId: browserPane.id,
      roomId: room.id,
      ownerAgentId: "agent:1",
      agentNumber: 1,
      profileId: "profile:browser-1",
      profilePath: "/opt/spaceapp/var/artifacts/browser-profiles/browser-1",
      viewport: "desktop",
      targetUrl: "https://www.google.com/",
      currentUrl: "https://www.google.com/?token=raw-secret&category=tea",
      title: "Olla Store",
      status: "READY",
      isActive: true
    });
    const { app, cookie } = await authedApp({
      store,
      config: getApiConfig({
        SPACE_AGENT_PANE_ENABLED: "true",
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_BROWSER_SESSIONS_ENABLED: "true"
      }),
      codexTurnStarter: new FakeCodexTurnStarter()
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(chatPane.id)}/agent-session`,
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    const responseBody = response.json();
    const session = agentPaneSessionSchema.parse(responseBody);
    expect(session.toolOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "memory:search",
          displayName: "Memory search",
          slug: "memory.search",
          enabled: true,
          authConnected: true,
          isForceOn: true
        }),
        expect.objectContaining({
          id: "clipboard:get",
          displayName: "Clipboard get",
          slug: "clipboard.get",
          enabled: true,
          authConnected: true,
          isForceOn: true
        }),
        expect.objectContaining({
          id: "skills:read",
          displayName: "Skill read",
          slug: "skills.read",
          enabled: true,
          authConnected: true,
          isForceOn: true
        }),
        expect.objectContaining({
          id: "browser:navigate",
          displayName: "Browser navigate",
          slug: "browser.navigate",
          enabled: true,
          authConnected: true
        }),
        expect.objectContaining({
          id: "browser:extract_text",
          displayName: "Browser extract text",
          slug: "browser.extract_text",
          enabled: true,
          authConnected: true
        }),
        expect.objectContaining({
          id: "browser:set_viewport",
          displayName: "Browser viewport",
          slug: "browser.set_viewport",
          enabled: true,
          authConnected: true
        })
      ])
    );
    // Public random IDs can contain "cdp"; inspect private keys and secret values instead.
    const serializedResponse = JSON.stringify(responseBody);
    expect(serializedResponse).not.toContain("raw-secret");
    expect(serializedResponse).not.toContain("/opt/spaceapp/var/artifacts/browser-profiles/browser-1");
    expect(serializedResponse).not.toMatch(/"[^"\n]*(?:profilePath|cdp|websocket|token)[^"\n]*"\s*:/i);
  });

  it("passes selected browser tools as metadata without injecting Space context into the Codex prompt", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const starter = new FakeCodexTurnStarter();
    const room = store.createRoom({ name: "Browser Prompt", initialPaneCount: 0 }, "trace:room");
    const chatPane = store.createPane({ roomId: room.id, title: "Researcher", mode: "CHAT" }, "trace:chat");
    const browserPane = store.createPane({ roomId: room.id, title: "Browser 1", mode: "BROWSER" }, "trace:browser");
    store.upsertClipboardItem({
      ownerUserId: "user:dev-operator",
      text: "private clipboard text must not enter normal prompts",
      source: "MANUAL_NOTE"
    });
    store.createPaneBrowserSession({
      sessionId: "browser_session:olla-2",
      paneId: browserPane.id,
      roomId: room.id,
      ownerAgentId: "agent:1",
      agentNumber: 1,
      profileId: "profile:browser-2",
      profilePath: "/opt/spaceapp/var/artifacts/browser-profiles/browser-2",
      viewport: "mobile",
      targetUrl: "https://www.google.com/",
      currentUrl: "https://www.google.com/?token=raw-secret&category=tea",
      title: "Olla Store",
      status: "READY",
      isActive: true
    });
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: getApiConfig({
        SPACE_AGENT_PANE_ENABLED: "true",
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_BROWSER_SESSIONS_ENABLED: "true"
      }),
      codexTurnStarter: starter
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(chatPane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        content: "Research google.com using the visible browser.",
        selectedToolIds: ["browser:extract_text", "browser:set_viewport"]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(starter.started).toHaveLength(1);
    expect(starter.started[0]!.selectedToolIds).toEqual(
      expect.arrayContaining([
        "memory:search",
        "memory:save",
        "clipboard:list",
        "clipboard:get",
        "clipboard:save",
        "skills:list",
        "skills:read",
        "browser:extract_text",
        "browser:set_viewport"
      ])
    );
    expect(starter.started[0]!.operatorUserId).toBe("user:dev-operator");
    expect(starter.started[0]!.prompt).toContain("Space private clipboard tools selected:");
    expect(starter.started[0]!.prompt).toContain("```space-clipboard-actions");
    expect(starter.started[0]!.prompt).toContain("Use these tools only when the operator explicitly asks");
    expect(starter.started[0]!.prompt).toContain("User prompt:\nResearch google.com using the visible browser.");
    expect(starter.started[0]!.prompt).not.toContain("Space Agent Bootstrap:");
    expect(starter.started[0]!.prompt).not.toContain("Space managed browser tools selected");
    expect(starter.started[0]!.prompt).not.toContain("browser_session:olla-2");
    expect(starter.started[0]!.prompt).not.toContain("private clipboard text must not enter normal prompts");
    expect(starter.started[0]!.prompt).not.toMatch(/raw-secret|profilePath|cdp|websocket/i);
  });

  it("injects non-image attachment context into the Codex prompt while keeping direct artifactIds image-only", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const starter = new FakeCodexTurnStarter();
    const room = store.createRoom({ name: "Video Attachment", initialPaneCount: 0 }, "trace:room");
    const chatPane = store.createPane({ roomId: room.id, title: "Planner", mode: "CHAT" }, "trace:chat");
    const artifactRecord = await store.createArtifact(
      {
        roomId: room.id,
        paneId: chatPane.id,
        kind: "VIDEO",
        mimeType: "video/mp4",
        storageUri: "space-artifact://user-uploads/room%3Avideo/2026-07-07/capture.mp4",
        sha256: "a".repeat(64),
        byteSize: 24576000,
        metadata: {
          source: "USER_UPLOAD",
          originalFilename: "capture.mp4"
        }
      },
      "trace:artifact"
    );
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: getApiConfig({
        SPACE_AGENT_PANE_ENABLED: "true",
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
      }),
      codexTurnStarter: starter
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(chatPane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        content: "Review the attached screen recording.",
        artifactIds: [artifactRecord.artifact.id]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(starter.started).toHaveLength(1);
    expect(starter.started[0]!.artifactIds).toEqual([]);
    expect(starter.started[0]!.prompt).toContain("Attached Space artifacts for this user message:");
    expect(starter.started[0]!.prompt).toContain(artifactRecord.artifact.id);
    expect(starter.started[0]!.prompt).toContain("capture.mp4");
    expect(starter.started[0]!.prompt).toContain("kind=VIDEO");
    expect(starter.started[0]!.prompt).toContain("mime=video/mp4");
    expect(starter.started[0]!.prompt).toContain("User prompt:\nReview the attached screen recording.");
    // A typed request leads; a request shown in the attachment is followed only when the text asks for it.
    expect(starter.started[0]!.prompt).toContain(attachedRequestRules.typed);
  });

  it("accepts attachment-only agent messages and carries non-image artifacts in prompt context", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const starter = new FakeCodexTurnStarter();
    const room = store.createRoom({ name: "Attachment Only", initialPaneCount: 0 }, "trace:room");
    const chatPane = store.createPane({ roomId: room.id, title: "Planner", mode: "CHAT" }, "trace:chat");
    const artifactRecord = await store.createArtifact(
      {
        roomId: room.id,
        paneId: chatPane.id,
        kind: "VIDEO",
        mimeType: "video/mp4",
        storageUri: "space-artifact://user-uploads/room%3Aattachment-only/2026-07-07/capture.mp4",
        sha256: "b".repeat(64),
        byteSize: 4096,
        metadata: {
          source: "USER_UPLOAD",
          originalFilename: "capture.mp4"
        }
      },
      "trace:artifact"
    );
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: getApiConfig({
        SPACE_AGENT_PANE_ENABLED: "true",
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
      }),
      codexTurnStarter: starter
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(chatPane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        content: "",
        artifactIds: [artifactRecord.artifact.id]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(starter.started).toHaveLength(1);
    expect(starter.started[0]!.artifactIds).toEqual([]);
    expect(starter.started[0]!.prompt).toContain("Attached Space artifacts for this user message:");
    expect(starter.started[0]!.prompt).toContain(artifactRecord.artifact.id);
    expect(starter.started[0]!.prompt).not.toContain("User prompt:\n");
    // A photo or file sent on its own is the user's request.
    expect(starter.started[0]!.prompt).toContain(attachedRequestRules.whole);
  });

  it("defaults new and reloaded agent sessions to every enabled tool", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const room = store.createRoom({ name: "Default Tools", initialPaneCount: 0 }, "trace:room");
    const chatPane = store.createPane({ roomId: room.id, title: "Planner", mode: "CHAT" }, "trace:chat");
    const browserPane = store.createPane({ roomId: room.id, title: "Browser 1", mode: "BROWSER" }, "trace:browser");
    store.recordMcpDiscoveryCatalog({
      discoveredAt: "2026-07-06T00:00:00.000Z",
      servers: [
        {
          id: "test-stdio",
          displayName: "Test stdio",
          transport: "stdio",
          status: "VERIFIED",
          statusReason: "Discovery metadata captured.",
          schemaVersion: "2025-11-25",
          configHash: `sha256:${"b".repeat(64)}`,
          toolCount: 1,
          lastDiscoveredAt: "2026-07-06T00:00:00.000Z"
        }
      ],
      tools: [
        {
          id: "test-stdio:list_files",
          serverId: "test-stdio",
          name: "list_files",
          riskLevel: "R2",
          schemaHash: `sha256:${"c".repeat(64)}`,
          approvalRequired: true,
          status: "VERIFIED",
          statusReason: "Schema metadata captured."
        }
      ]
    });
    store.createPaneBrowserSession({
      sessionId: "browser_session:defaults-1",
      paneId: browserPane.id,
      roomId: room.id,
      ownerAgentId: "agent:1",
      agentNumber: 1,
      profileId: "profile:defaults-1",
      profilePath: "/opt/spaceapp/var/artifacts/browser-profiles/defaults-1",
      viewport: "desktop",
      targetUrl: "https://www.google.com/",
      currentUrl: "https://www.google.com/",
      title: "Olla Store",
      status: "READY",
      isActive: true
    });
    const { app, cookie } = await authedApp({
      store,
      config: getApiConfig({
        SPACE_AGENT_PANE_ENABLED: "true",
        SPACE_BROWSER_SESSIONS_ENABLED: "true"
      }),
      codexTurnStarter: new FakeCodexTurnStarter()
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(chatPane.id)}/agent-session`,
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    const session = agentPaneSessionSchema.parse(response.json());
    expect(session.binding.selectedToolIds).toEqual(
      expect.arrayContaining([
        "memory:search",
        "memory:save",
        "skills:list",
        "skills:read",
        "browser:navigate",
        "browser:screenshot",
        "browser:extract_text",
        "browser:click",
        "browser:type",
        "browser:scroll",
        "browser:set_viewport",
        "browser:diagnostics",
        "browser:record"
      ])
    );
    expect(store.getActiveSpaceAgentSession(chatPane.id)?.selectedToolIds).toEqual(
      expect.arrayContaining([
        "browser:navigate",
        "browser:screenshot",
        "browser:extract_text",
        "browser:click",
        "browser:type",
        "browser:scroll",
        "browser:set_viewport",
        "browser:diagnostics",
        "browser:record"
      ])
    );
    expect(session.toolOptions).toContainEqual(
      expect.objectContaining({
        id: "test-stdio:list_files",
        category: "mcp",
        isAvailable: true,
        enabled: false
      })
    );
  });

  it("keeps selected browser tools when a Space agent session is reloaded", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const room = store.createRoom({ name: "Browser Tool Reload", initialPaneCount: 0 }, "trace:room");
    const chatPane = store.createPane({ roomId: room.id, title: "Researcher", mode: "CHAT" }, "trace:chat");
    const browserPane = store.createPane({ roomId: room.id, title: "Browser 1", mode: "BROWSER" }, "trace:browser");
    store.createPaneBrowserSession({
      sessionId: "browser_session:reload-1",
      paneId: browserPane.id,
      roomId: room.id,
      ownerAgentId: "agent:1",
      agentNumber: 1,
      profileId: "profile:reload-1",
      profilePath: "/opt/spaceapp/var/artifacts/browser-profiles/reload-1",
      viewport: "desktop",
      targetUrl: "https://www.google.com/",
      currentUrl: "https://www.google.com/",
      title: "Olla Store",
      status: "READY",
      isActive: true
    });
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: getApiConfig({
        SPACE_AGENT_PANE_ENABLED: "true",
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_BROWSER_SESSIONS_ENABLED: "true"
      }),
      codexTurnStarter: new FakeCodexTurnStarter()
    });

    const created = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(chatPane.id)}/agent-session`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { selectedToolIds: ["browser:extract_text"] }
    });
    const loaded = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(chatPane.id)}/agent-session`,
      headers: { cookie }
    });

    expect(created.statusCode).toBe(200);
    expect(loaded.statusCode).toBe(200);
    expect(agentPaneSessionSchema.parse(created.json()).binding.selectedToolIds).toEqual(
      expect.arrayContaining(["browser:extract_text"])
    );
    expect(agentPaneSessionSchema.parse(loaded.json()).binding.selectedToolIds).toEqual(
      expect.arrayContaining(["browser:extract_text"])
    );
    expect(store.getActiveSpaceAgentSession(chatPane.id)?.selectedToolIds).toEqual(
      expect.arrayContaining(["browser:extract_text"])
    );
  });

  it("executes selected browser actions through the internal Space bridge without exposing browser internals", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const room = store.createRoom({ name: "Browser Bridge", initialPaneCount: 0 }, "trace:room");
    const chatPane = store.createPane({ roomId: room.id, title: "Researcher", mode: "CHAT" }, "trace:chat");
    const browserPane = store.createPane({ roomId: room.id, title: "Browser 1", mode: "BROWSER" }, "trace:browser");
    store.createSpaceAgentSession({
      sessionId: "agent_session:browser-bridge-1",
      paneId: chatPane.id,
      roomId: room.id,
      title: "Researcher",
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-selected-from-pane",
      selectedModelConfigId: "gpt-selected-from-pane",
      selectedProviderName: "Codex-LB",
      selectedModelName: "GPT selected",
      selectedReasoningKey: "high",
      selectedToolIds: ["browser:extract_text"]
    });
    const missionPrompt = store.createSpaceAgentMessage({
      sessionId: "agent_session:browser-bridge-1",
      role: "user",
      content: "Inspect the browser.",
      status: "COMPLETED"
    });
    const missionResponse = store.createSpaceAgentMessage({
      sessionId: "agent_session:browser-bridge-1",
      role: "assistant",
      content: "Stopped.",
      status: "FAILED"
    });
    const missionRequest = store.createRoomAgentRequest({
      requestId: "room_agent_request:browser-bridge-1",
      roomId: room.id,
      sessionId: "agent_session:browser-bridge-1",
      clientRequestId: "browser-bridge-stopped-mission-0001",
      promptMessageId: missionPrompt.messageId,
      responseMessageId: missionResponse.messageId
    });
    const stoppedMission = store.createRoomAgentMission({
      id: "room_agent_mission:browser-bridge-1",
      requestId: missionRequest.requestId,
      roomId: room.id,
      sessionId: "agent_session:browser-bridge-1",
      workflowId: "room-supervisor:browser-bridge-1",
      status: "INTERRUPTED",
      currentPaneId: null,
      statusReason: "Stopped by operator."
    });
    store.createPaneBrowserSession({
      sessionId: "browser_session:bridge-1",
      paneId: browserPane.id,
      roomId: room.id,
      ownerAgentId: "agent:1",
      agentNumber: 1,
      profileId: "profile:browser-bridge-1",
      profilePath: "/opt/spaceapp/var/artifacts/browser-profiles/browser-bridge-1",
      viewport: "desktop",
      targetUrl: "https://www.google.com/",
      currentUrl: "https://www.google.com/",
      title: "Olla Store",
      status: "READY",
      isActive: true
    });
    const fakeBrowser = fakeBrowserSessionManager(store);
    const { app } = await authedApp({
      store,
      browserSessionManager: fakeBrowser.manager,
      config: getApiConfig({
        SPACE_AGENT_PANE_ENABLED: "true",
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_BROWSER_SESSIONS_ENABLED: "true",
        SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true",
        SPACE_INTERNAL_API_TOKEN: "test-internal-token"
      }),
      codexTurnStarter: new FakeCodexTurnStarter()
    });

    const executed = await app.inject({
      method: "POST",
      url: "/api/internal/agent/browser-actions",
      headers: { "x-space-internal-token": "test-internal-token" },
      payload: {
        roomId: room.id,
        agentPaneId: chatPane.id,
        agentSessionId: "agent_session:browser-bridge-1",
        selectedToolIds: ["browser:extract_text"],
        actions: [
          {
            toolId: "browser:extract_text",
            targetPaneId: browserPane.id,
            action: { type: "extract_text" }
          }
        ]
      }
    });
    const blocked = await app.inject({
      method: "POST",
      url: "/api/internal/agent/browser-actions",
      headers: { "x-space-internal-token": "test-internal-token" },
      payload: {
        roomId: room.id,
        agentPaneId: chatPane.id,
        agentSessionId: "agent_session:browser-bridge-1",
        selectedToolIds: [],
        actions: [
          {
            toolId: "browser:extract_text",
            targetPaneId: browserPane.id,
            action: { type: "extract_text" }
          }
        ]
      }
    });
    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/internal/agent/browser-actions",
      headers: { "x-space-internal-token": "wrong-token" },
      payload: {}
    });
    const stopped = await app.inject({
      method: "POST",
      url: "/api/internal/agent/browser-actions",
      headers: { "x-space-internal-token": "test-internal-token" },
      payload: {
        roomId: room.id,
        agentPaneId: chatPane.id,
        agentSessionId: "agent_session:browser-bridge-1",
        roomAgentMissionId: stoppedMission.id,
        selectedToolIds: ["browser:extract_text"],
        actions: [
          {
            toolId: "browser:extract_text",
            targetPaneId: browserPane.id,
            action: { type: "extract_text" }
          }
        ]
      }
    });

    expect(executed.statusCode).toBe(200);
    expect(executed.json().results[0]).toMatchObject({
      status: "EXECUTED",
      observation: {
        currentUrl: `https://www.google.com/?${redactionQueryKey}=%5BREDACTED%5D&category=tea`,
        title: `Olla ${redactionQueryKey}:[REDACTED]`,
        text: `Observed page text with ${redactionQueryKey}:[REDACTED]`
      }
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json().results[0]).toMatchObject({ status: "BLOCKED" });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().results[0]).toMatchObject({ status: "BLOCKED", statusReason: "Stopped by operator." });
    expect(unauthorized.statusCode).toBe(401);
    expect(fakeBrowser.actionInputs).toHaveLength(1);
    expect(JSON.stringify(executed.json())).not.toMatch(/raw-secret|screenshotDataUrl|profilePath|cdp|websocket/i);
  });

  it("restores a native session by sessionId and keeps history without Coder ids", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store, "codex-lb", [verifiedModel("codex-lb", "gpt-5.5", "high")]);
    const room = store.createRoom({ name: "Agents", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const existing = store.createSpaceAgentSession({
      sessionId: "agent_session:restored-1",
      paneId: pane.id,
      roomId: room.id,
      title: "Restored",
      threadId: "thread:restored-1",
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-5.5",
      selectedModelConfigId: "gpt-5.5",
      selectedProviderName: "Codex-LB",
      selectedModelName: "GPT-5.5",
      selectedReasoningKey: "high",
      selectedToolIds: ["mcp:github"],
      isActive: false
    });
    const { app, cookie, csrfToken } = await authedApp({ store, codexTurnStarter: new FakeCodexTurnStarter() });

    const response = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        title: "Restored",
        sessionId: existing.sessionId,
        threadId: "thread:codex-history-1",
        selectedModelConfigId: "gpt-5.5:high",
        selectedToolIds: ["mcp-gateway"]
      }
    });

    expect(response.statusCode).toBe(200);
    const session = agentPaneSessionSchema.parse(response.json());
    expect(session.binding).toMatchObject({
      source: "SPACE",
      sessionId: existing.sessionId,
      coderChatId: null,
      title: "Restored"
    });
    expect(store.getActiveSpaceAgentSession(pane.id)).toMatchObject({
      sessionId: existing.sessionId,
      threadId: "thread:codex-history-1"
    });
    expect(session.history.find((item) => item.sessionId === existing.sessionId)).toMatchObject({
      source: "SPACE",
      coderChatId: null
    });
  });

  it("interrupts and updates settings on the native session", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store, "codex-lb", [verifiedModel("codex-lb", "gpt-default")]);
    const starter = new FakeCodexTurnStarter();
    const room = store.createRoom({ name: "Agents", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({ store, codexTurnStarter: starter });

    const send = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { content: "hello" }
    });
    const sent = agentPaneSessionSchema.parse(send.json());
    const interrupt = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/interrupt`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { reason: "operator requested" }
    });
    const settings = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/settings`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { selectedModelConfigId: "gpt-default:medium", selectedToolIds: [] }
    });

    expect(interrupt.statusCode).toBe(200);
    expect(agentPaneSessionSchema.parse(interrupt.json()).binding.status).toBe("READY");
    expect(store.getLatestSpaceAgentRun(sent.binding.sessionId!)?.status).toBe("INTERRUPTED");
    expect(settings.statusCode).toBe(200);
    expect(agentPaneSessionSchema.parse(settings.json()).binding.selectedToolIds).toEqual([
      "memory:search",
      "memory:save",
      "clipboard:list",
      "clipboard:get",
      "clipboard:save",
      "clipboard:save-plan",
      "chat:send",
      "chat:read",
      "chat:react",
      "tasks:list",
      "tasks:get",
      "tasks:save",
      "tasks:update",
      "skills:list",
      "skills:read"
    ]);
  });

  it("keeps per-pane provider, model, and reasoning selections when the global default provider changes", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store, "codex-lb", [
      verifiedModel("codex-lb", "gpt-planner", "medium"),
      verifiedModel("codex-lb", "gpt-reviewer", "high")
    ]);
    const room = store.createRoom({ name: "Global Provider", initialPaneCount: 2 }, "trace:room");
    const [firstPane, secondPane] = store.listPanes(room.id);
    const { app, cookie, csrfToken } = await authedApp({ store, codexTurnStarter: new FakeCodexTurnStarter() });

    const first = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(firstPane!.id)}/agent-session`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { selectedModelConfigId: "gpt-planner:medium" }
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(secondPane!.id)}/agent-session`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { selectedModelConfigId: "gpt-reviewer:high" }
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(agentPaneSessionSchema.parse(first.json()).binding.selectedModelConfigId).toBe("codex-v1|gpt-planner|medium");
    expect(agentPaneSessionSchema.parse(second.json()).binding.selectedModelConfigId).toBe("codex-v1|gpt-reviewer|high");
    expect(store.getActiveSpaceAgentSession(firstPane!.id)).toMatchObject({
      selectedProviderId: null,
      selectedModelConfigId: "codex-v1|gpt-planner|medium",
      selectedReasoningKey: "medium"
    });
    expect(store.getActiveSpaceAgentSession(secondPane!.id)).toMatchObject({
      selectedProviderId: null,
      selectedModelConfigId: "codex-v1|gpt-reviewer|high",
      selectedReasoningKey: "high"
    });

    useVerifiedDefaultProvider(store, "codex-lb", [verifiedModel("codex-lb", "gpt-direct", "medium")]);
    const reloadedFirst = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(firstPane!.id)}/agent-session`,
      headers: { cookie }
    });
    const reloadedSecond = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(secondPane!.id)}/agent-session`,
      headers: { cookie }
    });

    expect(reloadedFirst.statusCode).toBe(200);
    expect(reloadedSecond.statusCode).toBe(200);
    expect(agentPaneSessionSchema.parse(reloadedFirst.json()).selectedModelConfigId).toBe("codex-v1|gpt-planner|medium");
    expect(agentPaneSessionSchema.parse(reloadedSecond.json()).selectedModelConfigId).toBe("codex-v1|gpt-reviewer|high");
    expect(store.getActiveSpaceAgentSession(firstPane!.id)?.selectedProviderId).toBeNull();
    expect(store.getActiveSpaceAgentSession(secondPane!.id)?.selectedProviderId).toBeNull();
  });

  it("does not consult the global Space provider gate for Chat sends", async () => {
    const store = new InMemorySpaceStore();
    const starter = new FakeCodexTurnStarter();
    const room = store.createRoom({ name: "Blocked Provider", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({ store, codexTurnStarter: starter });

    const response = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { content: "This must not start." }
    });

    expect(response.statusCode).toBe(200);
    const session = agentPaneSessionSchema.parse(response.json());
    expect(session.binding.status).toBe("RUNNING");
    expect(starter.started).toHaveLength(1);
    expect(starter.started[0]?.providerId).toBeNull();
    expect(store.listSpaceAgentMessages(session.binding.sessionId!)).toHaveLength(2);
  });

  it("fails closed with a Space runtime blocked state and does not expose the old Coder proxy", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Agents", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({
      store,
      config: getApiConfig({ SPACE_AGENT_PANE_ENABLED: "false" }),
      codexTurnStarter: new FakeCodexTurnStarter()
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
      headers: { cookie }
    });
    const proxy = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/coder-agent/proxy`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { resource: "chat", method: "POST", query: {}, body: {} }
    });

    expect(response.statusCode).toBe(200);
    const session = agentPaneSessionSchema.parse(response.json());
    expect(session.binding.source).toBe("SPACE");
    expect(session.binding.status).toBe("BLOCKED");
    expect(session.runStatus).toBe("BLOCKED");
    expect(session.capabilities.canSend).toBe(false);
    expect(session.statusReason).toContain("SPACE_AGENT_PANE_ENABLED");
    expect(proxy.statusCode).toBe(404);
    expect(JSON.stringify({ session: response.json(), proxy: proxy.json() })).not.toContain("192.0.2.216");
  });

  it("normalizes legacy sessions to explicit fixed Full access", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const control = new FakeCodexAgentControl();
    const room = store.createRoom({ name: "Permission Cache", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const legacy = store.createSpaceAgentSession({
      paneId: pane.id,
      roomId: room.id,
      title: "Legacy inherited permissions",
      threadId: null,
      selectedProviderId: null,
      selectedModelId: "gpt-provider-verified",
      selectedModelConfigId: "gpt-provider-verified:medium",
      selectedProviderName: null,
      selectedModelName: "gpt-provider-verified",
      selectedReasoningKey: "medium",
      selectedToolIds: [],
      permissionMode: null,
      isActive: true
    });
    const { app, cookie } = await authedApp({
      store,
      codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: control,
      codexGoals: control.codexGoalsAdapter()
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    const session = agentPaneSessionSchema.parse(response.json());
    expect(session.permissionMode).toBe("full_access");
    expect(session.permissionState).toMatchObject({
      mode: "full_access",
      effectiveMode: "full_access",
      isInherited: false,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      reviewer: "user"
    });
    expect(session.permissionOptions.map((option) => [option.mode, option.isAvailable])).toEqual([
      ["ask_for_approval", false], ["approve_for_me", true], ["full_access", true]
    ]);
    expect(store.getSpaceAgentSession(legacy.sessionId)?.permissionMode).toBe("full_access");
    expect(session.collaborationMode).toBe("default");
    expect(control.requirementsCalls).toBe(1);
    expect(control.collaborationCalls).toBe(1);
  });

  it("persists each selected permission mode across reloads and forwards it to turns", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const control = new FakeCodexAgentControl();
    const starter = new FakeCodexTurnStarter();
    const room = store.createRoom({ name: "Permission selection", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({ store, codexTurnStarter: starter,
      codexAgentControl: control, codexGoals: control.codexGoalsAdapter() });
    for (const permissionMode of ["approve_for_me", "full_access"] as const) {
      const changed = await app.inject({ method: "PATCH", url: `/api/panes/${encodeURIComponent(pane.id)}/agent/settings`,
        headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { permissionMode } });
      expect(changed.statusCode).toBe(200);
      expect(agentPaneSessionSchema.parse(changed.json()).permissionState.effectiveMode).toBe(permissionMode);
      const loaded = await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`, headers: { cookie } });
      const session = agentPaneSessionSchema.parse(loaded.json());
      expect(session.permissionMode).toBe(permissionMode);
      expect(store.getSpaceAgentSession(session.binding.sessionId!)?.permissionMode).toBe(permissionMode);
      const sent = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/agent/messages`,
        headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { content: "Check the selected permissions." } });
      expect(sent.statusCode).toBe(200);
      expect(starter.started.at(-1)?.permissionMode).toBe(permissionMode);
      await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/agent/interrupt`,
        headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { reason: "Test cleanup" } });
    }
  });

  it("blocks before transcript writes when runtime requirements disallow fixed Full access", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const starter = new FakeCodexTurnStarter();
    const control = new FakeCodexAgentControl();
    control.requirements = {
      ...control.requirements,
      allowedSandboxModes: ["workspace-write"]
    };
    const room = store.createRoom({ name: "Full Access Disallowed", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({
      store,
      codexTurnStarter: starter,
      codexAgentControl: control,
      codexGoals: control.codexGoalsAdapter()
    });

    const loaded = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
      headers: { cookie }
    });
    expect(loaded.statusCode).toBe(200);
    const blockedOnLoad = agentPaneSessionSchema.parse(loaded.json());
    expect(blockedOnLoad.binding.status).toBe("BLOCKED");
    expect(store.getActiveSpaceAgentSession(pane.id)?.status).toBe("BLOCKED");
    expect(blockedOnLoad.history.find((item) => item.sessionId === blockedOnLoad.binding.sessionId)?.status).toBe("BLOCKED");

    const sent = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { content: "This must never start with weaker permissions." }
    });

    expect(sent.statusCode).toBe(200);
    const session = agentPaneSessionSchema.parse(sent.json());
    expect(session.permissionMode).toBe("full_access");
    expect(session.binding.status).toBe("BLOCKED");
    expect(session.permissionOptions).toContainEqual(
      expect.objectContaining({ mode: "full_access", isAvailable: false })
    );
    expect(starter.started).toHaveLength(0);
    expect(store.listSpaceAgentMessages(session.binding.sessionId!)).toHaveLength(0);
  });

  it("persists a missing Plan capability as blocked before returning session history", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const control = new FakeCodexAgentControl();
    control.collaborationModes = [
      { name: "Default", mode: "default" as const, model: null, reasoning_effort: null }
    ];
    const room = store.createRoom({ name: "Plan Capability Removed", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const persisted = store.createSpaceAgentSession({
      paneId: pane.id,
      roomId: room.id,
      status: "READY",
      title: "Legacy Plan task",
      threadId: null,
      selectedProviderId: null,
      selectedModelId: "gpt-provider-verified",
      selectedModelConfigId: "gpt-provider-verified:medium",
      selectedProviderName: null,
      selectedModelName: "gpt-provider-verified",
      selectedReasoningKey: "medium",
      selectedToolIds: [],
      permissionMode: "full_access",
      collaborationMode: "plan",
      isActive: true
    });
    const { app, cookie } = await authedApp({
      store,
      codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: control
    });

    const loaded = await app.inject({
      method: "GET",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
      headers: { cookie }
    });

    expect(loaded.statusCode).toBe(200);
    const session = agentPaneSessionSchema.parse(loaded.json());
    expect(session.binding.status).toBe("BLOCKED");
    expect(session.statusReason).toContain("Plan mode");
    expect(store.getSpaceAgentSession(persisted.sessionId)?.status).toBe("BLOCKED");
    expect(session.history.find((item) => item.sessionId === persisted.sessionId)?.status).toBe("BLOCKED");
  });

  it("accepts fixed Full access without confirmation and forwards it with Plan mode", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const starter = new FakeCodexTurnStarter();
    const control = new FakeCodexAgentControl();
    const room = store.createRoom({ name: "Permission Forwarding", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({
      store,
      codexTurnStarter: starter,
      codexAgentControl: control,
      codexGoals: control.codexGoalsAdapter()
    });

    const fixed = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/settings`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { permissionMode: "full_access", collaborationMode: "plan" }
    });
    const sent = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { content: "Build the requested implementation." }
    });

    expect(fixed.statusCode).toBe(200);
    expect(sent.statusCode).toBe(200);
    expect(starter.started[0]).toMatchObject({ permissionMode: "full_access", collaborationMode: "plan" });
    const settingsAudit = store.listAuditEvents().find((event) => event.action === "pane.agent.settings");
    expect(settingsAudit?.metadata).toMatchObject({ permissionMode: "full_access", collaborationMode: "plan" });
    expect(JSON.stringify(settingsAudit)).not.toContain("Build the requested implementation");
  });

  it("creates and clears a pane goal through Codex control while persisting the new thread", async () => {
    const store = new InMemorySpaceStore();
    useVerifiedDefaultProvider(store);
    const control = new FakeCodexAgentControl();
    const room = store.createRoom({ name: "Pane Goal", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const { app, cookie, csrfToken } = await authedApp({
      store,
      codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: control,
      codexGoals: control.codexGoalsAdapter()
    });

    const created = await app.inject({
      method: "PUT",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/goal`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { objective: "Ship Codex Windows parity." }
    });
    expect(created.statusCode).toBe(200);
    const createdSession = agentPaneSessionSchema.parse(created.json());
    expect(createdSession.threadId).toBe("thread:goal-created");
    expect(createdSession.goal).toMatchObject({
      threadId: "thread:goal-created",
      objective: "Ship Codex Windows parity.",
      status: "active"
    });
    expect(store.getActiveSpaceAgentSession(pane.id)?.threadId).toBe("thread:goal-created");
    // Without SPACE_CODEX_GOAL_TOKEN_BUDGET the Goal is set without a budget, as before.
    expect(control.goalTokenBudgets).toEqual([undefined]);

    const cleared = await app.inject({
      method: "DELETE",
      url: `/api/panes/${encodeURIComponent(pane.id)}/agent/goal`,
      headers: { cookie, [csrfHeaderName]: csrfToken }
    });
    expect(cleared.statusCode).toBe(200);
    expect(agentPaneSessionSchema.parse(cleared.json()).goal).toBeNull();
    expect(store.listAuditEvents().map((event) => event.action)).toEqual(
      expect.arrayContaining(["pane.agent.goal.set", "pane.agent.goal.clear"])
    );
  });
});

it("submits a Live control Chat prompt with a maximum-length request ID only once", async () => {
  const store = new InMemorySpaceStore();
  useVerifiedDefaultProvider(store);
  const room = store.createRoom({ name: "Live Chat control", initialPaneCount: 1 });
  const pane = store.listPanes(room.id)[0]!;
  const starter = new FakeCodexTurnStarter();
  const { app, cookie, csrfToken } = await authedApp({ store, codexTurnStarter: starter });
  await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`, headers: { cookie } });
  const payload = { roomId: room.id, requestId: "live-" + "x".repeat(123), actions: [{ kind: "pane", operation: "prompt", target: { paneIds: [pane.id] }, text: "Write exactly thirty words." }] };
  const send = () => app.inject({ method: "POST", url: "/api/control/v1/commands", headers: { cookie, [csrfHeaderName]: csrfToken }, payload });
  const first = await send();
  expect(first.statusCode).toBe(200);
  expect(first.json()).toMatchObject({ status: "COMPLETED", results: [{ paneId: pane.id, status: "COMPLETED" }] });
  const replay = await send();
  expect(replay.json().id).toBe(first.json().id);
  expect(starter.started).toHaveLength(1);
  expect(starter.plan(starter.started[0]!).workflowId.length).toBeLessThanOrEqual(128);
});

describe("Codex Goal token budget", () => {
  it("reads SPACE_CODEX_GOAL_TOKEN_BUDGET and ignores unset or out-of-range values", async () => {
    const { codexGoalTokenBudgetFromEnv } = await import("../src/space-agent.js");
    expect(codexGoalTokenBudgetFromEnv({})).toBeNull();
    expect(codexGoalTokenBudgetFromEnv({ SPACE_CODEX_GOAL_TOKEN_BUDGET: "2000000" })).toBe(2_000_000);
    for (const value of ["9999", "1000000001", "-5", "2e6", "lots", ""]) {
      expect(codexGoalTokenBudgetFromEnv({ SPACE_CODEX_GOAL_TOKEN_BUDGET: value })).toBeNull();
    }
  });

  it("sets the configured budget on the native Codex Goal", async () => {
    const previous = process.env.SPACE_CODEX_GOAL_TOKEN_BUDGET;
    process.env.SPACE_CODEX_GOAL_TOKEN_BUDGET = "2000000";
    try {
      const store = new InMemorySpaceStore();
      useVerifiedDefaultProvider(store);
      const control = new FakeCodexAgentControl();
      const room = store.createRoom({ name: "Budgeted Goal", initialPaneCount: 1 }, "trace:room");
      const pane = store.listPanes(room.id)[0]!;
      const { app, cookie, csrfToken } = await authedApp({
        store, codexTurnStarter: new FakeCodexTurnStarter(), codexAgentControl: control, codexGoals: control.codexGoalsAdapter()
      });
      const created = await app.inject({
        method: "PUT",
        url: `/api/panes/${encodeURIComponent(pane.id)}/agent/goal`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { objective: "Ship within budget." }
      });
      expect(created.statusCode).toBe(200);
      expect(control.goalTokenBudgets).toEqual([2_000_000]);
    } finally {
      if (previous === undefined) delete process.env.SPACE_CODEX_GOAL_TOKEN_BUDGET;
      else process.env.SPACE_CODEX_GOAL_TOKEN_BUDGET = previous;
    }
  });
});
