import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createCodexAppServerSocketControlService } from "../src/index.js";
import { startCodexAppServerSocketMultiplexer } from "../src/socket-multiplexer.js";

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

const cleanups: Array<() => Promise<void>> = [];
const unixSocketTestRoot = "/tmp";

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function listenSingleClientUpstream(socketPath: string) {
  let connectionCount = 0;
  const messages: RpcMessage[] = [];
  const server: Server = createServer();
  const websocketServer = new WebSocketServer({ server });
  const sockets = new Set<WebSocket>();
  websocketServer.on("connection", (socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (connectionCount > 1) {
      socket.close();
      return;
    }
    socket.on("message", (data, isBinary) => {
      if (isBinary) return socket.close();
      const message = JSON.parse(data.toString()) as RpcMessage;
      messages.push(message);
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ id: message.id, result: { userAgent: "codex-test" } }));
      } else if (message.method === "model/list") {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            data: [{
              model: "gpt-5.5",
              displayName: "GPT-5.5",
              isDefault: true,
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "xhigh" }]
            }],
            nextCursor: null
          }
        }));
      } else if (message.method === "collaborationMode/list") {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            data: [
              { name: "Default", mode: "default", model: "gpt-upstream-build", reasoning_effort: "medium" },
              { name: "Plan", mode: "plan", model: "gpt-upstream-plan", reasoning_effort: "high" }
            ]
          }
        }));
      } else if ((message.method === "thread/start" || message.method === "thread/fork") && message.params?.ephemeral === true) {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: `${message.method}:ephemeral`, ephemeral: true } } }));
      } else if (message.method === "thread/start") {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "thread:test" } } }));
      } else if (message.method === "thread/list") {
        socket.send(JSON.stringify({ id: message.id, result: { data: [{ id: "thread:picker" }], nextCursor: null } }));
      } else if (message.method === "thread/read") {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: message.params?.threadId } } }));
      } else if (message.method === "thread/resume" && message.params?.threadId === "thread:missing") {
        socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: "Unknown thread" } }));
      } else if (message.method === "thread/resume" || message.method === "thread/fork") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { thread: { id: String(message.params?.threadId ?? "thread:test") } }
        }));
      } else if (message.method === "turn/start") {
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: `turn:${message.id}` } } }));
      } else if (message.method === "thread/settings/update") {
        socket.send(JSON.stringify({
          id: message.id,
          result: {}
        }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    messages,
    connectionCount: () => connectionCount,
    connectedClientCount: () => sockets.size,
    notify(message: RpcMessage) {
      const socket = [...sockets][0];
      if (!socket) throw new Error("Upstream is not connected.");
      socket.send(JSON.stringify(message));
    }
  };
}

function connectWebSocket(socketPath: string): WebSocket {
  return new WebSocket(`ws+unix://${socketPath}:/rpc`);
}

async function connectInitializedClient(socketPath: string, name: string): Promise<WebSocket> {
  const socket = connectWebSocket(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const initialized = new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as RpcMessage;
      if (message.id === 1 && message.result) resolve();
      if (message.id === 1 && message.error) reject(new Error("Primary initialize failed."));
    });
  });
  socket.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name } } }));
  await initialized;
  socket.send(JSON.stringify({ method: "initialized", params: {} }));
  return socket;
}

async function rpcRequest(
  socket: WebSocket,
  id: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<RpcMessage> {
  const response = new Promise<RpcMessage>((resolve, reject) => {
    const listener = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as RpcMessage;
      if (message.id !== id) return;
      socket.off("message", listener);
      if (message.error) reject(new Error(`RPC ${method} failed.`));
      else resolve(message);
    };
    socket.on("message", listener);
  });
  socket.send(JSON.stringify({ id, method, params }));
  return response;
}

async function writeDefaultsProjection(
  path: string,
  build: { modelId: string; reasoningEffort: string },
  plan: { modelId: string; reasoningEffort: string },
  updatedAt = new Date().toISOString()
): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    schemaVersion: "CodexCliModeDefaultsProjectionV1",
    revision: updatedAt,
    defaults: { build, plan, updatedAt }
  })}\n`, "utf8");
}

type ProjectionAwareMultiplexerOptions = Parameters<typeof startCodexAppServerSocketMultiplexer>[0] & {
  defaultsProjectionPath: string;
  projectionPollIntervalMs?: number;
};

type DiagnosticAwareMultiplexerOptions = Parameters<typeof startCodexAppServerSocketMultiplexer>[0] & {
  onDiagnostic: (event: Record<string, unknown>) => void;
};

describe("Codex App Server socket multiplexer", () => {
  it("reports the TUI restored thread without letting picker reads change its identity", async () => {
    const root = await mkdtemp(join(unixSocketTestRoot, "space-codex-current-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const upstreamPath = join(root, "upstream.sock");
    const listenPath = join(root, "app-server.sock");
    const upstream = await listenSingleClientUpstream(upstreamPath);
    const multiplexer = await startCodexAppServerSocketMultiplexer({ upstreamPath, listenPath });
    cleanups.push(() => multiplexer.close());
    const primary = await connectInitializedClient(listenPath, "codex-tui");
    cleanups.push(async () => primary.terminate());
    const control = createCodexAppServerSocketControlService({ socketPath: listenPath, timeoutMs: 1000 });
    expect(await control.readCurrentThreadId!()).toBeNull();
    await rpcRequest(primary, 2, "thread/start");
    expect(await control.readCurrentThreadId!()).toBe("thread:test");
    await rpcRequest(primary, 3, "thread/resume", { threadId: "thread:restored" });
    const picker = await connectInitializedClient(listenPath, "codex-tui-picker");
    cleanups.push(async () => picker.terminate());
    await rpcRequest(picker, 4, "thread/read", { threadId: "thread:old" });
    expect(await control.readCurrentThreadId!()).toBe("thread:restored");
    await expect(rpcRequest(primary, 5, "thread/resume", { threadId: "thread:missing" })).rejects.toThrow();
    expect(await control.readCurrentThreadId!()).toBe("thread:restored");
    await expect(control.updateThreadSettings({ threadId: "thread:restored", model: "gpt-5.5", reasoningEffort: "high", requireCurrentThread: true,
      beforeSend: async () => { await rpcRequest(primary, 6, "thread/resume", { threadId: "thread:newer" }); }
    })).rejects.toThrow();
    expect(upstream.messages.filter(message => message.method === "thread/settings/update")).toHaveLength(0);
    await control.updateThreadSettings({ threadId: "thread:newer", model: "gpt-5.5", reasoningEffort: "high", requireCurrentThread: true });
    expect(upstream.messages.find(message => message.method === "thread/settings/update")?.params).toEqual({
      threadId: "thread:newer", model: "gpt-5.5", effort: "high"
    });
  });

  it("keeps the TUI's task when the TUI opens an ephemeral side thread", async () => {
    const root = await mkdtemp(join(unixSocketTestRoot, "space-codex-ephemeral-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const upstreamPath = join(root, "upstream.sock");
    const listenPath = join(root, "app-server.sock");
    const upstream = await listenSingleClientUpstream(upstreamPath);
    const multiplexer = await startCodexAppServerSocketMultiplexer({ upstreamPath, listenPath });
    cleanups.push(() => multiplexer.close());
    const primary = await connectInitializedClient(listenPath, "codex-tui");
    cleanups.push(async () => primary.terminate());
    const control = createCodexAppServerSocketControlService({ socketPath: listenPath, timeoutMs: 1000 });
    await rpcRequest(primary, 2, "thread/start");
    await rpcRequest(primary, 3, "thread/start", { ephemeral: true });
    await rpcRequest(primary, 4, "thread/fork", { threadId: "thread:test", ephemeral: true });
    expect(await control.readCurrentThreadId!()).toBe("thread:test");
    for (const threadId of ["thread/start:ephemeral", "thread/fork:ephemeral"]) {
      await expect(control.updateThreadSettings({ threadId, model: "gpt-5.5", reasoningEffort: "high", requireCurrentThread: true })).rejects.toThrow();
    }
    expect(upstream.messages.filter(message => message.method === "thread/settings/update")).toHaveLength(0);
  });

  it("shares one single-client upstream between a persistent TUI and direct control clients", async () => {
    const root = await mkdtemp(join(unixSocketTestRoot, "space-codex-socket-mux-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const upstreamPath = join(root, "upstream.sock");
    const listenPath = join(root, "app-server.sock");
    const upstream = await listenSingleClientUpstream(upstreamPath);
    const multiplexer = await startCodexAppServerSocketMultiplexer({
      upstreamPath,
      listenPath,
      primaryReplacementTimeoutMs: 250
    });
    cleanups.push(() => multiplexer.close());

    const primary = await connectInitializedClient(listenPath, "codex-tui");
    cleanups.push(async () => primary.terminate());

    const picker = await connectInitializedClient(listenPath, "codex-tui-picker");
    await expect(rpcRequest(picker, 2, "thread/list", { cursor: null, limit: 100 })).resolves.toMatchObject({
      result: { data: [{ id: "thread:picker" }], nextCursor: null }
    });
    await expect(rpcRequest(picker, 3, "thread/read", { threadId: "thread:picker" })).resolves.toMatchObject({
      result: { thread: { id: "thread:picker" } }
    });
    const pickerClosed = new Promise<void>((resolve) => picker.once("close", () => resolve()));
    picker.close();
    await pickerClosed;
    expect(primary.readyState).toBe(WebSocket.OPEN);

    for (const [method, params] of [
      ["model/list", { includeHidden: false }],
      ["thread/settings/update", { threadId: "thread:picker", model: "gpt-5.5", effort: "high" }],
      ["turn/start", { threadId: "thread:picker", input: [] }]
    ] as const) {
      const restrictedPicker = await connectInitializedClient(listenPath, "codex-tui-picker");
      cleanups.push(async () => restrictedPicker.terminate());
      const restrictedPickerClosed = new Promise<boolean>((resolve) => restrictedPicker.once("close", () => resolve(true)));
      restrictedPicker.send(JSON.stringify({ id: 4, method, params }));
      await expect(Promise.race([
        restrictedPickerClosed,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
      ])).resolves.toBe(true);
      expect(upstream.messages.some((message) => message.method === method)).toBe(false);
      expect(primary.readyState).toBe(WebSocket.OPEN);
    }

    const reinitializingPicker = await connectInitializedClient(listenPath, "codex-tui-picker");
    cleanups.push(async () => reinitializingPicker.terminate());
    const reinitializingPickerClosed = new Promise<boolean>((resolve) => reinitializingPicker.once("close", () => resolve(true)));
    reinitializingPicker.send(JSON.stringify({
      id: 5,
      method: "initialize",
      params: { clientInfo: { name: "space" } }
    }));
    await expect(Promise.race([
      reinitializingPickerClosed,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
    ])).resolves.toBe(true);
    expect(primary.readyState).toBe(WebSocket.OPEN);

    const control = createCodexAppServerSocketControlService({ socketPath: listenPath, timeoutMs: 1_000 });
    await expect(control.listModels()).resolves.toEqual([
      expect.objectContaining({ id: "gpt-5.5", supportedReasoningEfforts: ["high", "xhigh"] })
    ]);
    await expect(control.updateThreadSettings({
      threadId: "thread:proof",
      model: "gpt-5.5",
      reasoningEffort: "xhigh"
    })).resolves.toBeUndefined();

    expect(upstream.connectionCount()).toBe(1);
    expect(upstream.messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/list",
      "thread/read",
      "model/list",
      "thread/settings/update"
    ]);

    const untrustedSecondary = await connectInitializedClient(listenPath, "untrusted-secondary");
    const closed = new Promise<boolean>((resolve) => untrustedSecondary.once("close", () => resolve(true)));
    untrustedSecondary.send(JSON.stringify({
      id: 9,
      method: "config/value/write",
      params: { key: "model", value: "untrusted" }
    }));
    await expect(Promise.race([
      closed,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
    ])).resolves.toBe(true);
    expect(upstream.messages.some((message) => message.method === "config/value/write")).toBe(false);
    expect(primary.readyState).toBe(WebSocket.OPEN);
    await expect(rpcRequest(primary, 10, "thread/start")).resolves.toMatchObject({
      result: { thread: { id: "thread:test" } }
    });

    const notifyingSecondary = await connectInitializedClient(listenPath, "notifying-secondary");
    const notificationClosed = new Promise<boolean>((resolve) => notifyingSecondary.once("close", () => resolve(true)));
    notifyingSecondary.send(JSON.stringify({ method: "initialized/again", params: {} }));
    await expect(Promise.race([
      notificationClosed,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
    ])).resolves.toBe(true);
    expect(upstream.messages.some((message) => message.method === "initialized/again")).toBe(false);
    expect(primary.readyState).toBe(WebSocket.OPEN);

    const primaryClosed = new Promise<void>((resolve) => primary.once("close", () => resolve()));
    primary.close();
    await primaryClosed;
    const replacement = await connectInitializedClient(listenPath, "codex-tui-replacement");
    cleanups.push(async () => replacement.terminate());
    await expect(rpcRequest(replacement, 11, "thread/start")).resolves.toMatchObject({
      result: { thread: { id: "thread:test" } }
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(upstream.connectionCount()).toBe(1);
    expect(upstream.connectedClientCount()).toBe(1);
    expect(upstream.messages.filter((message) => message.method === "initialize")).toHaveLength(1);
    expect(upstream.messages.filter((message) => message.method === "initialized")).toHaveLength(1);
  });

  it("keeps the upstream alive during replacement grace and closes it after timeout", async () => {
    const root = await mkdtemp(join(unixSocketTestRoot, "space-codex-socket-mux-replacement-timeout-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const upstreamPath = join(root, "upstream.sock");
    const listenPath = join(root, "app-server.sock");
    const upstream = await listenSingleClientUpstream(upstreamPath);
    const multiplexer = await startCodexAppServerSocketMultiplexer({
      upstreamPath,
      listenPath,
      primaryReplacementTimeoutMs: 100
    });
    cleanups.push(() => multiplexer.close());

    const primary = await connectInitializedClient(listenPath, "codex-tui");
    cleanups.push(async () => primary.terminate());
    const control = await connectInitializedClient(listenPath, "codex-control");
    cleanups.push(async () => control.terminate());
    const controlClosed = new Promise<{ code: number; reason: string }>((resolve) => {
      control.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    });

    const primaryClosed = new Promise<void>((resolve) => primary.once("close", () => resolve()));
    primary.close();
    await primaryClosed;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(control.readyState).toBe(WebSocket.OPEN);
    expect(upstream.connectedClientCount()).toBe(1);

    await expect(controlClosed).resolves.toMatchObject({
      code: 1001,
      reason: "Primary Codex client replacement timed out."
    });
    await vi.waitFor(() => expect(upstream.connectedClientCount()).toBe(0));
  });

  it("relays app-server events larger than the legacy one-megabyte ceiling", async () => {
    const root = await mkdtemp(join(unixSocketTestRoot, "space-codex-socket-mux-large-event-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const upstreamPath = join(root, "upstream.sock");
    const listenPath = join(root, "app-server.sock");
    const upstream = await listenSingleClientUpstream(upstreamPath);
    const multiplexer = await startCodexAppServerSocketMultiplexer({ upstreamPath, listenPath });
    cleanups.push(() => multiplexer.close());
    const primary = await connectInitializedClient(listenPath, "codex-tui");
    cleanups.push(async () => primary.terminate());

    const largeText = "x".repeat(2 * 1_024 * 1_024);
    const received = new Promise<RpcMessage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Large app-server event was not relayed.")), 1_000);
      primary.on("message", (data) => {
        const message = JSON.parse(data.toString()) as RpcMessage;
        if (message.method !== "item/completed") return;
        clearTimeout(timeout);
        resolve(message);
      });
      primary.once("close", () => {
        clearTimeout(timeout);
        reject(new Error("Multiplexer closed while relaying a large app-server event."));
      });
    });

    upstream.notify({ method: "item/completed", params: { text: largeText } });

    await expect(received).resolves.toMatchObject({
      method: "item/completed",
      params: { text: largeText }
    });
  });

  it("records the oversized upstream branch and closes clients with a WebSocket handshake", async () => {
    const root = await mkdtemp(join(unixSocketTestRoot, "space-codex-socket-mux-diagnostic-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const upstreamPath = join(root, "upstream.sock");
    const listenPath = join(root, "app-server.sock");
    const upstream = await listenSingleClientUpstream(upstreamPath);
    const diagnostics: Array<Record<string, unknown>> = [];
    const multiplexer = await startCodexAppServerSocketMultiplexer({
      upstreamPath,
      listenPath,
      maxBufferBytes: 1_024,
      onDiagnostic: (event) => diagnostics.push(event)
    } as DiagnosticAwareMultiplexerOptions);
    cleanups.push(() => multiplexer.close());
    const primary = await connectInitializedClient(listenPath, "codex-tui");
    cleanups.push(async () => primary.terminate());

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      primary.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    });
    const rejectedText = "do-not-log-this-payload".repeat(100);
    upstream.notify({ method: "item/completed", params: { text: rejectedText } });

    await expect(closed).resolves.toMatchObject({ code: 1009 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "codex_app_server_multiplexer_transport_failure",
      branch: "upstream_error",
      failureKind: "message_too_large",
      maxBufferBytes: 1_024
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ branch: "primary_client_close" }));
    expect(JSON.stringify(diagnostics)).not.toContain(rejectedText);
  });

  it("rewrites Build and Plan presets and mode payloads without replacing developer instructions", async () => {
    const root = await mkdtemp(join(unixSocketTestRoot, "space-codex-socket-mux-defaults-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const upstreamPath = join(root, "upstream.sock");
    const listenPath = join(root, "app-server.sock");
    const projectionPath = join(root, "defaults.json");
    await writeDefaultsProjection(
      projectionPath,
      { modelId: "gpt-global-build", reasoningEffort: "high" },
      { modelId: "gpt-global-plan", reasoningEffort: "xhigh" }
    );
    const upstream = await listenSingleClientUpstream(upstreamPath);
    const multiplexer = await startCodexAppServerSocketMultiplexer({
      upstreamPath,
      listenPath,
      defaultsProjectionPath: projectionPath
    } as ProjectionAwareMultiplexerOptions);
    cleanups.push(() => multiplexer.close());
    const primary = await connectInitializedClient(listenPath, "codex-tui");
    cleanups.push(async () => primary.terminate());

    const modes = await rpcRequest(primary, 2, "collaborationMode/list");
    expect(modes.result).toEqual({
      data: [
        { name: "Default", mode: "default", model: "gpt-global-build", reasoning_effort: "high" },
        { name: "Plan", mode: "plan", model: "gpt-global-plan", reasoning_effort: "xhigh" }
      ]
    });

    await rpcRequest(primary, 3, "thread/start");
    await rpcRequest(primary, 4, "turn/start", {
      threadId: "thread:test",
      model: "gpt-upstream-plan",
      effort: "high",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-upstream-plan",
          reasoning_effort: "high",
          developer_instructions: "Keep this exact Plan instruction."
        }
      }
    });

    expect(upstream.messages.find((message) => message.method === "turn/start")?.params).toMatchObject({
      model: "gpt-global-plan",
      effort: "xhigh",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-global-plan",
          reasoning_effort: "xhigh",
          developer_instructions: "Keep this exact Plan instruction."
        }
      }
    });
  });

  it("keeps a manual pair for the current mode and restores globals on the next mode switch", async () => {
    const root = await mkdtemp(join(unixSocketTestRoot, "space-codex-socket-mux-manual-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const upstreamPath = join(root, "upstream.sock");
    const listenPath = join(root, "app-server.sock");
    const projectionPath = join(root, "defaults.json");
    await writeDefaultsProjection(
      projectionPath,
      { modelId: "gpt-global-build", reasoningEffort: "high" },
      { modelId: "gpt-global-plan", reasoningEffort: "xhigh" }
    );
    const upstream = await listenSingleClientUpstream(upstreamPath);
    const multiplexer = await startCodexAppServerSocketMultiplexer({
      upstreamPath,
      listenPath,
      defaultsProjectionPath: projectionPath
    } as ProjectionAwareMultiplexerOptions);
    cleanups.push(() => multiplexer.close());
    const primary = await connectInitializedClient(listenPath, "codex-tui");
    cleanups.push(async () => primary.terminate());

    await rpcRequest(primary, 2, "thread/start");
    await rpcRequest(primary, 3, "turn/start", {
      threadId: "thread:test",
      collaborationMode: { mode: "default", settings: {} }
    });
    await rpcRequest(primary, 4, "thread/settings/update", {
      threadId: "thread:test",
      model: "gpt-manual",
      effort: "medium"
    });
    // Room Agent registers its explicit pair before the native /model menu.
    // The menu then submits a collaboration-mode update with its own preset.
    await rpcRequest(primary, 40, "thread/settings/update", {
      threadId: "thread:test",
      collaborationMode: { mode: "default", settings: { model: "gpt-tui-preset", reasoning_effort: "low" } }
    });
    expect(upstream.messages.findLast(message => message.id && message.method === "thread/settings/update")?.params)
      .toMatchObject({ model: "gpt-manual", effort: "medium",
        collaborationMode: { mode: "default", settings: { model: "gpt-manual", reasoning_effort: "medium" } } });
    await rpcRequest(primary, 5, "turn/start", {
      threadId: "thread:test",
      collaborationMode: { mode: "default", settings: {} }
    });
    await rpcRequest(primary, 6, "turn/start", {
      threadId: "thread:test",
      collaborationMode: { mode: "plan", settings: {} }
    });

    const turns = upstream.messages.filter((message) => message.method === "turn/start");
    expect(turns[1]?.params).toMatchObject({ model: "gpt-manual", effort: "medium" });
    expect(turns[2]?.params).toMatchObject({ model: "gpt-global-plan", effort: "xhigh" });
    await rpcRequest(primary, 7, "thread/settings/update", {
      threadId: "thread:test", model: "gpt-manual", effort: "medium"
    });
    await rpcRequest(primary, 8, "thread/settings/update", {
      threadId: "thread:test",
      collaborationMode: { mode: "plan", settings: { model: "gpt-global-plan", reasoning_effort: "xhigh" } }
    });
    expect(upstream.messages.findLast(message => message.method === "thread/settings/update")?.params)
      .toMatchObject({ model: "gpt-manual", effort: "medium",
        collaborationMode: { mode: "plan", settings: { model: "gpt-manual", reasoning_effort: "medium" } } });

  });

  it("applies projection changes immediately when idle and after turn completion when active", async () => {
    const root = await mkdtemp(join(unixSocketTestRoot, "space-codex-socket-mux-deferred-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const upstreamPath = join(root, "upstream.sock");
    const listenPath = join(root, "app-server.sock");
    const projectionPath = join(root, "defaults.json");
    await writeDefaultsProjection(
      projectionPath,
      { modelId: "gpt-build-one", reasoningEffort: "high" },
      { modelId: "gpt-plan", reasoningEffort: "xhigh" }
    );
    const upstream = await listenSingleClientUpstream(upstreamPath);
    const multiplexer = await startCodexAppServerSocketMultiplexer({
      upstreamPath,
      listenPath,
      defaultsProjectionPath: projectionPath,
      projectionPollIntervalMs: 20
    } as ProjectionAwareMultiplexerOptions);
    cleanups.push(() => multiplexer.close());
    const primary = await connectInitializedClient(listenPath, "codex-tui");
    cleanups.push(async () => primary.terminate());

    await rpcRequest(primary, 2, "thread/start");
    await rpcRequest(primary, 3, "turn/start", {
      threadId: "thread:test",
      collaborationMode: { mode: "default", settings: {} }
    });
    upstream.notify({ method: "turn/started", params: { threadId: "thread:test", turn: { id: "turn:active" } } });
    await writeDefaultsProjection(
      projectionPath,
      { modelId: "gpt-build-two", reasoningEffort: "xhigh" },
      { modelId: "gpt-plan", reasoningEffort: "xhigh" }
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(upstream.messages.filter((message) => message.method === "thread/settings/update")).toHaveLength(0);

    upstream.notify({ method: "turn/completed", params: { threadId: "thread:test", turn: { id: "turn:active" } } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(upstream.messages.findLast((message) => message.method === "thread/settings/update")?.params).toEqual({
      threadId: "thread:test",
      model: "gpt-build-two",
      effort: "xhigh"
    });

    await writeDefaultsProjection(
      projectionPath,
      { modelId: "gpt-build-three", reasoningEffort: "medium" },
      { modelId: "gpt-plan", reasoningEffort: "xhigh" }
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(upstream.messages.findLast((message) => message.method === "thread/settings/update")?.params).toEqual({
      threadId: "thread:test",
      model: "gpt-build-three",
      effort: "medium"
    });
  });

  it("keeps the last valid projection when a replacement is temporarily invalid", async () => {
    const root = await mkdtemp(join(unixSocketTestRoot, "space-codex-socket-mux-lkg-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const upstreamPath = join(root, "upstream.sock");
    const listenPath = join(root, "app-server.sock");
    const projectionPath = join(root, "defaults.json");
    await writeDefaultsProjection(
      projectionPath,
      { modelId: "gpt-build", reasoningEffort: "high" },
      { modelId: "gpt-plan-last-good", reasoningEffort: "xhigh" }
    );
    const upstream = await listenSingleClientUpstream(upstreamPath);
    const multiplexer = await startCodexAppServerSocketMultiplexer({
      upstreamPath,
      listenPath,
      defaultsProjectionPath: projectionPath,
      projectionPollIntervalMs: 20
    } as ProjectionAwareMultiplexerOptions);
    cleanups.push(() => multiplexer.close());
    const primary = await connectInitializedClient(listenPath, "codex-tui");
    cleanups.push(async () => primary.terminate());

    await rpcRequest(primary, 2, "thread/start");
    await rpcRequest(primary, 3, "turn/start", {
      threadId: "thread:test",
      collaborationMode: { mode: "default", settings: {} }
    });
    await writeFile(projectionPath, "{not-valid-json\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await rpcRequest(primary, 4, "turn/start", {
      threadId: "thread:test",
      collaborationMode: { mode: "plan", settings: {} }
    });

    expect(upstream.messages.findLast((message) => message.method === "turn/start")?.params).toMatchObject({
      model: "gpt-plan-last-good",
      effort: "xhigh"
    });
  });

  it("preserves a resumed thread pair until the first Build or Plan switch", async () => {
    const root = await mkdtemp(join(unixSocketTestRoot, "space-codex-socket-mux-resume-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const upstreamPath = join(root, "upstream.sock");
    const listenPath = join(root, "app-server.sock");
    const projectionPath = join(root, "defaults.json");
    await writeDefaultsProjection(
      projectionPath,
      { modelId: "gpt-global-build", reasoningEffort: "high" },
      { modelId: "gpt-global-plan", reasoningEffort: "xhigh" }
    );
    const upstream = await listenSingleClientUpstream(upstreamPath);
    const multiplexer = await startCodexAppServerSocketMultiplexer({
      upstreamPath,
      listenPath,
      defaultsProjectionPath: projectionPath
    } as ProjectionAwareMultiplexerOptions);
    cleanups.push(() => multiplexer.close());
    const primary = await connectInitializedClient(listenPath, "codex-tui");
    cleanups.push(async () => primary.terminate());

    await rpcRequest(primary, 2, "thread/resume", { threadId: "thread:existing" });
    await rpcRequest(primary, 3, "turn/start", {
      threadId: "thread:existing",
      model: "gpt-thread-model",
      effort: "medium",
      collaborationMode: {
        mode: "default",
        settings: { model: "gpt-thread-model", reasoning_effort: "medium" }
      }
    });
    await rpcRequest(primary, 4, "turn/start", {
      threadId: "thread:existing",
      collaborationMode: { mode: "plan", settings: {} }
    });

    const turns = upstream.messages.filter((message) => message.method === "turn/start");
    expect(turns[0]?.params).toMatchObject({ model: "gpt-thread-model", effort: "medium" });
    expect(turns[1]?.params).toMatchObject({ model: "gpt-global-plan", effort: "xhigh" });
  });
});
