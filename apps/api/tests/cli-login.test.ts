import { chmod, mkdtemp as createTempDir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cliLoginResponseSchema,
  paneCliWebSocketServerMessageSchema,
  type PaneCliWebSocketServerMessage
} from "@space/contracts";
import type { CliHostAttachInput, CliHostEventListener } from "@space/cli-host";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp as createApiApp, type CreateAppOptions } from "../src/app.js";
import { buildCliSpawnArgs } from "../src/cli-terminal.js";
import { getApiConfig } from "../src/config.js";

// Each test owns and closes its app and temporary commands even after failure.
const ownedApps = new Set<Awaited<ReturnType<typeof createApiApp>>>();
const ownedDirs: string[] = [];
async function mkdtemp(prefix: string) {
  const path = await createTempDir(prefix);
  ownedDirs.push(path);
  return path;
}
async function createApp(options: CreateAppOptions) {
  const app = await createApiApp(options);
  ownedApps.add(app);
  app.addHook("onClose", async () => { ownedApps.delete(app); });
  return app;
}
afterEach(async () => {
  await Promise.all([...ownedApps].map(app => app.close()));
  ownedApps.clear();
  await Promise.all(ownedDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const csrfHeaderName = "x-space-csrf-token";

async function loginRequiredConfig(
  runtime: "codex" | "claude" | "qwen" | "kimi" | "grok" | "cursor" | "copilot" = "grok"
) {
  const commandDir = await mkdtemp(join(tmpdir(), "space-cli-login-command-"));
  const commandName = `${runtime}-vscode-parity`;
  const commandPath = join(commandDir, commandName);
  const credentialObservation =
    "OBSERVATION:0000000000000000000000000000000000000000000000000000000000000000";
  await writeFile(
    commandPath,
    `#!/bin/sh
if [ "\${1:-}" = credential-status ]; then exit 1; fi
if [ "\${1:-}" = credential-observation ]; then printf '${credentialObservation}\\n'; fi
exit 0
`,
    "utf8"
  );
  await chmod(commandPath, 0o755);
  return getApiConfig({
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_COMMAND_PATH: commandDir,
    SPACE_CLI_WORKSPACE_ROOT: await mkdtemp(join(tmpdir(), "space-cli-login-workspaces-"))
  });
}

async function authedApp(
  store: InMemorySpaceStore,
  runtime: "codex" | "claude" | "qwen" | "kimi" | "grok" | "cursor" | "copilot" = "grok",
  cliHostClient?: CreateAppOptions["cliHostClient"]
) {
  const app = await createApp({
    store,
    config: await loginRequiredConfig(runtime),
    cliHostClient,
    auth: {
      sessionSecret: "test-secret-with-enough-length",
      devLogin: true,
      secureCookies: false
    }
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "space@space.local", password: "space-dev" }
  });
  const sessionCookie = login.cookies.find((c) => c.name === "space_session");
  const cookie = sessionCookie ? `${sessionCookie.name}=${sessionCookie.value}` : "";
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  return { app, cookie, csrfToken: csrf.json().csrfToken as string };
}

function decodeWsMessage(raw: unknown): PaneCliWebSocketServerMessage {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  return paneCliWebSocketServerMessageSchema.parse(JSON.parse(text));
}

async function waitForWsMessage(
  messages: PaneCliWebSocketServerMessage[],
  predicate: (message: PaneCliWebSocketServerMessage) => boolean
): Promise<PaneCliWebSocketServerMessage> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for WebSocket message. Seen: ${JSON.stringify(messages)}`);
}

describe("CLI login endpoint", () => {
  it.each(["codex", "qwen", "kimi", "grok", "cursor", "copilot"] as const)(
    "creates a terminal-only %s LOGIN session",
    async (runtime) => {
      const store = new InMemorySpaceStore();
      const room = store.createRoom({ name: `${runtime} login`, initialPaneCount: 0 });
      const { app, cookie, csrfToken } = await authedApp(store, runtime);

      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { runtimeId: `cli:${runtime}` }
      });

      expect(response.statusCode).toBe(200);
      const result = cliLoginResponseSchema.parse(response.json());
      expect(result).toMatchObject({
        pane: {
          roomId: room.id,
          mode: "TERMINAL",
          terminalRuntimeId: `cli:${runtime}`,
          cwd: "/etc"
        },
        session: {
          session: {
            paneId: result.pane.id,
            roomId: room.id,
            runtimeId: `cli:${runtime}`,
            launchMode: "FRESH",
            purpose: "LOGIN",
            status: "IDLE",
            isActive: true
          },
          transcript: []
        },
        reused: false
      });
      expect(store.listPanes(room.id)).toEqual([expect.objectContaining({ id: result.pane.id, mode: "TERMINAL" })]);
      expect(buildCliSpawnArgs(result.session.runtime, result.session.session)).toEqual(["login"]);
      const openedAudit = store.listAuditEvents().findLast((event) => event.action === "room.cli.login");
      expect(openedAudit).toMatchObject({
        targetType: "runtime",
        targetId: `cli:${runtime}`,
        metadata: { runtimeId: `cli:${runtime}`, outcome: "OPENED", durationMs: expect.any(Number) }
      });
      expect(Object.keys(openedAudit?.metadata ?? {}).sort()).toEqual(["durationMs", "outcome", "runtimeId"]);
      await app.close();
    }
  );

  it("requires authentication, CSRF, an existing room, and a strict request body", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Login guards", initialPaneCount: 0 });
    const { app, cookie, csrfToken } = await authedApp(store);
    const url = `/api/rooms/${encodeURIComponent(room.id)}/cli-login`;

    const unauthenticated = await app.inject({ method: "POST", url, payload: { runtimeId: "cli:grok" } });
    const missingCsrf = await app.inject({ method: "POST", url, headers: { cookie }, payload: { runtimeId: "cli:grok" } });
    const extraField = await app.inject({
      method: "POST",
      url,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { runtimeId: "cli:grok", command: "grok --unsafe" }
    });
    const removedAccountProfileField = await app.inject({
      method: "POST",
      url,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { runtimeId: "cli:grok", accountProfileId: "secondary" }
    });
    const missingRoom = await app.inject({
      method: "POST",
      url: "/api/rooms/room%3Amissing/cli-login",
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { runtimeId: "cli:grok" }
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(missingCsrf.statusCode).toBe(403);
    expect(extraField.statusCode).toBe(422);
    expect(removedAccountProfileField.statusCode).toBe(422);
    expect(missingRoom.statusCode).toBe(404);
    expect(store.listPanes(room.id)).toHaveLength(0);
    await app.close();
  });

  it("rejects runtimes outside the fixed login allowlist", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Login allowlist", initialPaneCount: 0 });
    const { app, cookie, csrfToken } = await authedApp(store);
    const headers = { cookie, [csrfHeaderName]: csrfToken };

    for (const runtimeId of ["cli:hermes", "cli:opencode", "cli:root", "cli:unknown"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
        headers,
        payload: { runtimeId }
      });
      expect(response.statusCode, runtimeId).toBeGreaterThanOrEqual(400);
    }
    expect(store.listPanes(room.id)).toHaveLength(0);
    await app.close();
  });

  it("reuses an active login session and retries a failed session in the same pane", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Login reuse", initialPaneCount: 0 });
    const { app, cookie, csrfToken } = await authedApp(store);
    const request = () => app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { runtimeId: "cli:grok" }
    });

    const first = cliLoginResponseSchema.parse((await request()).json());
    const activeRetry = cliLoginResponseSchema.parse((await request()).json());
    expect(activeRetry.reused).toBe(true);
    expect(activeRetry.pane.id).toBe(first.pane.id);
    expect(activeRetry.session.session.sessionId).toBe(first.session.session.sessionId);

    store.updatePaneCliSession(first.session.session.sessionId, {
      status: "ERROR",
      statusReason: "Login cancelled.",
      isActive: false,
      endedAt: new Date().toISOString()
    });
    const failedRetry = cliLoginResponseSchema.parse((await request()).json());
    expect(failedRetry.reused).toBe(true);
    expect(failedRetry.pane.id).toBe(first.pane.id);
    expect(failedRetry.session.session.sessionId).not.toBe(first.session.session.sessionId);
    expect(failedRetry.session.session.purpose).toBe("LOGIN");
    expect(store.listPanes(room.id)).toHaveLength(1);
    await app.close();
  });

  it("does not reuse a historical login pane that now owns an active normal CLI session", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Login reuse boundary", initialPaneCount: 0 });
    const { app, cookie, csrfToken } = await authedApp(store);
    const headers = { cookie, [csrfHeaderName]: csrfToken };
    const first = cliLoginResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
      headers,
      payload: { runtimeId: "cli:grok" }
    })).json());
    store.updatePaneCliSession(first.session.session.sessionId, {
      status: "EXITED",
      statusReason: "Login completed.",
      isActive: false,
      endedAt: new Date().toISOString()
    });
    store.createPaneCliSession({
      paneId: first.pane.id,
      roomId: room.id,
      runtimeId: "cli:grok",
      providerId: "google",
      agentId: "grok",
      modelId: null,
      reasoningEffort: "medium",
      purpose: "NORMAL",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "Normal Gemini CLI is active.",
      isActive: true
    });

    const next = cliLoginResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
      headers,
      payload: { runtimeId: "cli:grok" }
    })).json());

    expect(next.reused).toBe(false);
    expect(next.pane.id).not.toBe(first.pane.id);
    expect(store.listPanes(room.id)).toHaveLength(2);
    expect(store.getActivePaneCliSession(first.pane.id)).toMatchObject({ purpose: "NORMAL", isActive: true });
    await app.close();
  });

  it("cancels LOGIN with a fixed safe status and audit, then retries in the same pane", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Login cancel", initialPaneCount: 0 });
    const { app, cookie, csrfToken } = await authedApp(store, "grok", {
      terminate: async () => false,
      close: async () => undefined
    } as CreateAppOptions["cliHostClient"]);
    const created = cliLoginResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { runtimeId: "cli:grok" }
    })).json());

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/panes/${encodeURIComponent(created.pane.id)}/cli/interrupt`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { reason: "Cancel https://oauth.invalid with synthetic-device-code" }
    });

    expect(cancelled.statusCode).toBe(200);
    expect(store.getPaneCliSession(created.session.session.sessionId)).toMatchObject({
      purpose: "LOGIN",
      status: "EXITED",
      statusReason: "CLI login cancelled by operator.",
      isActive: false
    });
    expect(store.listPaneCliTranscriptChunks(created.session.session.sessionId)).toEqual([]);
    const audit = store.listAuditEvents().findLast((event) => event.action === "cli.login.complete");
    expect(audit).toMatchObject({
      targetType: "runtime",
      targetId: "cli:grok",
      metadata: { runtimeId: "cli:grok", outcome: "CANCELLED", durationMs: expect.any(Number) }
    });
    expect(Object.keys(audit?.metadata ?? {}).sort()).toEqual(["durationMs", "outcome", "runtimeId"]);
    expect(JSON.stringify(audit)).not.toContain("oauth.invalid");
    expect(JSON.stringify(audit)).not.toContain("synthetic-device-code");

    const retried = cliLoginResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { runtimeId: "cli:grok" }
    })).json());
    expect(retried.reused).toBe(true);
    expect(retried.pane.id).toBe(created.pane.id);
    expect(retried.session.session.sessionId).not.toBe(created.session.session.sessionId);
    await app.close();
  });

  it("preserves the room pane cap", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Login pane cap", initialPaneCount: 16 });
    const { app, cookie, csrfToken } = await authedApp(store);

    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { runtimeId: "cli:grok" }
    });

    expect(response.statusCode).toBe(409);
    expect(store.listPanes(room.id)).toHaveLength(16);
    await app.close();
  });

  it("restricts LOGIN sessions to terminal authentication I/O, reconnect, and cancellation", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Restricted login terminal", initialPaneCount: 0 });
    const { app, cookie, csrfToken } = await authedApp(store, "codex");
    const headers = { cookie, [csrfHeaderName]: csrfToken };
    const created = cliLoginResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
      headers,
      payload: { runtimeId: "cli:codex" }
    })).json());
    const paneUrl = `/api/panes/${encodeURIComponent(created.pane.id)}`;

    const responses = await Promise.all([
      app.inject({ method: "GET", url: `${paneUrl}/cli/model-settings`, headers: { cookie } }),
      app.inject({ method: "GET", url: `${paneUrl}/cli/model-settings/status`, headers: { cookie } }),
      app.inject({
        method: "PATCH",
        url: `${paneUrl}/cli/model-settings`,
        headers,
        payload: {
          expectedSessionId: created.session.session.sessionId,
          modelId: "gpt-5.6-sol",
          reasoningEffort: "high",
          continueActiveTurn: false
        }
      }),
      app.inject({
        method: "POST",
        url: `${paneUrl}/cli/clipboard-debug`,
        headers,
        payload: { severity: "bad", title: "oauth code", detail: "synthetic-device-code" }
      })
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("CONFLICT");
    }
    // The title service returns the unchanged pane for LOGIN; it does not read auth output.
    const titled = await app.inject({ method: "POST", url: `${paneUrl}/title/generate`, headers });
    expect(titled.statusCode).toBe(200);
    expect(titled.json().title).toBe(created.pane.title);
    expect(JSON.stringify(store.listAuditEvents())).not.toContain("synthetic-device-code");
    expect(store.listPaneCliTranscriptChunks(created.session.session.sessionId)).toEqual([]);
    await app.close();
  });

  it("streams and replays active login output without durably storing auth terminal content", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Private login terminal", initialPaneCount: 0 });
    const syntheticOutput = "Open https://oauth.invalid/authorize?challenge=synthetic and enter synthetic-device-code\r\n";
    let listener: CliHostEventListener | undefined;
    let hostSession: Awaited<ReturnType<NonNullable<CreateAppOptions["cliHostClient"]>["inspect"]>> = null;
    let outputSequence = 0;
    let detachCount = 0;
    const input = async () => ({ accepted: true, acceptedAtMs: Date.now() });
    const cliHostClient = {
      health: async () => ({ hostPid: 1, startedAt: new Date().toISOString(), buildCommit: null, sessions: [] }),
      inspect: async () => hostSession,
      attach: async (request: CliHostAttachInput, eventListener?: CliHostEventListener) => {
        listener = eventListener;
        if (!hostSession) {
          hostSession = {
            ...request.identity,
            generationId: "00000000-0000-4000-8000-000000000201",
            pid: 9201,
            status: "RUNNING" as const,
            statusReason: "Login is running.",
            exitCode: null,
            signal: null,
            nextOutputSequence: 0,
            attachmentCount: 1,
            startedAt: new Date().toISOString(),
            endedAt: null
          };
        }
        expect(request.spawn?.args ?? undefined).toEqual(request.spawn ? ["login"] : undefined);
        return {
          attachmentId: `attachment:login-${Date.now()}`,
          session: hostSession,
          replay: request.spawn ? [] : [{
            type: "output" as const,
            generationId: hostSession.generationId,
            sequence: outputSequence,
            stream: "stdout" as const,
            data: syntheticOutput
          }]
        };
      },
      input,
      resize: async () => undefined,
      detach: async () => {
        detachCount += 1;
        return true;
      },
      terminate: vi.fn(async () => true),
      close: async () => undefined
    } as CreateAppOptions["cliHostClient"];
    const { app, cookie, csrfToken } = await authedApp(store, "grok", cliHostClient);
    const created = cliLoginResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { runtimeId: "cli:grok" }
    })).json());
    const terminalUrl =
      `/api/panes/${encodeURIComponent(created.pane.id)}/cli/terminal` +
      `?sessionId=${encodeURIComponent(created.session.session.sessionId)}` +
      `&token=${encodeURIComponent(created.session.websocket?.token ?? "")}`;
    const firstMessages: PaneCliWebSocketServerMessage[] = [];
    const firstSocket = await app.injectWS(terminalUrl, { headers: { cookie } }, {
      onInit(socket) {
        socket.on("message", (raw) => firstMessages.push(decodeWsMessage(raw)));
      }
    });
    await waitForWsMessage(firstMessages, (message) => message.type === "ready");
    firstSocket.send(JSON.stringify({ type: "input", data: "synthetic-authorization-code\r" }));
    listener?.({
      type: "output",
      generationId: hostSession!.generationId,
      sequence: outputSequence++,
      stream: "stdout",
      data: syntheticOutput
    });
    await waitForWsMessage(firstMessages, (message) => message.type === "output" && message.data.includes("oauth.invalid"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.listPaneCliTranscriptChunks(created.session.session.sessionId)).toEqual([]);
    expect(store.getPaneCliHostOutputCursor(created.session.session.sessionId, hostSession!.generationId)).toBe(-1);

    firstSocket.terminate();
    await vi.waitFor(() => expect(detachCount).toBe(1));
    const reused = cliLoginResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { runtimeId: "cli:grok" }
    })).json());
    const replayMessages: PaneCliWebSocketServerMessage[] = [];
    const replaySocket = await app.injectWS(
      `/api/panes/${encodeURIComponent(reused.pane.id)}/cli/terminal` +
      `?sessionId=${encodeURIComponent(reused.session.session.sessionId)}` +
      `&token=${encodeURIComponent(reused.session.websocket?.token ?? "")}`,
      { headers: { cookie } },
      { onInit(socket) { socket.on("message", (raw) => replayMessages.push(decodeWsMessage(raw))); } }
    );
    await waitForWsMessage(replayMessages, (message) => message.type === "output" && message.data.includes("oauth.invalid"));
    expect(store.listPaneCliTranscriptChunks(created.session.session.sessionId)).toEqual([]);
    const lifecycleStart = replayMessages.length;
    replaySocket.send(JSON.stringify({ type: "interrupt" }));
    await waitForWsMessage(
      replayMessages,
      (message) => message.type === "status" && message.status === "EXITED"
    );
    expect(replayMessages.slice(lifecycleStart).filter((message) => message.type === "status" || message.type === "error")).toEqual([
      expect.objectContaining({
        type: "status",
        status: "EXITED",
        statusReason: "CLI login cancelled by operator."
      })
    ]);
    replaySocket.terminate();
    await app.close();
  });

  it("times out LOGIN with a fixed safe status and audit without deleting credentials", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Login timeout", initialPaneCount: 0 });
    let hostSession: Awaited<ReturnType<NonNullable<CreateAppOptions["cliHostClient"]>["inspect"]>> = null;
    const terminate = vi.fn(async () => true);
    const cliHostClient = {
      health: async () => ({ hostPid: 1, startedAt: new Date().toISOString(), buildCommit: null, sessions: [] }),
      inspect: async () => hostSession,
      attach: async (request: CliHostAttachInput) => {
        hostSession = {
          ...request.identity,
          generationId: "00000000-0000-4000-8000-000000000203",
          pid: 9203,
          status: "RUNNING" as const,
          statusReason: "Sensitive provider state must remain transient.",
          exitCode: null,
          signal: null,
          nextOutputSequence: 0,
          attachmentCount: 1,
          startedAt: new Date().toISOString(),
          endedAt: null
        };
        return { attachmentId: "attachment:login-timeout", session: hostSession, replay: [] };
      },
      input: async () => ({ accepted: true, acceptedAtMs: Date.now() }),
      resize: async () => undefined,
      detach: async () => true,
      terminate,
      close: async () => undefined
    } as CreateAppOptions["cliHostClient"];
    const config = await loginRequiredConfig("grok");
    const app = await createApp({
      store,
      config,
      cliHostClient,
      cliLoginTimeoutMs: 100,
      auth: {
        sessionSecret: "test-secret-with-enough-length",
        devLogin: true,
        secureCookies: false
      }
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "space@space.local", password: "space-dev" }
    });
    const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
    const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
    const created = cliLoginResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
      headers: { cookie, [csrfHeaderName]: csrf.json().csrfToken as string },
      payload: { runtimeId: "cli:grok" }
    })).json());
    const messages: PaneCliWebSocketServerMessage[] = [];
    const socket = await app.injectWS(
      `/api/panes/${encodeURIComponent(created.pane.id)}/cli/terminal` +
      `?sessionId=${encodeURIComponent(created.session.session.sessionId)}` +
      `&token=${encodeURIComponent(created.session.websocket?.token ?? "")}`,
      { headers: { cookie } },
      { onInit(ws) { ws.on("message", (raw) => messages.push(decodeWsMessage(raw))); } }
    );
    await waitForWsMessage(messages, (message) => message.type === "status" && message.status === "RUNNING");
    const lifecycleStart = messages.length;

    await vi.waitFor(() => expect(store.getPaneCliSession(created.session.session.sessionId)).toMatchObject({
      purpose: "LOGIN",
      status: "ERROR",
      statusReason: "CLI login timed out after 15 minutes. Retry login in this pane.",
      isActive: false
    }));
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(messages.slice(lifecycleStart).filter((message) => message.type === "status" || message.type === "error")).toEqual([
      expect.objectContaining({
        type: "status",
        status: "ERROR",
        statusReason: "CLI login timed out after 15 minutes. Retry login in this pane."
      })
    ]);
    const audit = store.listAuditEvents().findLast((event) => event.action === "cli.login.complete");
    expect(audit).toMatchObject({
      targetType: "runtime",
      targetId: "cli:grok",
      metadata: { runtimeId: "cli:grok", outcome: "TIMEOUT", durationMs: expect.any(Number) }
    });
    expect(Object.keys(audit?.metadata ?? {}).sort()).toEqual(["durationMs", "outcome", "runtimeId"]);
    expect(JSON.stringify({ session: store.getPaneCliSession(created.session.session.sessionId), audit })).not.toContain(
      "Sensitive provider state"
    );
    socket.terminate();
    await app.close();
  });

  it("reports Kimi entitlement/provider failure once with a fixed safe status and audit", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Provider login failure", initialPaneCount: 0 });
    let listener: CliHostEventListener | undefined;
    let hostSession: Awaited<ReturnType<NonNullable<CreateAppOptions["cliHostClient"]>["inspect"]>> = null;
    const rawFailure = "OAuth failed at https://oauth.invalid using synthetic-device-code";
    const cliHostClient = {
      health: async () => ({ hostPid: 1, startedAt: new Date().toISOString(), buildCommit: null, sessions: [] }),
      inspect: async () => hostSession,
      attach: async (request: CliHostAttachInput, eventListener?: CliHostEventListener) => {
        listener = eventListener;
        hostSession = {
          ...request.identity,
          generationId: "00000000-0000-4000-8000-000000000204",
          pid: 9204,
          status: "RUNNING" as const,
          statusReason: "Login is running.",
          exitCode: null,
          signal: null,
          nextOutputSequence: 0,
          attachmentCount: 1,
          startedAt: new Date().toISOString(),
          endedAt: null
        };
        return { attachmentId: "attachment:login-provider-failure", session: hostSession, replay: [] };
      },
      input: async () => ({ accepted: true, acceptedAtMs: Date.now() }),
      resize: async () => undefined,
      detach: async () => true,
      terminate: vi.fn(async () => true),
      close: async () => undefined
    } as CreateAppOptions["cliHostClient"];
    const { app, cookie, csrfToken } = await authedApp(store, "kimi", cliHostClient);
    const created = cliLoginResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { runtimeId: "cli:kimi" }
    })).json());
    const messages: PaneCliWebSocketServerMessage[] = [];
    const socket = await app.injectWS(
      `/api/panes/${encodeURIComponent(created.pane.id)}/cli/terminal` +
      `?sessionId=${encodeURIComponent(created.session.session.sessionId)}` +
      `&token=${encodeURIComponent(created.session.websocket?.token ?? "")}`,
      { headers: { cookie } },
      { onInit(ws) { ws.on("message", (raw) => messages.push(decodeWsMessage(raw))); } }
    );
    await waitForWsMessage(messages, (message) => message.type === "status" && message.status === "RUNNING");
    const lifecycleStart = messages.length;
    listener?.({ type: "status", status: "ERROR", statusReason: rawFailure, exitCode: 1, signal: null });

    await vi.waitFor(() => expect(store.getPaneCliSession(created.session.session.sessionId)).toMatchObject({
      purpose: "LOGIN",
      status: "ERROR",
      statusReason: "Kimi Code OAuth is stored, but functional subscription access could not be verified. Check subscription entitlement and retry in this pane.",
      isActive: false
    }));
    expect(messages.slice(lifecycleStart).filter((message) => message.type === "status" || message.type === "error")).toEqual([
      expect.objectContaining({
        type: "status",
        status: "ERROR",
        statusReason: "Kimi Code OAuth is stored, but functional subscription access could not be verified. Check subscription entitlement and retry in this pane."
      })
    ]);
    const audit = store.listAuditEvents().findLast((event) => event.action === "cli.login.complete");
    expect(audit).toMatchObject({
      targetType: "runtime",
      targetId: "cli:kimi",
      metadata: { runtimeId: "cli:kimi", outcome: "PROVIDER_FAILURE", durationMs: expect.any(Number) }
    });
    expect(JSON.stringify({ session: store.getPaneCliSession(created.session.session.sessionId), audit, messages })).not.toContain(rawFailure);
    expect(store.listPaneCliTranscriptChunks(created.session.session.sessionId)).toEqual([]);
    socket.terminate();
    await app.close();
  });

  it("replaces Grok LOGIN with NORMAL only after its foreground smoke exits successfully", async () => {
    const commandDir = await mkdtemp(join(tmpdir(), "space-grok-login-exit-command-"));
    const readyFlag = join(commandDir, "grok-ready");
    const actionLog = join(commandDir, "actions");
    const commandPath = join(commandDir, "grok-vscode-parity");
    await writeFile(
      commandPath,
      `#!/bin/sh
printf '%s\\n' "\${1:-tui}" >>"${actionLog}"
if [ "\${1:-}" = credential-status ]; then
  [ -f "${readyFlag}" ] && printf 'READY\\n' && exit 0
  exit 1
fi
if [ "\${1:-}" = credential-observation ]; then
  [ -f "${readyFlag}" ] && printf 'OBSERVATION:1111111111111111111111111111111111111111111111111111111111111111\\n' && exit 0
  printf 'OBSERVATION:MISSING\\n'
  exit 0
fi
if [ "\${1:-}" = credential-smoke ]; then
  [ -f "${readyFlag}" ] && printf 'SPACE_GROK_OK\\n' && exit 0
  exit 1
fi
exit 0
`,
      "utf8"
    );
    await chmod(commandPath, 0o755);
    const config = getApiConfig({
      SPACE_CLI_ENABLED: "true",
      SPACE_CLI_COMMAND_PATH: commandDir,
      SPACE_CLI_WORKSPACE_ROOT: await mkdtemp(join(tmpdir(), "space-grok-login-exit-workspaces-"))
    });
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Grok login exit", initialPaneCount: 0 });
    let listener: CliHostEventListener | undefined;
    let hostSession: Awaited<ReturnType<NonNullable<CreateAppOptions["cliHostClient"]>["inspect"]>> = null;
    const terminate = vi.fn(async () => true);
    const cliHostClient = {
      health: async () => ({ hostPid: 1, startedAt: new Date().toISOString(), buildCommit: null, sessions: [] }),
      inspect: async () => hostSession,
      attach: async (request: CliHostAttachInput, eventListener?: CliHostEventListener) => {
        listener = eventListener;
        hostSession = {
          ...request.identity,
          generationId: "00000000-0000-4000-8000-000000000202",
          pid: 9202,
          status: "RUNNING" as const,
          statusReason: "Grok login smoke is running.",
          exitCode: null,
          signal: null,
          nextOutputSequence: 0,
          attachmentCount: 1,
          startedAt: new Date().toISOString(),
          endedAt: null
        };
        expect(request.spawn?.args).toEqual(["login"]);
        return { attachmentId: "attachment:grok-login-exit", session: hostSession, replay: [] };
      },
      input: async () => ({ accepted: true, acceptedAtMs: Date.now() }),
      resize: async () => undefined,
      detach: async () => true,
      terminate,
      close: async () => undefined
    } as CreateAppOptions["cliHostClient"];
    const app = await createApp({
      store,
      config,
      cliHostClient,
      cliLoginObservationIntervalMs: 10,
      auth: {
        sessionSecret: "test-secret-with-enough-length",
        devLogin: true,
        secureCookies: false
      }
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "space@space.local", password: "space-dev" }
    });
    const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
    const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
    const created = cliLoginResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
      headers: { cookie, [csrfHeaderName]: csrf.json().csrfToken as string },
      payload: { runtimeId: "cli:grok" }
    })).json());
    const messages: PaneCliWebSocketServerMessage[] = [];
    const socket = await app.injectWS(
      `/api/panes/${encodeURIComponent(created.pane.id)}/cli/terminal` +
      `?sessionId=${encodeURIComponent(created.session.session.sessionId)}` +
      `&token=${encodeURIComponent(created.session.websocket?.token ?? "")}`,
      { headers: { cookie } },
      { onInit(ws) { ws.on("message", (raw) => messages.push(decodeWsMessage(raw))); } }
    );
    await waitForWsMessage(messages, (message) => message.type === "ready");
    expect(messages.some((message) => message.type === "session_replaced")).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const actionsBeforeCredential = await readFile(actionLog, "utf8");
    expect(actionsBeforeCredential).toContain("credential-observation");
    expect(actionsBeforeCredential).not.toContain("credential-smoke");
    expect(messages.some(
      (message) => message.type === "output" && message.data.includes("Credential verification did not succeed")
    )).toBe(false);

    await writeFile(readyFlag, "ready\n", "utf8");
    listener?.({
      type: "status",
      status: "EXITED",
      statusReason: "Grok login smoke completed.",
      exitCode: 0,
      signal: null
    });

    const replaced = await waitForWsMessage(messages, (message) => message.type === "session_replaced");
    const normalSessionId = replaced.type === "session_replaced" ? replaced.sessionId : "";
    expect(normalSessionId).not.toBe(created.session.session.sessionId);
    expect(terminate).not.toHaveBeenCalled();
    expect(await readFile(actionLog, "utf8")).toContain("credential-observation");
    expect(await readFile(actionLog, "utf8")).toContain("credential-smoke");
    expect(store.getActivePaneCliSession(created.pane.id)).toMatchObject({
      sessionId: normalSessionId,
      runtimeId: "cli:grok",
      purpose: "NORMAL",
      status: "IDLE",
      isActive: true
    });
    expect(store.listPaneCliTranscriptChunks(created.session.session.sessionId)).toEqual([]);
    expect(store.listAuditEvents().find((event) => event.action === "cli.login.complete")).toMatchObject({
      targetId: "cli:grok",
      metadata: { runtimeId: "cli:grok", outcome: "SUCCESS", durationMs: expect.any(Number) }
    });
    socket.terminate();
    await app.close();
  });

  it("submits the fixed Qwen /auth command once after the official TUI prompt is ready", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Qwen auth bootstrap", initialPaneCount: 0 });
    let listener: CliHostEventListener | undefined;
    const input = vi.fn(async () => ({ accepted: true, acceptedAtMs: Date.now() }));
    const cliHostClient = {
      health: async () => ({ hostPid: 1, startedAt: new Date().toISOString(), buildCommit: null, sessions: [] }),
      inspect: async () => null,
      attach: async (request: CliHostAttachInput, eventListener?: CliHostEventListener) => {
        listener = eventListener;
        return {
          attachmentId: "attachment:qwen-auth-bootstrap",
          session: {
            ...request.identity,
            generationId: "00000000-0000-4000-8000-000000000404",
            pid: 9404,
            status: "RUNNING" as const,
            statusReason: "Login is running.",
            exitCode: null,
            signal: null,
            nextOutputSequence: 0,
            attachmentCount: 1,
            startedAt: new Date().toISOString(),
            detachedAt: null,
            endedAt: null
          },
          replay: []
        };
      },
      input,
      resize: async () => undefined,
      detach: async () => true,
      terminate: vi.fn(async () => true),
      close: async () => undefined
    } as CreateAppOptions["cliHostClient"];
    const app = await createApp({
      store,
      config: await loginRequiredConfig("qwen"),
      cliHostClient,
      cliLoginObservationIntervalMs: 10_000,
      auth: {
        sessionSecret: "test-secret-with-enough-length",
        devLogin: true,
        secureCookies: false
      }
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "space@space.local", password: "space-dev" }
    });
    const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
    const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
    const created = cliLoginResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
      headers: { cookie, [csrfHeaderName]: csrf.json().csrfToken as string },
      payload: { runtimeId: "cli:qwen" }
    })).json());
    const messages: PaneCliWebSocketServerMessage[] = [];
    const socket = await app.injectWS(
      `/api/panes/${encodeURIComponent(created.pane.id)}/cli/terminal` +
      `?sessionId=${encodeURIComponent(created.session.session.sessionId)}` +
      `&token=${encodeURIComponent(created.session.websocket?.token ?? "")}`,
      { headers: { cookie } },
      { onInit(ws) { ws.on("message", (raw) => messages.push(decodeWsMessage(raw))); } }
    );
    await waitForWsMessage(messages, (message) => message.type === "ready");
    listener?.({
      type: "output",
      generationId: "00000000-0000-4000-8000-000000000404",
      sequence: 0,
      stream: "stdout",
      data: "Type your message or @path/to/file\r\n➜ etc · openai/gpt-4o\r\nYOLO mode\r\n"
    });

    await vi.waitFor(() => expect(input).toHaveBeenCalledOnce());
    expect(input).toHaveBeenCalledWith(
      expect.objectContaining({
        cliSessionId: created.session.session.sessionId,
        runtimeId: "cli:qwen"
      }),
      "attachment:qwen-auth-bootstrap",
      "/auth\r",
      "hidden",
      `qwen-auth-bootstrap:${created.session.session.sessionId}:00000000-0000-4000-8000-000000000404`
    );
    listener?.({
      type: "output",
      generationId: "00000000-0000-4000-8000-000000000404",
      sequence: 1,
      stream: "stdout",
      data: "YOLO mode\r\n"
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(input).toHaveBeenCalledOnce();
    expect(store.listPaneCliTranscriptChunks(created.session.session.sessionId)).toEqual([]);
    socket.terminate();
    await app.close();
  });

  it.each([
    ["qwen", "SPACE_QWEN_OK"],
    ["copilot", "SPACE_COPILOT_OK"],
    ["cursor", "SPACE_CURSOR_OK"]
  ] as const)(
    "smokes an existing %s credential observation immediately and replaces LOGIN with NORMAL",
    async (runtime, smokeMarker) => {
      const commandDir = await mkdtemp(join(tmpdir(), `space-cli-${runtime}-initial-smoke-command-`));
      const verifiedFlag = join(commandDir, "credential-verified");
      const commandPath = join(commandDir, `${runtime}-vscode-parity`);
      await writeFile(
        commandPath,
        `#!/bin/sh
case "\${1:-}" in
  credential-observation)
    printf 'OBSERVATION:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\\n'
    ;;
  credential-smoke)
    : >"${verifiedFlag}"
    printf '${smokeMarker}\\n'
    ;;
  credential-status)
    [ -f "${verifiedFlag}" ] && printf 'READY\\n' && exit 0
    exit 1
    ;;
  *) exit 0 ;;
esac
`,
        "utf8"
      );
      await chmod(commandPath, 0o755);
      const config = getApiConfig({
        SPACE_CLI_ENABLED: "true",
        SPACE_CLI_COMMAND_PATH: commandDir,
        SPACE_CLI_WORKSPACE_ROOT: await mkdtemp(join(tmpdir(), `space-cli-${runtime}-initial-smoke-workspaces-`))
      });
      const store = new InMemorySpaceStore();
      const room = store.createRoom({ name: `${runtime} initial credential smoke`, initialPaneCount: 0 });
      let hostSession: Awaited<ReturnType<NonNullable<CreateAppOptions["cliHostClient"]>["inspect"]>> = null;
      const cliHostClient = {
        health: async () => ({ hostPid: 1, startedAt: new Date().toISOString(), buildCommit: null, sessions: [] }),
        inspect: async () => hostSession,
        attach: async (request: CliHostAttachInput) => {
          hostSession = {
            ...request.identity,
            generationId: `00000000-0000-4000-8000-0000000003${runtime === "grok" ? "01" : "02"}`,
            pid: runtime === "grok" ? 9301 : 9302,
            status: "RUNNING" as const,
            statusReason: "Login is running.",
            exitCode: null,
            signal: null,
            nextOutputSequence: 0,
            attachmentCount: 1,
            startedAt: new Date().toISOString(),
            endedAt: null
          };
          return { attachmentId: `attachment:${runtime}-initial-smoke`, session: hostSession, replay: [] };
        },
        input: async () => ({ accepted: true, acceptedAtMs: Date.now() }),
        resize: async () => undefined,
        detach: async () => true,
        terminate: vi.fn(async () => true),
        close: async () => undefined
      } as CreateAppOptions["cliHostClient"];
      const app = await createApp({
        store,
        config,
        cliHostClient,
        cliLoginObservationIntervalMs: 10,
        auth: {
          sessionSecret: "test-secret-with-enough-length",
          devLogin: true,
          secureCookies: false
        }
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "space@space.local", password: "space-dev" }
      });
      const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
      const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
      const created = cliLoginResponseSchema.parse((await app.inject({
        method: "POST",
        url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
        headers: { cookie, [csrfHeaderName]: csrf.json().csrfToken as string },
        payload: { runtimeId: `cli:${runtime}` }
      })).json());
      const messages: PaneCliWebSocketServerMessage[] = [];
      const socket = await app.injectWS(
        `/api/panes/${encodeURIComponent(created.pane.id)}/cli/terminal` +
        `?sessionId=${encodeURIComponent(created.session.session.sessionId)}` +
        `&token=${encodeURIComponent(created.session.websocket?.token ?? "")}`,
        { headers: { cookie } },
        { onInit(ws) { ws.on("message", (raw) => messages.push(decodeWsMessage(raw))); } }
      );

      const replaced = await waitForWsMessage(messages, (message) => message.type === "session_replaced");
      expect(replaced).toMatchObject({ type: "session_replaced", sessionId: expect.any(String) });
      expect(store.getActivePaneCliSession(created.pane.id)).toMatchObject({
        runtimeId: `cli:${runtime}`,
        purpose: "NORMAL",
        status: "IDLE",
        isActive: true
      });
      expect(store.listPaneCliTranscriptChunks(created.session.session.sessionId)).toEqual([]);
      expect(cliHostClient.terminate).toHaveBeenCalledTimes(1);
      const runtimeResponse = await app.inject({ method: "GET", url: "/api/cli/runtimes", headers: { cookie } });
      expect(runtimeResponse.json().data).toContainEqual(expect.objectContaining({
        id: `cli:${runtime}`,
        authState: "READY",
        status: "ENABLED"
      }));
      socket.terminate();
      await app.close();
    }
  );

  it("recovers a verified login that exited before the API could reattach", async () => {
    const commandDir = await mkdtemp(join(tmpdir(), "space-cli-login-recovery-command-"));
    const readyFlag = join(commandDir, "credential-ready");
    const commandPath = join(commandDir, "grok-vscode-parity");
    await writeFile(
      commandPath,
      `#!/bin/sh
if [ "\${1:-}" = credential-status ]; then
  [ -f "${readyFlag}" ] && printf 'READY\\n' && exit 0
  exit 1
fi
if [ "\${1:-}" = credential-observation ]; then
  [ -f "${readyFlag}" ] && printf 'OBSERVATION:2222222222222222222222222222222222222222222222222222222222222222\\n' && exit 0
  printf 'OBSERVATION:MISSING\\n'
  exit 0
fi
if [ "\${1:-}" = credential-smoke ]; then
  [ -f "${readyFlag}" ] && printf 'SPACE_GROK_OK\\n' && exit 0
  exit 1
fi
exit 0
`,
      "utf8"
    );
    await chmod(commandPath, 0o755);
    const config = getApiConfig({
      SPACE_CLI_ENABLED: "true",
      SPACE_CLI_COMMAND_PATH: commandDir,
      SPACE_CLI_WORKSPACE_ROOT: await mkdtemp(join(tmpdir(), "space-cli-login-recovery-workspaces-"))
    });
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Login reconnect recovery", initialPaneCount: 0 });
    let hostSession: Awaited<ReturnType<NonNullable<CreateAppOptions["cliHostClient"]>["inspect"]>> = null;
    const attach = vi.fn(async () => {
      throw new Error("An exited login host session must not be reattached.");
    });
    const cliHostClient = {
      health: async () => ({ hostPid: 1, startedAt: new Date().toISOString(), buildCommit: null, sessions: [] }),
      inspect: async () => hostSession,
      attach,
      input: async () => ({ accepted: true, acceptedAtMs: Date.now() }),
      resize: async () => undefined,
      detach: async () => true,
      terminate: async () => true,
      close: async () => undefined
    } as CreateAppOptions["cliHostClient"];
    const app = await createApp({
      store,
      config,
      cliHostClient,
      auth: {
        sessionSecret: "test-secret-with-enough-length",
        devLogin: true,
        secureCookies: false
      }
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "space@space.local", password: "space-dev" }
    });
    const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
    const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
    const created = cliLoginResponseSchema.parse((await app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
      headers: { cookie, [csrfHeaderName]: csrf.json().csrfToken as string },
      payload: { runtimeId: "cli:grok" }
    })).json());

    await writeFile(readyFlag, "ready\n", "utf8");
    hostSession = {
      cliSessionId: created.session.session.sessionId,
      paneId: created.pane.id,
      roomId: room.id,
      runtimeId: "cli:grok",
      codexThreadId: null,
      modelId: null,
      reasoningEffort: created.session.session.reasoningEffort,
      generationId: "00000000-0000-4000-8000-000000000203",
      pid: 9203,
      status: "EXITED",
      statusReason: "Login wrapper completed while the API was reconnecting.",
      exitCode: 0,
      signal: null,
      nextOutputSequence: 1,
      attachmentCount: 0,
      startedAt: created.session.session.startedAt,
      detachedAt: null,
      endedAt: new Date().toISOString()
    };

    const messages: PaneCliWebSocketServerMessage[] = [];
    const socket = await app.injectWS(
      `/api/panes/${encodeURIComponent(created.pane.id)}/cli/terminal` +
      `?sessionId=${encodeURIComponent(created.session.session.sessionId)}` +
      `&token=${encodeURIComponent(created.session.websocket?.token ?? "")}`,
      { headers: { cookie } },
      { onInit(ws) { ws.on("message", (raw) => messages.push(decodeWsMessage(raw))); } }
    );
    const replaced = await waitForWsMessage(messages, (message) => message.type === "session_replaced");
    expect(replaced).toMatchObject({ type: "session_replaced", sessionId: expect.any(String) });
    expect(attach).not.toHaveBeenCalled();
    expect(store.getActivePaneCliSession(created.pane.id)).toMatchObject({ purpose: "NORMAL", isActive: true });
    expect(store.getPaneCliSession(created.session.session.sessionId)).toMatchObject({
      purpose: "LOGIN",
      status: "EXITED",
      isActive: false
    });
    expect(store.listPaneCliTranscriptChunks(created.session.session.sessionId)).toEqual([]);
    socket.terminate();
    await app.close();
  });
});
