import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CliHostAttachInput, CliHostEventListener, CliHostSessionSummary } from "@space/cli-host";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { ownedSystemAnalytics } from "./owned-system-analytics.js";

const sessionSecret = "terminal-control-test-secret";
const csrfHeaderName = "x-space-csrf-token";
const cliControlLeaseHeaderName = "x-space-cli-control-lease-id";
const cliBrowserClientHeaderName = "x-space-cli-browser-client-id";
const cliTabLineageHeaderName = "x-space-cli-tab-lineage-id";
const cliPageClientHeaderName = "x-space-cli-page-client-id";
const browserClientId = "11111111-1111-4111-8111-111111111111";
const firstTabLineageId = "22222222-2222-4222-8222-222222222222";
const firstPageClientId = "33333333-3333-4333-8333-333333333333";
const secondTabLineageId = "44444444-4444-4444-8444-444444444444";
const secondPageClientId = "55555555-5555-4555-8555-555555555555";

interface TerminalFrame {
  type: string;
  code?: string;
  leaseId?: string;
  controlState?: string;
  reason?: string;
  [key: string]: unknown;
}

function authFor(userId: string, proofScope?: "READ_ONLY") {
  const token = signSession(
    {
      id: userId,
      email: `${userId.replace(/[^a-z0-9]/gi, "-")}@space.test`,
      role: "OPERATOR",
      ...(proofScope ? { proofScope } : {})
    },
    sessionSecret
  );
  const csrfToken = createCsrfToken(token, sessionSecret);
  if (!csrfToken) throw new Error("Failed to create test CSRF token.");
  return { cookie: `space_session=${token}`, csrfToken };
}

function httpControlHeaders(
  leaseId: string,
  identity: { tabLineageId: string; pageClientId: string }
) {
  return {
    [cliControlLeaseHeaderName]: leaseId,
    [cliBrowserClientHeaderName]: browserClientId,
    [cliTabLineageHeaderName]: identity.tabLineageId,
    [cliPageClientHeaderName]: identity.pageClientId
  };
}

function deferred() {
  let resolve = () => undefined;
  let reject = (_error: Error) => undefined;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function waitForFrame(
  frames: TerminalFrame[],
  predicate: (frame: TerminalFrame) => boolean,
  timeoutMs = 1_000
): Promise<TerminalFrame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = frames.find(predicate);
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for terminal frame. Observed: ${JSON.stringify(frames)}`);
}

async function createHarness() {
  const commandDir = await mkdtemp(join(tmpdir(), "space-cli-control-command-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "space-cli-control-workspace-"));
  const commandPath = join(commandDir, "codex-vscode-parity");
  await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(commandPath, 0o755);

  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "CLI terminal control", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", cwd: "/etc" });
  const input = vi.fn(async () => ({ accepted: true, acceptedAtMs: Date.now() }));
  const resize = vi.fn(async () => undefined);
  const terminate = vi.fn(async () => true);
  const detach = vi.fn(async () => true);
  let runningSession: CliHostSessionSummary | null = null;
  let hostListener: CliHostEventListener | undefined;
  let outputSequence = 0;
  const inspect = vi.fn(async (identity: CliHostAttachInput["identity"]) =>
    runningSession?.cliSessionId === identity.cliSessionId ? runningSession : null
  );
  const attach = vi.fn(async (request: CliHostAttachInput, listener?: CliHostEventListener) => {
    hostListener = listener;
    runningSession = {
      ...request.identity,
      generationId: "00000000-0000-4000-8000-000000000043",
      pid: 4043,
      status: "RUNNING" as const,
      statusReason: "Running in the terminal-control test host.",
      exitCode: null,
      signal: null,
      nextOutputSequence: 0,
      attachmentCount: 1,
      startedAt: "2026-07-23T08:00:00.000Z",
      detachedAt: null,
      endedAt: null
    };
    return {
      attachmentId: `attachment:${request.identity.cliSessionId}`,
      session: runningSession,
      replay: []
    };
  });
  const host = {
    health: async () => ({
      hostPid: 4043,
      startedAt: "2026-07-23T08:00:00.000Z",
      buildCommit: null,
      sessions: []
    }),
    inspect,
    attach,
    input,
    resize,
    detach,
    terminate,
    close: async () => undefined
  };
  const codexDefaults = {
    build: { modelId: "gpt-5.6-sol", reasoningEffort: "medium" }
  } as const;
  const app = await createApp({
    store,
    config: getApiConfig({
      SPACE_CLI_ENABLED: "true",
      SPACE_CLI_COMMAND_PATH: commandDir,
      SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
      SPACE_CLI_WORKSPACE_ROOT: workspaceRoot
    }),
    auth: {
      sessionSecret,
      devLogin: true,
      secureCookies: false
    },
    codexCliModeDefaultsService: {
      build: async () => codexDefaults.build,
      read: async () => ({
        defaults: codexDefaults,
        catalog: {
          status: "AVAILABLE",
          models: [{
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["medium"],
            reasoningOptions: [{ reasoningEffort: "medium" }]
          }],
          error: null
        }
      }),
      update: vi.fn()
    },
    cliHostClient: host,
    // Background analytics must not scan the operator's CLI history; its
    // in-flight scan otherwise held app.close() for several seconds per test.
    systemAnalyticsService: ownedSystemAnalytics(store, workspaceRoot)
  });

  return {
    app,
    store,
    pane,
    host: {
      attach, input, resize, detach, terminate,
      emitOutput(data: string) {
        hostListener?.({
          type: "output",
          generationId: runningSession!.generationId,
          sequence: outputSequence++,
          stream: "stdout",
          data
        });
      }
    },
    cleanup: async () => {
      try {
        await app.close();
      } finally {
        await Promise.all([
          rm(commandDir, { recursive: true, force: true }),
          rm(workspaceRoot, { recursive: true, force: true })
        ]);
      }
    }
  };
}

async function issueSession(
  harness: Awaited<ReturnType<typeof createHarness>>,
  auth: ReturnType<typeof authFor>,
  method: "GET" | "POST" = "POST"
) {
  const response = await harness.app.inject({
    method,
    url: `/api/panes/${encodeURIComponent(harness.pane.id)}/cli/session`,
    headers: {
      cookie: auth.cookie,
      ...(method === "POST" ? { [csrfHeaderName]: auth.csrfToken } : {})
    },
    ...(method === "POST" ? { payload: { runtimeId: "cli:codex" } } : {})
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    session: { sessionId: string };
    websocket: { token: string } | null;
  };
  expect(body.websocket?.token).toBeTruthy();
  return body;
}

async function connect(
  harness: Awaited<ReturnType<typeof createHarness>>,
  session: Awaited<ReturnType<typeof issueSession>>,
  auth: ReturnType<typeof authFor>,
  identity: {
    tabLineageId: string;
    pageClientId: string;
    clientMode?: "INTERACTIVE" | "OBSERVER";
    leaseId?: string;
    initialCols?: number;
    initialRows?: number;
  }
) {
  const frames: TerminalFrame[] = [];
  let closeCode: number | null = null;
  const query = new URLSearchParams({
    sessionId: session.session.sessionId,
    token: session.websocket?.token ?? "",
    protocolVersion: "2",
    browserClientId,
    tabLineageId: identity.tabLineageId,
    pageClientId: identity.pageClientId,
    clientMode: identity.clientMode ?? "INTERACTIVE"
  });
  if (identity.leaseId) query.set("leaseId", identity.leaseId);
  if (identity.initialCols !== undefined) query.set("initialCols", String(identity.initialCols));
  if (identity.initialRows !== undefined) query.set("initialRows", String(identity.initialRows));
  const socket = await harness.app.injectWS(
    `/api/panes/${encodeURIComponent(harness.pane.id)}/cli/terminal?${query.toString()}`,
    { headers: { cookie: auth.cookie } },
    {
      onInit(ws) {
        ws.on("message", (raw) => {
          frames.push(JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)) as TerminalFrame);
        });
        ws.on("close", (code) => {
          closeCode = code;
        });
      }
    }
  );
  return { socket, frames, closeCode: () => closeCode };
}

describe("CLI terminal protocol-v2 control", () => {
  it("delivers ordinary input in order while transcript persistence is delayed", async () => {
    const harness = await createHarness();
    const auth = authFor("user:delayed-input-persistence");
    let releasePersistence = () => undefined;
    const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve; });
    try {
      const session = await issueSession(harness, auth);
      const controller = await connect(harness, session, auth, {
        tabLineageId: firstTabLineageId,
        pageClientId: firstPageClientId
      });
      const ready = await waitForFrame(controller.frames, (frame) => frame.type === "ready");
      const nextSequence = harness.store.listPaneCliTranscriptChunks(session.session.sessionId).at(-1)!.sequence + 1;
      const append = harness.store.appendPaneCliTranscriptChunk.bind(harness.store);
      const persist = vi.spyOn(harness.store, "appendPaneCliTranscriptChunk")
        .mockImplementation((...args) => persistenceGate.then(() => append(...args)) as never);

      for (const data of ["a", "b", "c"]) {
        controller.socket.send(JSON.stringify({ type: "input", data, leaseId: ready.leaseId }));
        if (data === "a") {
          controller.socket.send(JSON.stringify({ type: "input", data: "unauthorized", leaseId: "cli_terminal_lease:stale" }));
        }
      }
      controller.socket.send(JSON.stringify({ type: "ping" }));
      await waitForFrame(controller.frames, (frame) => frame.type === "pong");

      expect(harness.host.input.mock.calls.map((call) => (call as unknown[])[2])).toEqual(["a", "b", "c"]);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(controller.frames).toContainEqual(expect.objectContaining({ type: "control_denied", code: "CLI_CONTROL_REQUIRED" }));
      expect(harness.store.listPaneCliTranscriptChunks(session.session.sessionId).filter((chunk) => chunk.stream === "stdin")).toEqual([]);

      releasePersistence();
      await vi.waitFor(() => {
        const stdin = harness.store.listPaneCliTranscriptChunks(session.session.sessionId)
          .filter((chunk) => chunk.stream === "stdin");
        expect(stdin.map((chunk) => chunk.content)).toEqual(["a", "b", "c"]);
        expect(stdin.map((chunk) => chunk.sequence)).toEqual([nextSequence, nextSequence + 1, nextSequence + 2]);
      });
      controller.socket.terminate();
    } finally {
      releasePersistence();
      await harness.cleanup();
    }
  });

  it("keeps delayed host output and input transcripts in their accepted order", async () => {
    const harness = await createHarness();
    const auth = authFor("user:delayed-output-persistence");
    const gate = deferred();
    try {
      const session = await issueSession(harness, auth);
      const controller = await connect(harness, session, auth, {
        tabLineageId: firstTabLineageId, pageClientId: firstPageClientId
      });
      const ready = await waitForFrame(controller.frames, (frame) => frame.type === "ready");
      const append = harness.store.appendPaneCliHostOutputChunk.bind(harness.store);
      vi.spyOn(harness.store, "appendPaneCliHostOutputChunk")
        .mockImplementation((...args) => gate.promise.then(() => append(...args)) as never);
      harness.host.emitOutput("before-input");
      controller.socket.send(JSON.stringify({ type: "input", data: "a", leaseId: ready.leaseId }));
      controller.socket.send(JSON.stringify({ type: "ping" }));
      await waitForFrame(controller.frames, (frame) => frame.type === "pong");
      harness.host.emitOutput("between-inputs");
      controller.socket.send(JSON.stringify({ type: "input", data: "b", leaseId: ready.leaseId }));
      controller.socket.send(JSON.stringify({ type: "ping" }));
      await vi.waitFor(() => expect(controller.frames.filter((frame) => frame.type === "pong")).toHaveLength(2));
      expect(harness.host.input.mock.calls.map((call) => (call as unknown[])[2])).toEqual(["a", "b"]);

      gate.resolve();
      await vi.waitFor(() => {
        const transcript = harness.store.listPaneCliTranscriptChunks(session.session.sessionId)
          .filter((chunk) => chunk.stream === "stdout" || chunk.stream === "stdin");
        expect(transcript.map((chunk) => [chunk.stream, chunk.content])).toEqual([
          ["stdout", "before-input"], ["stdin", "a"], ["stdout", "between-inputs"], ["stdin", "b"]
        ]);
        expect(new Set(transcript.map((chunk) => chunk.sequence)).size).toBe(transcript.length);
      });
      controller.socket.terminate();
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });

  it.each(["submit", "interrupt"])("waits for earlier input persistence before %s", async (kind) => {
    const harness = await createHarness();
    const auth = authFor(`user:input-${kind}-barrier`);
    const gate = deferred();
    try {
      const session = await issueSession(harness, auth);
      const controller = await connect(harness, session, auth, {
        tabLineageId: firstTabLineageId, pageClientId: firstPageClientId
      });
      const ready = await waitForFrame(controller.frames, (frame) => frame.type === "ready");
      const append = harness.store.appendPaneCliTranscriptChunk.bind(harness.store);
      vi.spyOn(harness.store, "appendPaneCliTranscriptChunk")
        .mockImplementation((...args) => gate.promise.then(() => append(...args)) as never);
      controller.socket.send(JSON.stringify({ type: "input", data: "draft", leaseId: ready.leaseId }));
      controller.socket.send(JSON.stringify({ type: "ping" }));
      await waitForFrame(controller.frames, (frame) => frame.type === "pong");
      const authorityRead = vi.spyOn(harness.store, "getActivePaneCliTerminalControlLease");
      const deliveredAfterPersistence: string[][] = [];
      const readPersistedInput = () => harness.store.listPaneCliTranscriptChunks(session.session.sessionId)
        .filter((chunk) => chunk.stream === "stdin").map((chunk) => chunk.content);
      if (kind === "submit") {
        harness.host.input.mockImplementationOnce(async () => {
          deliveredAfterPersistence.push(readPersistedInput());
          return { accepted: true, acceptedAtMs: Date.now() };
        });
      } else {
        harness.host.terminate.mockImplementationOnce(async () => {
          deliveredAfterPersistence.push(readPersistedInput());
          return true;
        });
      }
      controller.socket.send(JSON.stringify({
        ...(kind === "submit" ? { type: "input", data: "\r" } : { type: "interrupt" }),
        leaseId: ready.leaseId
      }));
      await vi.waitFor(() => expect(authorityRead).toHaveBeenCalled());
      expect(harness.host.input).toHaveBeenCalledTimes(1);
      expect(harness.host.terminate).not.toHaveBeenCalled();

      gate.resolve();
      await vi.waitFor(() => expect(deliveredAfterPersistence).toEqual([["draft"]]));
      controller.socket.terminate();
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });

  it.each([
    { limit: "frames", data: Array.from({ length: 65 }, () => "x"), accepted: 64, authorized: 65 },
    { limit: "bytes", data: ["🔥".repeat(8 * 1024), "b".repeat(32 * 1024), "c"], accepted: 2, authorized: 3 },
    { limit: "synchronously persisting oversized pastes", data: ["a".repeat(64 * 1024 + 1), "b"], accepted: 1, authorized: 1 }
  ])("bounds input waiting for persistence by $limit", async ({ data, accepted, authorized }) => {
    const harness = await createHarness();
    const auth = authFor("user:input-backpressure");
    const gate = deferred();
    try {
      const session = await issueSession(harness, auth);
      const controller = await connect(harness, session, auth, {
        tabLineageId: firstTabLineageId, pageClientId: firstPageClientId
      });
      const ready = await waitForFrame(controller.frames, (frame) => frame.type === "ready");
      const append = harness.store.appendPaneCliTranscriptChunk.bind(harness.store);
      vi.spyOn(harness.store, "appendPaneCliTranscriptChunk")
        .mockImplementation((...args) => gate.promise.then(() => append(...args)) as never);
      const authorityRead = vi.spyOn(harness.store, "getActivePaneCliTerminalControlLease");
      for (const value of data) {
        controller.socket.send(JSON.stringify({ type: "input", data: value, leaseId: ready.leaseId }));
      }
      controller.socket.send(JSON.stringify({ type: "ping" }));
      await vi.waitFor(() => expect(authorityRead).toHaveBeenCalledTimes(authorized));
      expect(harness.host.input).toHaveBeenCalledTimes(accepted);
      expect(controller.frames.some((frame) => frame.type === "pong")).toBe(false);

      gate.resolve();
      await waitForFrame(controller.frames, (frame) => frame.type === "pong");
      expect(harness.host.input.mock.calls.map((call) => (call as unknown[])[2])).toEqual(data);
      await vi.waitFor(() => expect(harness.store.listPaneCliTranscriptChunks(session.session.sessionId)
        .filter((chunk) => chunk.stream === "stdin").map((chunk) => chunk.content).join("")).toBe(data.join("")));
      controller.socket.terminate();
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });

  it("finishes deferred input persistence before detaching and restoring a transcript sequence", async () => {
    const harness = await createHarness();
    const auth = authFor("user:input-detach-barrier");
    const gate = deferred();
    try {
      const session = await issueSession(harness, auth);
      const controller = await connect(harness, session, auth, {
        tabLineageId: firstTabLineageId, pageClientId: firstPageClientId
      });
      const ready = await waitForFrame(controller.frames, (frame) => frame.type === "ready");
      const append = harness.store.appendPaneCliTranscriptChunk.bind(harness.store);
      vi.spyOn(harness.store, "appendPaneCliTranscriptChunk")
        .mockImplementation((...args) => gate.promise.then(() => append(...args)) as never);
      controller.socket.send(JSON.stringify({ type: "input", data: "before-refresh", leaseId: ready.leaseId }));
      controller.socket.send(JSON.stringify({ type: "ping" }));
      await waitForFrame(controller.frames, (frame) => frame.type === "pong");
      controller.socket.terminate();
      await vi.waitFor(() => expect(harness.app.websocketServer.clients.size).toBe(0));
      expect(harness.host.detach).not.toHaveBeenCalled();

      gate.resolve();
      await vi.waitFor(() => expect(harness.host.detach).toHaveBeenCalledTimes(1));
      const reconnectSession = await issueSession(harness, auth, "GET");
      const reconnected = await connect(harness, reconnectSession, auth, {
        tabLineageId: firstTabLineageId, pageClientId: firstPageClientId, leaseId: ready.leaseId
      });
      const reconnectReady = await waitForFrame(reconnected.frames, (frame) => frame.type === "ready");
      expect(reconnectReady.controlState).toBe("CONTROLLER");
      reconnected.socket.send(JSON.stringify({ type: "input", data: "after-refresh", leaseId: reconnectReady.leaseId }));
      reconnected.socket.send(JSON.stringify({ type: "ping" }));
      await waitForFrame(reconnected.frames, (frame) => frame.type === "pong");
      expect(reconnected.frames.filter((frame) => frame.type === "error")).toEqual([]);
      await vi.waitFor(() => {
        const stdin = harness.store.listPaneCliTranscriptChunks(session.session.sessionId)
          .filter((chunk) => chunk.stream === "stdin");
        expect(stdin.map((chunk) => chunk.content)).toEqual(["before-refresh", "after-refresh"]);
        expect(new Set(stdin.map((chunk) => chunk.sequence)).size).toBe(2);
      });
      reconnected.socket.terminate();
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });

  it("closes a failed persistence writer without leaking storage errors or delivering its queued input", async () => {
    const harness = await createHarness();
    const auth = authFor("user:input-persistence-failure");
    const gate = deferred();
    try {
      const session = await issueSession(harness, auth);
      const controller = await connect(harness, session, auth, {
        tabLineageId: firstTabLineageId, pageClientId: firstPageClientId
      });
      const ready = await waitForFrame(controller.frames, (frame) => frame.type === "ready");
      vi.spyOn(harness.store, "appendPaneCliTranscriptChunk")
        .mockImplementationOnce(() => gate.promise as never);
      for (let index = 0; index < 65; index += 1) {
        controller.socket.send(JSON.stringify({ type: "input", data: "x", leaseId: ready.leaseId }));
      }
      await vi.waitFor(() => expect(harness.host.input).toHaveBeenCalledTimes(64));
      gate.reject(new Error("storage failed; token=synthetic-private-storage-value"));
      const error = await waitForFrame(controller.frames, (frame) => frame.type === "error");
      expect(error.message).toBe("CLI terminal input could not be saved. Reconnect before sending more input.");
      expect(JSON.stringify(controller.frames)).not.toContain("synthetic-private-storage-value");
      await vi.waitFor(() => expect(controller.closeCode()).toBe(1008));
      expect(harness.host.input).toHaveBeenCalledTimes(64);
      // injectWS leaves the server's synthetic stream in CLOSING after the
      // client has received the close frame; finish that fixture transport.
      for (const socket of harness.app.websocketServer.clients) socket.terminate();
      await vi.waitFor(() => expect(harness.host.detach).toHaveBeenCalledTimes(1));
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });

  it("keeps hidden input out of deferred transcripts and redacts visible secrets", async () => {
    const harness = await createHarness();
    const auth = authFor("user:input-persistence-redaction");
    const gate = deferred();
    try {
      const session = await issueSession(harness, auth);
      const controller = await connect(harness, session, auth, {
        tabLineageId: firstTabLineageId, pageClientId: firstPageClientId
      });
      const ready = await waitForFrame(controller.frames, (frame) => frame.type === "ready");
      const append = harness.store.appendPaneCliTranscriptChunk.bind(harness.store);
      vi.spyOn(harness.store, "appendPaneCliTranscriptChunk")
        .mockImplementation((...args) => gate.promise.then(() => append(...args)) as never);
      controller.socket.send(JSON.stringify({ type: "input", data: "token=synthetic-visible-value", leaseId: ready.leaseId }));
      controller.socket.send(JSON.stringify({ type: "input", data: "synthetic-hidden-value", display: "hidden", leaseId: ready.leaseId }));
      controller.socket.send(JSON.stringify({ type: "ping" }));
      await waitForFrame(controller.frames, (frame) => frame.type === "pong");
      expect(harness.host.input).toHaveBeenCalledTimes(2);
      gate.resolve();
      await vi.waitFor(() => {
        const stdin = harness.store.listPaneCliTranscriptChunks(session.session.sessionId).filter((chunk) => chunk.stream === "stdin");
        expect(stdin.map((chunk) => chunk.content)).toEqual(["token:[REDACTED]"]);
        expect(JSON.stringify(stdin)).not.toContain("synthetic-");
      });
      controller.socket.terminate();
    } finally {
      gate.resolve();
      await harness.cleanup();
    }
  });

  it("strips NUL bytes before writing Codex terminal input or persisting its transcript", async () => {
    const harness = await createHarness();
    const auth = authFor("user:nul-input");
    try {
      const session = await issueSession(harness, auth);
      const controller = await connect(harness, session, auth, {
        tabLineageId: firstTabLineageId,
        pageClientId: firstPageClientId
      });
      const ready = await waitForFrame(controller.frames, (frame) => frame.type === "ready");

      controller.socket.send(JSON.stringify({
        type: "input",
        data: "before\0after",
        leaseId: ready.leaseId
      }));

      await vi.waitFor(() =>
        expect(harness.host.input).toHaveBeenCalledWith(
          expect.objectContaining({ cliSessionId: session.session.sessionId }),
          `attachment:${session.session.sessionId}`,
          "beforeafter",
          "visible"
        )
      );
      await vi.waitFor(() => {
        const stdin = harness.store
          .listPaneCliTranscriptChunks(session.session.sessionId)
          .filter((chunk) => chunk.stream === "stdin");
        expect(stdin.map((chunk) => chunk.content).join("")).toBe("beforeafter");
        expect(stdin.some((chunk) => chunk.content.includes("\0"))).toBe(false);
      });
      expect(controller.closeCode()).toBeNull();
      controller.socket.terminate();
    } finally {
      await harness.cleanup();
    }
  });

  it("uses paired initial geometry only for the fresh PTY spawn", async () => {
    const harness = await createHarness();
    const auth = authFor("user:initial-geometry");
    try {
      const firstSession = await issueSession(harness, auth);
      const first = await connect(harness, firstSession, auth, {
        tabLineageId: firstTabLineageId,
        pageClientId: firstPageClientId,
        initialCols: 132,
        initialRows: 41
      });
      await waitForFrame(first.frames, (frame) => frame.type === "ready");

      expect(harness.host.attach).toHaveBeenCalledTimes(1);
      expect(harness.host.attach.mock.calls[0]?.[0].spawn).toMatchObject({
        cols: 132,
        rows: 41
      });

      const reconnectSession = await issueSession(harness, auth, "GET");
      const reconnect = await connect(harness, reconnectSession, auth, {
        tabLineageId: secondTabLineageId,
        pageClientId: secondPageClientId,
        initialCols: 80,
        initialRows: 24
      });
      await waitForFrame(reconnect.frames, (frame) => frame.type === "ready");

      expect(harness.host.attach).toHaveBeenCalledTimes(1);
      first.socket.terminate();
      reconnect.socket.terminate();
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects unpaired or out-of-range initial geometry before host attach", async () => {
    const harness = await createHarness();
    const auth = authFor("user:invalid-initial-geometry");
    try {
      const session = await issueSession(harness, auth);
      const unpaired = await connect(harness, session, auth, {
        tabLineageId: firstTabLineageId,
        pageClientId: firstPageClientId,
        initialCols: 120
      });
      await expect(waitForFrame(
        unpaired.frames,
        (frame) => frame.type === "error"
      )).resolves.toMatchObject({
        code: "CLI_TERMINAL_SETUP_FAILED"
      });
      expect(harness.host.attach).not.toHaveBeenCalled();
      unpaired.socket.terminate();

      const outOfRange = await connect(harness, session, auth, {
        tabLineageId: secondTabLineageId,
        pageClientId: secondPageClientId,
        initialCols: 401,
        initialRows: 24
      });
      await expect(waitForFrame(
        outOfRange.frames,
        (frame) => frame.type === "error"
      )).resolves.toMatchObject({
        code: "CLI_TERMINAL_SETUP_FAILED"
      });
      expect(harness.host.attach).not.toHaveBeenCalled();
      outOfRange.socket.terminate();
    } finally {
      await harness.cleanup();
    }
  });

  it("reissues terminal access for an active same-runtime session without stealing HTTP control", async () => {
    const harness = await createHarness();
    const auth = authFor("user:idempotent-session-join");
    try {
      const session = await issueSession(harness, auth);
      const controller = await connect(harness, session, auth, {
        tabLineageId: firstTabLineageId,
        pageClientId: firstPageClientId
      });
      await waitForFrame(controller.frames, (frame) => frame.type === "ready");

      const joined = await harness.app.inject({
        method: "POST",
        url: `/api/panes/${encodeURIComponent(harness.pane.id)}/cli/session`,
        headers: {
          cookie: auth.cookie,
          [csrfHeaderName]: auth.csrfToken
        },
        payload: { runtimeId: "cli:codex" }
      });
      expect(joined.statusCode).toBe(200);
      expect(joined.json()).toMatchObject({
        session: { sessionId: session.session.sessionId },
        websocket: { token: expect.any(String) }
      });
      expect(joined.json().websocket.token).not.toBe(session.websocket?.token);

      const restart = await harness.app.inject({
        method: "POST",
        url: `/api/panes/${encodeURIComponent(harness.pane.id)}/cli/session`,
        headers: {
          cookie: auth.cookie,
          [csrfHeaderName]: auth.csrfToken
        },
        payload: { runtimeId: "cli:codex", forceRestart: true }
      });
      expect(restart.statusCode).toBe(409);
      expect(restart.json()).toMatchObject({
        error: { code: "CLI_CONTROL_REQUIRED" }
      });
      expect(harness.host.terminate).not.toHaveBeenCalled();
      controller.socket.terminate();
    } finally {
      await harness.cleanup();
    }
  });

  it("fences HTTP mutations to the current page lease while preserving first-session compatibility", async () => {
    const harness = await createHarness();
    const auth = authFor("user:http-controller");
    try {
      const session = await issueSession(harness, auth);
      const controller = await connect(harness, session, auth, {
        tabLineageId: firstTabLineageId,
        pageClientId: firstPageClientId
      });
      const ready = await waitForFrame(controller.frames, (frame) => frame.type === "ready");
      expect(ready.leaseId).toEqual(expect.any(String));

      const mutationRequests = [
        {
          method: "PATCH" as const,
          url: `/api/panes/${encodeURIComponent(harness.pane.id)}/cli/model-settings`,
          payload: {
            expectedSessionId: session.session.sessionId,
            modelId: "gpt-5",
            reasoningEffort: "medium"
          }
        },
        {
          method: "POST" as const,
          url: `/api/panes/${encodeURIComponent(harness.pane.id)}/cli/uploads?source=USER_UPLOAD`
        },
        {
          method: "POST" as const,
          url: `/api/panes/${encodeURIComponent(harness.pane.id)}/cli/resume`,
          payload: { taskId: "cli_task:missing-for-control-proof" }
        },
        {
          method: "POST" as const,
          url: `/api/panes/${encodeURIComponent(harness.pane.id)}/cli/session`,
          payload: { runtimeId: "cli:codex", forceRestart: true }
        },
        {
          method: "POST" as const,
          url: `/api/panes/${encodeURIComponent(harness.pane.id)}/cli/interrupt`,
          payload: { reason: "HTTP control proof" }
        }
      ];

      for (const mutation of mutationRequests) {
        const response = await harness.app.inject({
          ...mutation,
          headers: {
            cookie: auth.cookie,
            [csrfHeaderName]: auth.csrfToken
          }
        });
        expect(response.statusCode, mutation.url).toBe(409);
        expect(response.json()).toMatchObject({
          error: { code: "CLI_CONTROL_REQUIRED" }
        });
      }

      const wrongPage = await harness.app.inject({
        method: "POST",
        url: `/api/panes/${encodeURIComponent(harness.pane.id)}/cli/interrupt`,
        headers: {
          cookie: auth.cookie,
          [csrfHeaderName]: auth.csrfToken,
          ...httpControlHeaders(ready.leaseId!, {
            tabLineageId: secondTabLineageId,
            pageClientId: secondPageClientId
          })
        },
        payload: { reason: "Stale page must not interrupt" }
      });
      expect(wrongPage.statusCode).toBe(409);
      expect(wrongPage.json()).toMatchObject({
        error: { code: "CLI_CONTROL_REQUIRED" }
      });
      expect(harness.host.terminate).not.toHaveBeenCalled();

      const accepted = await harness.app.inject({
        method: "POST",
        url: `/api/panes/${encodeURIComponent(harness.pane.id)}/cli/interrupt`,
        headers: {
          cookie: auth.cookie,
          [csrfHeaderName]: auth.csrfToken,
          ...httpControlHeaders(ready.leaseId!, {
            tabLineageId: firstTabLineageId,
            pageClientId: firstPageClientId
          })
        },
        payload: { reason: "Current page may interrupt" }
      });
      expect(accepted.statusCode).toBe(200);
      expect(harness.host.terminate).toHaveBeenCalledTimes(1);
      controller.socket.terminate();
    } finally {
      await harness.cleanup();
    }
  });

  it("transfers authority to the latest active page while both tabs remain connected", async () => {
    const harness = await createHarness();
    const auth = authFor("user:controller");
    try {
      const firstSession = await issueSession(harness, auth);
      const first = await connect(harness, firstSession, auth, {
        tabLineageId: firstTabLineageId,
        pageClientId: firstPageClientId
      });
      const firstReady = await waitForFrame(first.frames, (frame) => frame.type === "ready");
      expect(firstReady).toMatchObject({
        protocolVersion: 2,
        clientMode: "INTERACTIVE",
        controlState: "CONTROLLER",
        leaseId: expect.any(String)
      });

      const secondSession = await issueSession(harness, auth, "GET");
      const second = await connect(harness, secondSession, auth, {
        tabLineageId: secondTabLineageId,
        pageClientId: secondPageClientId
      });
      const secondReady = await waitForFrame(second.frames, (frame) => frame.type === "ready");
      expect(secondReady).toMatchObject({
        protocolVersion: 2,
        clientMode: "INTERACTIVE",
        controlState: "HELD_BY_OTHER"
      });

      second.socket.send(JSON.stringify({
        type: "control_takeover",
        expectedLeaseId: firstReady.leaseId
      }));
      await waitForFrame(second.frames, (frame) =>
        frame.type === "error" && frame.code === "BAD_MESSAGE"
      );

      second.socket.send(JSON.stringify({
        type: "control_takeover",
        expectedLeaseId: firstReady.leaseId,
        interactionId: "44444444-4444-4444-8444-444444444444"
      }));
      const granted = await waitForFrame(second.frames, (frame) => frame.type === "control_granted");
      await waitForFrame(first.frames, (frame) =>
        frame.type === "control_revoked" && frame.leaseId === firstReady.leaseId
      );
      expect(granted.leaseId).toEqual(expect.any(String));
      expect(granted.leaseId).not.toBe(firstReady.leaseId);

      first.socket.send(JSON.stringify({
        type: "input",
        data: "stale\n",
        leaseId: firstReady.leaseId
      }));
      await waitForFrame(first.frames, (frame) =>
        frame.type === "control_denied" && frame.code === "CLI_CONTROL_REQUIRED"
      );
      expect(harness.host.input).not.toHaveBeenCalled();

      second.socket.send(JSON.stringify({
        type: "input",
        data: "accepted\n",
        leaseId: granted.leaseId
      }));
      await vi.waitFor(() => expect(harness.host.input).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(first.closeCode()).toBeNull();
      expect(second.closeCode()).toBeNull();
      first.socket.terminate();
      second.socket.terminate();
      await vi.waitFor(async () => {
        const metrics = await harness.app.inject({ method: "GET", url: "/metrics" });
        const cliMetricLines = metrics.body
          .split("\n")
          .filter((line) => line.startsWith("space_cli_terminal_events_total{"));
        const cliMetrics = cliMetricLines.join("\n");
        expect(cliMetrics).toContain(
          'source="SERVER",event="SOCKET_ATTACHED",outcome="SUCCESS",reason="INITIAL_ATTACH"} 1'
        );
        expect(cliMetrics).toContain(
          'source="SERVER",event="CONTROL_ACQUIRED",outcome="SUCCESS",reason="CONTROL_ACQUIRED"} 1'
        );
        expect(cliMetrics).toContain(
          'source="SERVER",event="CONTROL_TAKEN_OVER",outcome="SUCCESS",reason="TAKEN_OVER"} 1'
        );
        expect(cliMetrics).toContain(
          'source="SERVER",event="CONTROL_DENIED",outcome="DENIED",reason="CONTROL_REQUIRED"} 1'
        );
        expect(cliMetrics).toContain(
          'source="SERVER",event="SOCKET_DETACHED",outcome="INFO",reason="CLIENT_DETACH"} 2'
        );
        expect(cliMetrics).toContain(
          'source="SERVER",event="RECONNECT_GRACE_STARTED",outcome="INFO",reason="RECONNECT_GRACE"} 1'
        );
        expect(cliMetrics).not.toContain(firstReady.leaseId);
        expect(cliMetrics).not.toContain(firstPageClientId);
        expect(cliMetrics).not.toContain(firstSession.session.sessionId);
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps explicit observers connected and fences all terminal mutations", async () => {
    const harness = await createHarness();
    const auth = authFor("user:observer");
    try {
      const session = await issueSession(harness, auth);
      const observer = await connect(harness, session, auth, {
        tabLineageId: firstTabLineageId,
        pageClientId: firstPageClientId,
        clientMode: "OBSERVER"
      });
      await expect(waitForFrame(observer.frames, (frame) => frame.type === "ready")).resolves.toMatchObject({
        protocolVersion: 2,
        clientMode: "OBSERVER",
        controlState: "OBSERVER"
      });

      observer.socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
      await waitForFrame(observer.frames, (frame) =>
        frame.type === "control_denied" && frame.code === "CLI_CONTROL_REQUIRED"
      );
      expect(harness.host.resize).not.toHaveBeenCalled();
      expect(observer.closeCode()).toBeNull();
      observer.socket.terminate();
    } finally {
      await harness.cleanup();
    }
  });

  it("upgrades a writable observer in place before granting page-scoped control", async () => {
    const harness = await createHarness();
    const auth = authFor("user:observer-upgrade");
    try {
      const session = await issueSession(harness, auth);
      const observer = await connect(harness, session, auth, {
        tabLineageId: firstTabLineageId,
        pageClientId: firstPageClientId,
        clientMode: "OBSERVER"
      });
      await waitForFrame(observer.frames, (frame) =>
        frame.type === "ready" && frame.controlState === "OBSERVER"
      );

      observer.socket.send(JSON.stringify({ type: "control_upgrade" }));
      await waitForFrame(observer.frames, (frame) => frame.type === "control_upgraded");
      observer.socket.send(JSON.stringify({ type: "control_request" }));
      const granted = await waitForFrame(observer.frames, (frame) => frame.type === "control_granted");

      observer.socket.send(JSON.stringify({
        type: "resize",
        cols: 120,
        rows: 40,
        leaseId: granted.leaseId
      }));
      await vi.waitFor(() => expect(harness.host.resize).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        120,
        40
      ));
      await vi.waitFor(() => expect(harness.store.getPaneCliSession(session.session.sessionId)?.terminalGeometry).toEqual({
        generationId: "00000000-0000-4000-8000-000000000043", cols: 120, rows: 40
      }));
      expect(observer.closeCode()).toBeNull();
      observer.socket.terminate();
    } finally {
      await harness.cleanup();
    }
  });

  it("forces signed READ_ONLY proof sessions to remain observers", async () => {
    const harness = await createHarness();
    const writableAuth = authFor("user:proof-observer");
    const readOnlyAuth = authFor("user:proof-observer", "READ_ONLY");
    try {
      const session = await issueSession(harness, writableAuth);
      const controller = await connect(harness, session, writableAuth, {
        tabLineageId: firstTabLineageId,
        pageClientId: firstPageClientId
      });
      await waitForFrame(controller.frames, (frame) => frame.type === "ready");

      const observerSession = await issueSession(harness, readOnlyAuth, "GET");
      expect(observerSession.session.sessionId).toBe(session.session.sessionId);
      const observer = await connect(harness, observerSession, readOnlyAuth, {
        tabLineageId: secondTabLineageId,
        pageClientId: secondPageClientId
      });
      await expect(waitForFrame(observer.frames, (frame) => frame.type === "ready")).resolves.toMatchObject({
        protocolVersion: 2,
        clientMode: "OBSERVER",
        controlState: "OBSERVER"
      });

      observer.socket.send(JSON.stringify({ type: "control_upgrade" }));
      await waitForFrame(observer.frames, (frame) =>
        frame.type === "control_denied" && frame.code === "CLI_OBSERVER_MUTATION_DENIED"
      );
      observer.socket.send(JSON.stringify({ type: "interrupt" }));
      await waitForFrame(observer.frames, (frame) =>
        frame.type === "control_denied" && frame.code === "CLI_CONTROL_REQUIRED"
      );
      expect(harness.host.terminate).not.toHaveBeenCalled();
      expect(observer.closeCode()).toBeNull();
      observer.socket.terminate();
      controller.socket.terminate();
    } finally {
      await harness.cleanup();
    }
  });

  it("cleans up the host attachment when initial control resolution fails", async () => {
    const harness = await createHarness();
    const auth = authFor("user:control-failure");
    const createLease = vi
      .spyOn(harness.store, "createPaneCliTerminalControlLease")
      .mockRejectedValueOnce(new Error("control store unavailable"));
    try {
      const session = await issueSession(harness, auth);
      const failed = await connect(harness, session, auth, {
        tabLineageId: firstTabLineageId,
        pageClientId: firstPageClientId
      });
      await waitForFrame(failed.frames, (frame) =>
        frame.type === "error" && frame.code === "CLI_TERMINAL_ATTACH_FAILED"
      );
      await vi.waitFor(() => expect(harness.host.detach).toHaveBeenCalledTimes(1));
      expect(createLease).toHaveBeenCalledTimes(1);
      failed.socket.terminate();
    } finally {
      await harness.cleanup();
    }
  });

  it("responds to client ping with pong frame to keep connection alive", async () => {
    const harness = await createHarness();
    const auth = authFor("user:ping-pong");
    try {
      const session = await issueSession(harness, auth);
      const controller = await connect(harness, session, auth, {
        tabLineageId: firstTabLineageId,
        pageClientId: firstPageClientId
      });
      await waitForFrame(controller.frames, (frame) => frame.type === "ready");
      controller.socket.send(JSON.stringify({ type: "ping" }));
      const pong = await waitForFrame(controller.frames, (frame) => frame.type === "pong");
      expect(pong).toEqual({ type: "pong" });
      controller.socket.terminate();
    } finally {
      await harness.cleanup();
    }
  });
});
