import { afterEach, describe, expect, it, vi } from "vitest";
import { type DummyTurnInput, type TurnStartResult } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import type { AutoRouteShadowRepository } from "@space/db";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createSpaceAgentAdapter as createCachedSpaceAgentAdapter, type AutoRouteFacts } from "../src/space-agent.js";
import { cliRuntimeModelsChatProviderAdapter } from "../src/chat-providers.js";
import { cookieName } from "../src/auth.js";
import { createDecisionsService } from "../src/decisions-service.js";
import type { TurnStarter } from "../src/turns.js";

// Keep these local fixtures away from live discovery, visibility files, and host probes.
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
    override start() {}
  } };
});

const csrfHeaderName = "x-space-csrf-token";
function createSpaceAgentAdapter(options: Parameters<typeof createCachedSpaceAgentAdapter>[0]) {
  return createCachedSpaceAgentAdapter({ ...options, modelCatalogCacheMaxAgeMs: 0 });
}
class FakeCodexTurnStarter implements TurnStarter {
  readonly started: DummyTurnInput[] = [];
  plan(input: DummyTurnInput): TurnStartResult {
    return {
      workflowId: `workflow:codex-app-server:${input.roomId}:${input.paneId}:${input.traceId}`,
      runId: null, roomId: input.roomId, paneId: input.paneId, traceId: input.traceId,
      status: "QUEUED", runtime: "CODEX_APP_SERVER", artifactIds: input.artifactIds ?? []
    };
  }
  async start(input: DummyTurnInput): Promise<TurnStartResult> {
    this.started.push(input);
    return { ...this.plan(input), runId: "temporal:test-run" };
  }
}
class FakeCodexAgentControl {
  async readConfigRequirements() {
    return {
      allowedApprovalPolicies: ["on-request", "never"], allowedApprovalsReviewers: ["user", "guardian_subagent"],
      allowedSandboxModes: ["workspace-write", "danger-full-access"], defaultPermissions: null
    };
  }
  async listModels() {
    return [{ id: "gpt-provider-verified", displayName: "gpt-provider-verified", isDefault: true,
      defaultReasoningEffort: "medium", supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"] }];
  }
  async listCollaborationModes() {
    return [{ name: "Default", mode: "default" as const, model: null, reasoning_effort: null }];
  }
  async setGoal() { throw new Error("Goals are outside this fixture."); }
  async clearGoal() { throw new Error("Goals are outside this fixture."); }
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
async function authedApp(options: { store: InMemorySpaceStore; spaceAgentAdapter: ReturnType<typeof createSpaceAgentAdapter>; autoRouteShadowRepository?: AutoRouteShadowRepository }) {
  const app = await createApp({
    config: enabledConfig(),
    decisionsService: createDecisionsService({ enabled: false, readFileImpl: async () => "" }),
    codexAgentControl: new FakeCodexAgentControl(),
    cancelWorkflow: async () => {},
    ...options,
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false }
  });
  ownedApps.add(app);
  const login = await app.inject({ method: "POST", url: "/api/auth/login",
    payload: { email: "space@space.local", password: "space-dev" } });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.find(item => item.name === cookieName && item.value)?.value;
  expect(cookie).toBeTruthy();
  const cookieHeader = `${cookieName}=${cookie}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie: cookieHeader } });
  expect(csrf.statusCode).toBe(200);
  return { app, cookie: cookieHeader, csrfToken: csrf.json().csrfToken as string };
}

describe("Stage 7 Auto routing evidence", () => {
  it("summarizes shadow decisions for ADMINs from routing facts only", async () => {
    const store = new InMemorySpaceStore(); useVerifiedDefaultProvider(store);
    const at = new Date().toISOString();
    const recent = vi.fn(async () => [{ status: "COMPLETED", runtimeModelAtStart: "big", ledger: null,
      autoRoute: { policyVersion: "auto-route-v1", mode: "SHADOW" as const, decidedAt: at, tier: "LIGHT" as const, estimatedInputTokens: 6_010,
        choice: { model: "small", reasoning: "low" }, reasons: ["A short request with no files."], excluded: [],
        actual: { model: null, reasoning: null, source: "RUNTIME_DEFAULT" as const }, agreesWithActual: null } }]);
    const { app, cookie } = await authedApp({ store, spaceAgentAdapter: createSpaceAgentAdapter({ store, config: enabledConfig(),
      codexTurnStarter: new FakeCodexTurnStarter(), codexAgentControl: new FakeCodexAgentControl() }),
      autoRouteShadowRepository: { recent, dispose: async () => undefined } });
    const response = await app.inject({ method: "GET", url: "/api/dots/auto-routing/shadow?days=3", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mode: "SHADOW", applied: false, runs: 1, wouldChoose: { small: 1 },
      byTier: { LIGHT: { runs: 1, differ: 1 } }, outcomes: { differ: { runs: 1, completed: 1 } }, usage: { unknown: 1 } });
    expect(Date.parse(recent.mock.calls[0]![0] as string)).toBeLessThan(Date.now() - 2.9 * 86_400_000);
    expect((await app.inject({ method: "GET", url: "/api/dots/auto-routing/shadow?days=365", headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/dots/auto-routing/shadow" })).statusCode).toBe(401);
    // Evaluations need the Dots database; without it they say so instead of pretending to run.
    const evals = await app.inject({ method: "GET", url: `/api/dots/dot:${"a".repeat(32)}/evals`, headers: { cookie } });
    expect(evals.statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: `/api/dots/dot:${"a".repeat(32)}/evals` })).statusCode).toBe(401);
  });
});

describe("Stage 5 Dot turns: attachment coverage and proactive work", () => {
  const orbit = `dot:${"a".repeat(32)}`;
  function fixture(gateway: boolean, autoRouteFacts?: () => Promise<AutoRouteFacts>) {
    const store = new InMemorySpaceStore(); useVerifiedDefaultProvider(store);
    const room = store.createRoom({ name: "Dot readers", initialPaneCount: 1 });
    const pane = store.listPanes(room.id)[0]!;
    const starter = new FakeCodexTurnStarter();
    const readDotAttachments = vi.fn(async ({ artifacts }: { artifacts: Array<{ id: string }> }) => artifacts.map((artifact) => ({ artifactId: artifact.id,
      coverage: { status: "PARTIAL" as const, method: "pdf-text", chars: 10, pages: 3, truncated: false, reason: "1 of 3 pages have no text layer." },
      line: "read PARTIAL (3 pages) — 1 of 3 pages have no text layer.; text at /dots/a.txt" })));
    const adapter = createSpaceAgentAdapter({ store, config: enabledConfig(), codexTurnStarter: starter, codexAgentControl: new FakeCodexAgentControl(),
      validateDot: async () => undefined, dotTurnContext: async () => ({ toolGateway: gateway, developerContext: "You are Orbit." }), readDotAttachments,
      ...(autoRouteFacts ? { autoRouteFacts } : {}) });
    return { store, room, pane, starter, adapter, readDotAttachments };
  }
  it("records what Auto would choose without changing the model that runs", async () => {
    const f = fixture(true, async () => ({ capabilities: new Map(), prices: null }));
    const session = await f.adapter.createOrRestoreSession({ pane: f.pane, dotId: orbit });
    const { artifact } = f.store.createArtifact({ roomId: f.room.id, paneId: f.pane.id, kind: "EXPORT", mimeType: "application/pdf",
      storageUri: "space-artifact://user-uploads/room/day/report.pdf", sha256: "c".repeat(64), byteSize: 100, metadata: { originalFilename: "report.pdf" } });
    await f.adapter.sendMessage({ pane: f.pane, content: "Summarize the report", artifactIds: [artifact.id], operatorUserId: "user:owner",
      clientRequestId: "goal-0123456789", traceId: "trace:auto-1" });
    const run = await f.store.getLatestSpaceAgentRun(session.binding.sessionId!);
    expect(run?.execution?.autoRoute).toMatchObject({ policyVersion: "auto-route-v1", mode: "SHADOW", tier: "DEEP",
      reasons: expect.arrayContaining(["Background work runs without the user watching."]) });
    expect(run?.execution?.autoRoute?.actual).toEqual({ model: f.starter.started[0]!.modelId ?? null,
      reasoning: f.starter.started[0]!.reasoningEffort ?? null, source: f.starter.started[0]!.modelId ? "USER_SELECTED" : "RUNTIME_DEFAULT" });
    expect(run?.execution?.requestedModel ?? null).toBe(f.starter.started[0]!.modelId ?? null);

    const failing = fixture(true, async () => { throw new Error("cache unreadable"); });
    const other = await failing.adapter.createOrRestoreSession({ pane: failing.pane, dotId: orbit });
    await failing.adapter.sendMessage({ pane: failing.pane, content: "Hello", operatorUserId: "user:owner", clientRequestId: "request:auto-2", traceId: "trace:auto-2" });
    expect((await failing.store.getLatestSpaceAgentRun(other.binding.sessionId!))?.execution?.autoRoute).toBeUndefined();
    expect(failing.starter.started).toHaveLength(1);
  });
  it("gives a Dot on a CLI runtime its identity and personality in the prompt", async () => {
    const store = new InMemorySpaceStore(); useVerifiedDefaultProvider(store);
    const room = store.createRoom({ name: "Dot on Claude", initialPaneCount: 1 });
    const pane = store.listPanes(room.id)[0]!;
    const starter = new FakeCodexTurnStarter();
    const dotTurnContext = vi.fn(async () => ({ toolGateway: true, developerContext: "Codex only" }));
    const dotIdentity = vi.fn(async () => "You are Nova.\nYour personality: Warm encourager.");
    const adapter = createSpaceAgentAdapter({ store, config: enabledConfig(), codexTurnStarter: starter, codexAgentControl: new FakeCodexAgentControl(),
      validateDot: async () => undefined, dotTurnContext, dotIdentity,
      cliChatProviderAdapters: [cliRuntimeModelsChatProviderAdapter({ runtimeId: "cli:claude",
        executeModels: async () => "claude-opus-5-5\tClaude Opus 5.5\thigh\thigh", resolveState: async () => ({ enabled: true, reason: null }) })] });
    await adapter.createOrRestoreSession({ pane, dotId: orbit, selectedModelConfigId: "cli:claude-v1|claude-opus-5-5|high" });
    await adapter.sendMessage({ pane, content: "Fix it now!!", operatorUserId: "user:owner", clientRequestId: "request:cli-dot-1", traceId: "trace:cli-dot-1" });
    expect(starter.started[0]).toMatchObject({ providerId: "cli:claude" });
    expect(starter.started[0]!.prompt).toMatch(/^You are Nova\.\nYour personality: Warm encourager\.\n\n[\s\S]*User prompt:\nFix it now!!$/);
    expect(starter.started[0]!.developerContext).toBeUndefined();
    expect(dotTurnContext).not.toHaveBeenCalled();
  });
  it("reads attachments before a gateway turn and records what was read", async () => {
    const f = fixture(true);
    const session = await f.adapter.createOrRestoreSession({ pane: f.pane, dotId: orbit });
    const { artifact } = f.store.createArtifact({ roomId: f.room.id, paneId: f.pane.id, kind: "EXPORT", mimeType: "application/pdf",
      storageUri: "space-artifact://user-uploads/room/day/report.pdf", sha256: "c".repeat(64), byteSize: 100, metadata: { originalFilename: "report.pdf" } });
    await f.adapter.sendMessage({ pane: f.pane, content: "Summarize the report", artifactIds: [artifact.id], operatorUserId: "user:owner",
      clientRequestId: "request:reader-1", traceId: "trace:reader-1" });
    expect(f.readDotAttachments).toHaveBeenCalledWith(expect.objectContaining({ dotId: orbit }));
    expect(f.starter.started[0]!.prompt).toContain("read PARTIAL (3 pages)");
    expect(f.starter.started[0]!.prompt).toContain("never guess unread content");
    const run = await f.store.getLatestSpaceAgentRun(session.binding.sessionId!);
    expect(run?.execution?.attachments?.[0]).toMatchObject({ artifactId: artifact.id, coverage: { status: "PARTIAL", pages: 3 } });
  });
  it("runs proactive work read-only on gateway turns and refuses it elsewhere", async () => {
    const off = fixture(false);
    await off.adapter.createOrRestoreSession({ pane: off.pane, dotId: orbit });
    await expect(off.adapter.sendMessage({ pane: off.pane, content: "Check the inbox", operatorUserId: "user:owner",
      clientRequestId: "proactive-0123456789", traceId: "trace:proactive-1" })).rejects.toThrow(/Proactive work runs only/);
    expect(off.starter.started).toHaveLength(0);
    const on = fixture(true);
    await on.adapter.createOrRestoreSession({ pane: on.pane, dotId: orbit });
    await on.adapter.sendMessage({ pane: on.pane, content: "Check the inbox", operatorUserId: "user:owner",
      clientRequestId: "proactive-0123456789", traceId: "trace:proactive-2" });
    expect(on.starter.started[0]).toMatchObject({ dotWorkMode: "PROACTIVE", selectedToolIds: [] });
  });
});

describe("Stage2 Dot session boundaries", () => {
  const orbit = `dot:${"a".repeat(32)}`, nova = `dot:${"b".repeat(32)}`;
  function fixture() {
    const store = new InMemorySpaceStore(); useVerifiedDefaultProvider(store);
    const room = store.createRoom({ name: "Dot boundaries", initialPaneCount: 1 });
    const pane = store.listPanes(room.id)[0]!;
    const validateDot = vi.fn(async (_pane: unknown, dotId: string, owner?: string) => {
      if (![orbit, nova].includes(dotId) || owner === "user:other") throw new Error("Dot is not owned by this room owner.");
    });
    const adapter = createSpaceAgentAdapter({ store, config: enabledConfig(), codexTurnStarter: new FakeCodexTurnStarter(),
      codexAgentControl: new FakeCodexAgentControl(), validateDot });
    return { store, pane, adapter, validateDot };
  }
  it("preserves explicit identity, never silently reuses another Dot, and keeps omitted IDs compatible", async () => {
    const f = fixture();
    const first = await f.adapter.createOrRestoreSession({ pane: f.pane, dotId: orbit });
    expect(first.dotId).toBe(orbit);
    const second = await f.adapter.createOrRestoreSession({ pane: f.pane, dotId: nova });
    expect(second.dotId).toBe(nova); expect(second.binding.sessionId).not.toBe(first.binding.sessionId);
    expect((await f.adapter.loadSession({ pane: f.pane })).binding.sessionId).toBe(second.binding.sessionId);
    await expect(f.adapter.createOrRestoreSession({ pane: f.pane, dotId: nova, sessionId: first.binding.sessionId })).rejects.toThrow();
    expect(f.store.getSpaceAgentSession(first.binding.sessionId!)?.dotId).toBe(orbit);
  });
  it("validates owner and room before any session write or thread reassignment", async () => {
    const f = fixture();
    await expect(f.adapter.createOrRestoreSession({ pane: f.pane, dotId: orbit, ownerUserId: "user:other" })).rejects.toThrow();
    expect(f.store.getActiveSpaceAgentSession(f.pane.id)).toBeNull();
    const first = await f.adapter.createOrRestoreSession({ pane: f.pane, dotId: orbit });
    f.store.updateSpaceAgentSession(first.binding.sessionId!, { threadId: "thread:orbit" });
    await expect(f.adapter.createOrRestoreSession({ pane: f.pane, dotId: nova, sessionId: null, threadId: "thread:orbit" })).rejects.toThrow();
    const otherRoom = f.store.createRoom({ name: "Other", initialPaneCount: 1 });
    await expect(f.adapter.createOrRestoreSession({ pane: f.store.listPanes(otherRoom.id)[0]!, dotId: orbit, sessionId: first.binding.sessionId })).rejects.toThrow();
  });
  it("rejects retargeting during authoritative work even if the client requests a fresh task", async () => {
    const f = fixture();
    const first = await f.adapter.createOrRestoreSession({ pane: f.pane, dotId: orbit });
    await f.adapter.sendMessage({ pane: f.pane, content: "Work", clientRequestId: "request:dotwork", traceId: "trace:dotwork" });
    for (const input of [{ dotId: nova }, { dotId: orbit, sessionId: null }]) {
      await expect(f.adapter.createOrRestoreSession({ pane: f.pane, ...input })).rejects.toThrow();
    }
    expect(f.store.getActiveSpaceAgentSession(f.pane.id)?.sessionId).toBe(first.binding.sessionId);
  });
  it("accepts a running session checkpoint but still rejects user thread and session retargets", async () => {
    const f = fixture();
    const first = await f.adapter.createOrRestoreSession({ pane: f.pane, dotId: orbit });
    const sessionId = first.binding.sessionId!;
    await f.adapter.sendMessage({ pane: f.pane, content: "Work", clientRequestId: "request:checkpoint", traceId: "trace:checkpoint" });
    const queued = f.store.getLatestSpaceAgentRun(sessionId)!;
    // apps/worker/src/activities.ts persists the run's checkpoint before its session.
    f.store.updateSpaceAgentRunByWorkflowId(queued.workflowId, {
      status: "RUNNING", codexThreadId: "thread:checkpoint", codexTurnId: "turn:checkpoint"
    });
    expect(f.store.updateSpaceAgentSession(sessionId, {
      threadId: "thread:checkpoint", lastSyncedAt: "2026-10-09T00:00:00.000Z"
    }).threadId).toBe("thread:checkpoint");
    await expect(f.adapter.createOrRestoreSession({ pane: f.pane, dotId: orbit, threadId: "thread:other" })).rejects.toThrow();
    await expect(f.adapter.createOrRestoreSession({ pane: f.pane, dotId: nova })).rejects.toThrow();
    expect(f.store.getActiveSpaceAgentSession(f.pane.id)?.sessionId).toBe(sessionId);
    expect(f.store.getSpaceAgentSession(sessionId)?.threadId).toBe("thread:checkpoint");
  });
  it("rejects stale session and Dot sends before creating messages or starting work", async () => {
    const f = fixture();
    const first = await f.adapter.createOrRestoreSession({ pane: f.pane, dotId: orbit });
    const second = await f.adapter.createOrRestoreSession({ pane: f.pane, dotId: nova });
    for (const identity of [
      { sessionId: first.binding.sessionId!, dotId: orbit },
      { sessionId: first.binding.sessionId!, dotId: nova },
      { sessionId: second.binding.sessionId!, dotId: orbit }
    ]) {
      await expect(f.adapter.sendMessage({ pane: f.pane, content: "Stale", clientRequestId: "request:stale",
        traceId: "trace:stale", ...identity })).rejects.toThrow("selected Dot session changed");
    }
    expect(f.store.listSpaceAgentMessages(first.binding.sessionId!)).toEqual([]);
    expect(f.store.listSpaceAgentMessages(second.binding.sessionId!)).toEqual([]);
    expect(f.store.getLatestSpaceAgentRun(second.binding.sessionId!)).toBeNull();
    expect(f.store.getActiveSpaceAgentSession(f.pane.id)?.sessionId).toBe(second.binding.sessionId);
  });
});

it("blocks explicit unresolved native requests at both retarget and send boundaries", async () => {
  const store = new InMemorySpaceStore(); useVerifiedDefaultProvider(store);
  const room = store.createRoom({ name: "Dot requests", initialPaneCount: 1 }); const pane = store.listPanes(room.id)[0]!;
  let pending: { kind: "APPROVAL" } | null = null;
  const orbit = `dot:${"a".repeat(32)}`, nova = `dot:${"b".repeat(32)}`;
  const adapter = createSpaceAgentAdapter({ store, config: enabledConfig(), codexTurnStarter: new FakeCodexTurnStarter(),
    codexAgentControl: new FakeCodexAgentControl(), validateDot: async () => {}, readPendingRequest: async () => pending });
  await adapter.createOrRestoreSession({ pane, dotId: orbit }); pending = { kind: "APPROVAL" };
  const loaded = await adapter.loadSession({ pane });
  expect(loaded.pendingRequest?.kind).toBe("APPROVAL"); expect(loaded.capabilities.canSend).toBe(false);
  await expect(adapter.createOrRestoreSession({ pane, dotId: nova })).rejects.toThrow();
  await expect(adapter.sendMessage({ pane, content: "Work", traceId: "trace:pending" })).rejects.toThrow();
  expect(store.getActiveSpaceAgentSession(pane.id)?.dotId).toBe(orbit);
});

it("roundtrips the explicit owned Dot through the real session HTTP route", async () => {
  const store = new InMemorySpaceStore(); useVerifiedDefaultProvider(store);
  const room = store.createRoom({ name: "HTTP Dot identity", initialPaneCount: 1 }); const pane = store.listPanes(room.id)[0]!;
  const dotId = `dot:${"a".repeat(32)}`;
  const validateDot = vi.fn(async () => {});
  const adapter = createSpaceAgentAdapter({ store, config: enabledConfig(), codexTurnStarter: new FakeCodexTurnStarter(),
    codexAgentControl: new FakeCodexAgentControl(), validateDot });
  const { app, cookie, csrfToken } = await authedApp({ store, spaceAgentAdapter: adapter });
  const response = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/agent-session`,
    headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { dotId, sessionId: null } });
  expect(response.statusCode).toBe(200); expect(response.json().dotId).toBe(dotId);
  expect(validateDot).toHaveBeenCalledWith(pane, dotId, expect.any(String));
  expect(store.getActiveSpaceAgentSession(pane.id)?.dotId).toBe(dotId);
});

describe("Stage 8: Dot settings from SpaceApp and one conversation per Dot", () => {
  const orbit = `dot:${"a".repeat(32)}`;
  const nova = `dot:${"b".repeat(32)}`;
  function fixture(input: { runtime?: { modelConfigId: string | null; permissionMode: "approve_for_me" | "full_access" | null };
    defaultDot?: string | null; context?: string | null } = {}) {
    const store = new InMemorySpaceStore(); useVerifiedDefaultProvider(store);
    const room = store.createRoom({ name: "Dot home", initialPaneCount: 1 });
    const pane = store.listPanes(room.id)[0]!;
    const starter = new FakeCodexTurnStarter();
    const onAccepted = vi.fn(async () => undefined);
    const validateDot = vi.fn(async () => undefined);
    const adapter = createSpaceAgentAdapter({ store, config: enabledConfig(), codexTurnStarter: starter, codexAgentControl: new FakeCodexAgentControl(),
      validateDot,
      dotTurnContext: async () => ({ toolGateway: true, developerContext: "You are Orbit.", conversationContext: input.context ?? null, onAccepted }),
      dotRuntime: async () => input.runtime ?? null,
      defaultDotId: async () => input.defaultDot ?? null });
    return { store, room, pane, starter, adapter, onAccepted, validateDot };
  }
  it("opens a pane's first conversation with the default Dot from Settings", async () => {
    const f = fixture({ defaultDot: nova });
    expect((await f.adapter.loadSession({ pane: f.pane })).dotId).toBe(nova);
    expect(f.validateDot).toHaveBeenCalledWith(f.pane, nova, undefined);
  });
  it("leaves later conversations of a pane on the pane's own choice", async () => {
    const f = fixture({ defaultDot: nova });
    // The pane already had a conversation without a Dot, from before Dots or from a pane that chose none.
    await f.store.createSpaceAgentSession({ paneId: f.pane.id, roomId: f.room.id, title: "Room Agent", selectedProviderId: null, selectedModelId: "chat-test",
      selectedModelConfigId: "chat-test:high", selectedProviderName: null, selectedModelName: "chat-test", selectedReasoningKey: "high", selectedToolIds: [],
      isActive: false });
    expect((await f.adapter.loadSession({ pane: f.pane })).dotId ?? null).toBeNull();
    // A new conversation in that pane (sessionId null) stays without a Dot.
    expect((await f.adapter.createOrRestoreSession({ pane: f.pane, sessionId: null })).dotId ?? null).toBeNull();
    expect(f.validateDot).not.toHaveBeenCalled();
  });
  it("runs a Dot with the model and permissions set in Settings, and ignores models Chat cannot serve", async () => {
    const chosen = "codex-v1|gpt-provider-verified|high";
    const f = fixture({ runtime: { modelConfigId: chosen, permissionMode: "approve_for_me" } });
    await f.adapter.createOrRestoreSession({ pane: f.pane, dotId: orbit });
    await f.adapter.sendMessage({ pane: f.pane, content: "Hello", operatorUserId: "user:owner", clientRequestId: "request:runtime-1", traceId: "trace:runtime-1" });
    expect(f.starter.started[0]).toMatchObject({ reasoningEffort: "high", permissionMode: "approve_for_me" });
    const missing = fixture({ runtime: { modelConfigId: "codex-v1|retired-model|high", permissionMode: null } });
    const session = await missing.adapter.createOrRestoreSession({ pane: missing.pane, dotId: orbit });
    expect(session.selectedModelConfigId).not.toBe("codex-v1|retired-model|high");
    await missing.adapter.sendMessage({ pane: missing.pane, content: "Hello", operatorUserId: "user:owner", clientRequestId: "request:runtime-2", traceId: "trace:runtime-2" });
    expect(missing.starter.started[0]).toMatchObject({ permissionMode: "full_access" });
  });
  it("gives the turn what was said in the Dot's other conversations without storing it as the user's message", async () => {
    const f = fixture({ context: "Context from Space, not written by the user in this message:\n- Notice: new sign-in" });
    const session = await f.adapter.createOrRestoreSession({ pane: f.pane, dotId: orbit });
    await f.adapter.sendMessage({ pane: f.pane, content: "Yes, it was me", operatorUserId: "user:owner", clientRequestId: "request:context-1", traceId: "trace:context-1" });
    expect(f.starter.started[0]!.prompt).toMatch(/Notice: new sign-in[\s\S]*User prompt:\nYes, it was me$/);
    expect(f.onAccepted).toHaveBeenCalledTimes(1);
    const messages = await f.store.listSpaceAgentMessages(session.binding.sessionId!);
    expect(messages.find((message) => message.role === "user")?.content).toBe("Yes, it was me");
  });
  it("keeps the conversation context and unread notices for turns the user started", async () => {
    const f = fixture({ context: "Context from Space, not written by the user in this message:\n- Notice: new sign-in" });
    await f.adapter.createOrRestoreSession({ pane: f.pane, dotId: orbit });
    await f.adapter.sendMessage({ pane: f.pane, content: "Goal step 1 of at most 20.", operatorUserId: "user:owner",
      clientRequestId: "goal-step-1", traceId: "trace:goal-1" });
    // A Goal step, reminder or approval does not read the notices: the user has not seen the Dot answer them yet.
    expect(f.starter.started[0]!.prompt).not.toContain("Notice: new sign-in");
    expect(f.onAccepted).not.toHaveBeenCalled();
  });
});
