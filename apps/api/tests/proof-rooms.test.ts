import { TaskTitleProviders } from "../src/task-title-providers.js";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proofRoomSchema } from "@space/contracts";
import {
  CliHostClient, CliHostSessionRegistry, createCliHostServer, spawnNodePty,
  type CliHostAttachInput,
  type CliHostIdentity,
  type CliHostSessionSummary
} from "@space/cli-host";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import { createApp, type CreateAppOptions } from "../src/app.js";
import { createCsrfToken, signSession, signSessionWithTtl } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { codexInputReady } from "../src/cli-terminal.js";

const csrfHeaderName = "x-space-csrf-token";
const testSessionSecret = "test-secret-with-enough-length";
const temporaryRoots: string[] = [];

async function enabledProofConfig() {
  const root = await mkdtemp(join(tmpdir(), "space-proof-room-"));
  temporaryRoots.push(root);
  const commandPath = join(root, "codex-vscode-parity");
  await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(commandPath, 0o755);
  return getApiConfig({
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_COMMAND_PATH: root,
    SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
    SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces")
  });
}

function readyHostClient(options: {
  failAttachAt?: number;
  replayReady?: boolean;
  inspectSession?: (identity: CliHostIdentity) => CliHostSessionSummary | null;
} = {}) {
  let attachCount = 0;
  const terminate = vi.fn(async () => true);
  const input = vi.fn<NonNullable<CreateAppOptions["cliHostClient"]>["input"]>(async () => ({ accepted: true, acceptedAtMs: Date.now() }));
  const inspect = vi.fn(async (identity: CliHostIdentity) =>
    options.inspectSession?.(identity) ?? null
  );
  const attach = vi.fn(async (request: CliHostAttachInput) => {
    attachCount += 1;
    if (attachCount === options.failAttachAt) throw new Error("proof host attach failed");
    return {
      attachmentId: `attachment:proof:${attachCount}`,
      session: {
        ...request.identity,
        generationId: `00000000-0000-4000-8000-${String(attachCount).padStart(12, "0")}`,
        pid: 6100 + attachCount,
        status: "RUNNING" as const,
        statusReason: "Running.",
        exitCode: null,
        signal: null,
        nextOutputSequence: 1,
        attachmentCount: 1,
        startedAt: "2026-07-20T12:00:00.000Z",
        endedAt: null
      },
      replay: [
        {
          type: "output" as const,
          generationId: `00000000-0000-4000-8000-${String(attachCount).padStart(12, "0")}`,
          sequence: 0,
          stream: "stdout" as const,
          data: options.replayReady === false
            ? "Starting isolated Codex runtime..."
            : "OpenAI Codex\nmodel: gpt-5.6-sol xhigh  /model to change\n› Ready"
        }
      ]
    };
  });
  return {
    client: {
      health: async () => ({ hostPid: 1, startedAt: "2026-07-20T12:00:00.000Z", buildCommit: null, sessions: [] }),
      inspect,
      attach,
      input,
      resize: async () => undefined,
      detach: async () => true,
      terminate,
      close: async () => undefined
    } as NonNullable<CreateAppOptions["cliHostClient"]>,
    attach,
    inspect,
    input,
    terminate
  };
}

function activeAgentCatalogService(options: { advertised?: boolean } = {}) {
  const response = {
    defaults: {
      build: { modelId: "gpt-5.6-sol", reasoningEffort: "high" }
    },
    catalog: options.advertised === false
      ? { status: "UNAVAILABLE" as const, models: [], error: "Codex model catalog is unavailable." }
      : {
          status: "AVAILABLE" as const,
          models: [{
            id: "gpt-5.4-mini",
            displayName: "GPT-5.4 mini",
            isDefault: false,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: ["low"],
            reasoningOptions: [{ reasoningEffort: "low" }]
          }],
          error: null
        }
  };
  return {
    build: vi.fn(async () => response.defaults.build),
    read: vi.fn(async () => response)
  } as NonNullable<CreateAppOptions["codexCliModeDefaultsService"]>;
}

function signedHeaders(role: "ADMIN" | "OPERATOR") {
  const token = signSession(
    { id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.test`, role },
    testSessionSecret
  );
  return {
    cookie: `space_session=${token}`,
    [csrfHeaderName]: createCsrfToken(token, testSessionSecret)!
  };
}

async function authedApp(options: CreateAppOptions) {
  const app = await createApp({
    codexCliModeDefaultsService: activeAgentCatalogService(),
    ...options,
    auth: {
      sessionSecret: testSessionSecret,
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
  return { app, cookie, csrfToken: csrf.json().csrfToken as string };
}

// These tests exercise fixture ownership and transport, not provider discovery.
// Keep background title discovery from launching real CLIs during app teardown.
beforeEach(() => { vi.spyOn(TaskTitleProviders.prototype, "refresh").mockResolvedValue(); });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent proof rooms API", () => {
  it("attaches a warm-capacity fixture through the real host and terminal WebSocket without launching an AI CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "pt-"));
    temporaryRoots.push(root);
    const socketPath = join(root, "host.sock");
    const spawn = vi.fn(spawnNodePty);
    const registry = new CliHostSessionRegistry({ spawn });
    const server = await createCliHostServer({ socketPath, registry });
    const host = new CliHostClient({ socketPath });
    const store = new InMemorySpaceStore();
    const { app, cookie, csrfToken } = await authedApp({
      store, cliHostClient: host, codexAgentControl: null,
      config: { ...await enabledProofConfig(), cliHostSocketPath: socketPath }
    });
    const headers = { cookie, [csrfHeaderName]: csrfToken };
    let terminal: Awaited<ReturnType<typeof app.injectWS>> | undefined;
    try {
      const response = await app.inject({ method: "POST", url: "/api/proof-rooms", headers,
        payload: { profile: "WARM_CAPACITY", paneCount: 16 } });
      expect(response.statusCode).toBe(201);
      const record = proofRoomSchema.parse(response.json());
      const originalHostSessions = registry.inspectAll().map(s => ({ id: s.cliSessionId, pid: s.pid }));
      const paneId = record.panes[0]!.id;
      const sessionResponse = await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(paneId)}/cli/session`, headers });
      expect(sessionResponse.statusCode).toBe(200);
      const session = sessionResponse.json();
      expect(session?.session?.status).toBe("RUNNING");
      const messages: Array<{type:string; status?:string; message?:string; data?:string}> = [];
      terminal = await app.injectWS(`/api/panes/${encodeURIComponent(paneId)}/cli/terminal?sessionId=${encodeURIComponent(session.session.sessionId)}&token=${encodeURIComponent(session.websocket.token)}`,
        { headers: { cookie } }, { onInit(socket) { socket.on("message", raw => messages.push(JSON.parse(raw.toString()))); } });
      await vi.waitFor(() => {
        expect(messages.filter(m => m.type === "error")).toEqual([]);
        expect(messages.some(m => m.type === "status" && m.status === "RUNNING")).toBe(true);
        expect(messages.some(m => m.type === "output" && m.data?.includes("SPACE_WARM_READY"))).toBe(true);
      }, { timeout: 5000 });
      expect(registry.inspectAll().filter(s => s.status === "RUNNING")).toHaveLength(16);
      expect(registry.inspectAll().map(s => ({ id: s.cliSessionId, pid: s.pid }))).toEqual(originalHostSessions);
      expect(spawn).toHaveBeenCalledTimes(16);
      expect(spawn.mock.calls.every(([spec]) => spec.command === "/bin/sh")).toBe(true);
    } finally {
      terminal?.terminate();
      await app.close();
      registry.terminateAll();
      await host.close();
      await server.close();
    }
  });

  it("bounds warm-capacity fixtures to sixteen synthetic terminals and cleans only their processes", async () => {
    const store=new InMemorySpaceStore(),host=readyHostClient();
    const {app,cookie,csrfToken}=await authedApp({store,cliHostClient:host.client,config:await enabledProofConfig()});
    const headers={cookie,[csrfHeaderName]:csrfToken};
    try {
      expect((await app.inject({method:"POST",url:"/api/proof-rooms",headers:signedHeaders("OPERATOR"),payload:{profile:"WARM_CAPACITY",paneCount:16}})).statusCode).toBe(403);
      for (const payload of [
        {profile:"WARM_CAPACITY",paneCount:15},
        {profile:"WARM_CAPACITY",paneCount:16,runtimeId:"cli:codex"},
        {profile:"WARM_CAPACITY",paneCount:16,command:"echo unsafe"},
        {profile:"STANDARD",paneCount:16},
      ]) expect((await app.inject({method:"POST",url:"/api/proof-rooms",headers,payload})).statusCode).toBe(422);
      const response=await app.inject({method:"POST",url:"/api/proof-rooms",headers,payload:{profile:"WARM_CAPACITY",paneCount:16}});
      expect(response.statusCode).toBe(201);
      const record=proofRoomSchema.parse(response.json());
      expect(record.profile).toBe("WARM_CAPACITY");
      expect(record.panes).toHaveLength(16);expect(record.sessionIds).toHaveLength(16);
      expect(host.attach).toHaveBeenCalledTimes(16);
      for(const [input] of host.attach.mock.calls) {
        expect(input.identity.roomId).toBe(record.room.id);
        expect(input.spawn?.command).toBe("/bin/sh");
        expect(input.spawn?.args).toEqual(["-c","printf 'SPACE_WARM_READY\\r\\n'; exec /bin/sleep 240"]);
      }
      const started=await app.inject({method:"POST",url:`/api/proof-rooms/${encodeURIComponent(record.room.id)}/cli-render/start`,headers,payload:{}});
      expect(started.statusCode).toBe(409);
      let acknowledgedExitAt = 0;
      host.terminate.mockImplementation(async () => { acknowledgedExitAt = Date.now() + 100; return true; });
      host.inspect.mockImplementation(async identity => acknowledgedExitAt > Date.now() ? {
        ...identity, generationId: "00000000-0000-4000-8000-000000000001", pid: 6100,
        status: "RUNNING", statusReason: "Awaiting exit event", exitCode: null, signal: null,
        nextOutputSequence: 1, attachmentCount: 0, startedAt: "2026-07-20T12:00:00.000Z", endedAt: null
      } : null);
      const cleaned=await app.inject({method:"POST",url:`/api/proof-rooms/${encodeURIComponent(record.room.id)}/cli-render/cleanup`,headers,payload:{}});
      expect(cleaned.statusCode).toBe(200);expect(cleaned.json().ownedProcessStopped).toBe(true);
      expect(host.terminate).toHaveBeenCalledTimes(16);
      const operator=store.createRoom({name:"Operator",initialPaneCount:0});
      const refused=await app.inject({method:"POST",url:`/api/proof-rooms/${encodeURIComponent(operator.id)}/cli-render/cleanup`,headers,payload:{}});
      expect(refused.statusCode).toBe(409);expect(host.terminate).toHaveBeenCalledTimes(16);
    } finally {await app.close();}
  });

  it("creates the fixed core-runtime render PTYs in one owned room and rejects arbitrary runtime overrides", async () => {
    const store=new InMemorySpaceStore(),host=readyHostClient();
    const {app}=await authedApp({store,cliHostClient:host.client,config:await enabledProofConfig()});
    const proofToken = signSessionWithTtl({ id: "user:operator-proof", email: "proof@space.test", role: "ADMIN" }, testSessionSecret, 180);
    const cookie = `space_session=${proofToken}`, csrfToken = createCsrfToken(proofToken, testSessionSecret)!;
    try {
      const response=await app.inject({method:"POST",url:"/api/proof-rooms",headers:{cookie,[csrfHeaderName]:csrfToken},payload:{profile:"CLI_RENDER",paneCount:3,renderRuntime:"ALL"}});
      expect(response.statusCode).toBe(201);
      const record=proofRoomSchema.parse(response.json());
      expect(record.profile).toBe("CLI_RENDER");expect(record.renderRuntime).toBe("ALL");expect(record.panes).toHaveLength(3);expect(record.sessionIds).toHaveLength(3);
      // The existing auth hook resolves the ephemeral broker principal. The
      // fixture uses that exact authenticated owner; composer gates stay strict.
      const authenticated = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
      expect(authenticated.json().user.id).toBe("user:operator");
      expect(record.room.ownerUserId).toBe(authenticated.json().user.id);
      const receipt = await app.inject({ method: "GET", headers: { cookie },
        url: `/api/panes/${encodeURIComponent(record.panes[0]!.id)}/cli/local-composer/submissions/00000000-0000-4000-8000-000000000001` });
      expect(receipt.statusCode).toBe(200);
      expect(receipt.json().status).toBe("NOT_FOUND");
      const otherOwner = await app.inject({ method: "GET", headers: signedHeaders("ADMIN"),
        url: `/api/panes/${encodeURIComponent(record.panes[0]!.id)}/cli/local-composer/submissions/00000000-0000-4000-8000-000000000001` });
      expect(otherOwner.statusCode).toBe(404);
      expect(record.panes.map(pane=>pane.terminalRuntimeId)).toEqual(["cli:codex","cli:gemini","cli:opencode"]);
      expect(host.attach).toHaveBeenCalledTimes(3);
      for(const [index,call] of host.attach.mock.calls.entries()){
        const input=call[0];expect(input.identity.paneId).toBe(record.panes[index]!.id);expect(input.identity.roomId).toBe(record.room.id);
        expect(input.identity.runtimeId).toBe(record.panes[index]!.terminalRuntimeId);expect(input.spawn?.args).toContain("--input-type=module");expect(input.spawn?.args?.at(-1)).toContain("SPACE_RENDER_START");
      }
      const invalid=await app.inject({method:"POST",url:"/api/proof-rooms",headers:{cookie,[csrfHeaderName]:csrfToken},payload:{profile:"CLI_RENDER",paneCount:1,runtimeId:"cli:codex"}});
      expect(invalid.statusCode).toBe(422);
      const arbitrary=await app.inject({method:"POST",url:`/api/proof-rooms/${encodeURIComponent(record.room.id)}/cli-render/start`,headers:{cookie,[csrfHeaderName]:csrfToken},payload:{command:"echo unsafe"}});
      expect(arbitrary.statusCode).toBe(422);
      const cleaned=await app.inject({method:"POST",url:`/api/proof-rooms/${encodeURIComponent(record.room.id)}/cli-render/cleanup`,headers:{cookie,[csrfHeaderName]:csrfToken},payload:{}});
      expect(cleaned.statusCode).toBe(200);expect(cleaned.json().ownedProcessStopped).toBe(true);expect(host.terminate).toHaveBeenCalledTimes(3);
      const operator=store.createRoom({name:"Operator",initialPaneCount:0});
      const refused=await app.inject({method:"POST",url:`/api/proof-rooms/${encodeURIComponent(operator.id)}/cli-render/cleanup`,headers:{cookie,[csrfHeaderName]:csrfToken},payload:{}});
      expect(refused.statusCode).toBe(409);expect(host.terminate).toHaveBeenCalledTimes(3);
    } finally {await app.close();}
  });

  it("attributes a standard empty proof room to the authenticated owner for Dots identity", async () => {
    const store = new InMemorySpaceStore();
    const { app, cookie, csrfToken } = await authedApp({ store });
    try {
      const response = await app.inject({ method: "POST", url: "/api/proof-rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { paneCount: 0 } });
      expect(response.statusCode).toBe(201);
      expect(proofRoomSchema.parse(response.json()).room.ownerUserId).toBe("user:dev-operator");
    } finally { await app.close(); }
  });

  it("makes the short composer fixture ready for normal Codex input without waiting for process age", async () => {
    const fixtureUrl = new URL("../../../scripts/cli-render-fixture.mjs", import.meta.url);
    // Import in native Node: Vitest rewrites functions before fixtureProgram serializes them.
    const program = `const {fixtureProgram}=await import(${JSON.stringify(fixtureUrl.href)});eval(fixtureProgram());`;
    const pty = await spawnNodePty({ command: process.execPath, args: ["--input-type=module", "-e", program],
      cwd: process.cwd(), env: { TERM: "xterm-256color", LANG: "C.UTF-8" }, cols: 100, rows: 30 });
    let output = "";
    pty.onData(data => { output += data; });
    const exited = new Promise<void>(resolve => pty.onExit(() => resolve()));
    try {
      await vi.waitFor(() => expect(output).toContain("SPACE_RENDER_READY"), { timeout: 2000 });
      expect(codexInputReady(output)).toBe(false);
      pty.write("SPACE_LOCAL_COMPOSER_START\n");
      await vi.waitFor(() => expect(codexInputReady(output)).toBe(true), { timeout: 2000 });
      expect(output).toContain("SPACE_LOCAL_COMPOSER_READY");
      expect(output).not.toMatch(/SRM:\d{6}|SPACE_RENDER_FINAL|SPACE_RENDER_COMPLETE/);
    } finally { pty.kill(); await exited; }
  });

  it("starts the fixed composer-only probe on one Codex fixture and rejects other modes and scopes", async () => {
    const store = new InMemorySpaceStore(), host = readyHostClient();
    const { app, cookie, csrfToken } = await authedApp({ store, cliHostClient: host.client, config: await enabledProofConfig() });
    const headers = { cookie, [csrfHeaderName]: csrfToken };
    const createFixture = async (renderRuntime: "CODEX" | "GEMINI" | "OPENCODE" | "ALL") => {
      const response = await app.inject({ method: "POST", url: "/api/proof-rooms", headers,
        payload: { profile: "CLI_RENDER", paneCount: renderRuntime === "ALL" ? 3 : 1, renderRuntime } });
      expect(response.statusCode).toBe(201);
      return proofRoomSchema.parse(response.json());
    };
    try {
      const record = await createFixture("CODEX");
      host.inspect.mockResolvedValue((await host.attach.mock.results[0]!.value).session);
      const startUrl = `/api/proof-rooms/${encodeURIComponent(record.room.id)}/cli-render/start`;
      for (const payload of [{ mode: "UNKNOWN" }, { mode: "COMPOSER", command: "arbitrary" }]) {
        const rejected = await app.inject({ method: "POST", url: startUrl, headers, payload });
        expect(rejected.statusCode).toBe(422);
      }
      const readonlyToken = signSessionWithTtl({ id: "user:proof-reader", email: "reader@space.test", role: "ADMIN", proofScope: "READ_ONLY" }, testSessionSecret, 180);
      const readonly = await app.inject({ method: "POST", url: startUrl,
        headers: { cookie: `space_session=${readonlyToken}`, [csrfHeaderName]: createCsrfToken(readonlyToken, testSessionSecret)! }, payload: { mode: "COMPOSER" } });
      expect(readonly.statusCode).toBe(403);
      expect(host.input).not.toHaveBeenCalled();
      const started = await app.inject({ method: "POST", url: startUrl, headers, payload: { mode: "COMPOSER" } });
      expect(started.statusCode).toBe(200);
      expect(started.json().started).toBe(true);
      expect(host.input.mock.calls[0]!.slice(2)).toEqual(["SPACE_LOCAL_COMPOSER_START\n", "hidden", `cli-render:composer:${record.sessionIds[0]}`]);
      expect(host.attach.mock.calls[1]![0].spawn).toBeUndefined();
      host.input.mockClear();
      for (const runtime of ["GEMINI", "OPENCODE", "ALL"] as const) {
        const other = await createFixture(runtime);
        const rejected = await app.inject({ method: "POST", url: `/api/proof-rooms/${encodeURIComponent(other.room.id)}/cli-render/start`, headers, payload: { mode: "COMPOSER" } });
        expect(rejected.statusCode).toBe(409);
      }
      const operator = store.createRoom({ name: "Operator workspace", initialPaneCount: 0 });
      const operatorRejected = await app.inject({ method: "POST", url: `/api/proof-rooms/${encodeURIComponent(operator.id)}/cli-render/start`, headers, payload: { mode: "COMPOSER" } });
      expect(operatorRejected.statusCode).toBe(409);
      expect(host.input).not.toHaveBeenCalled();
      // Default start keeps the existing fixed render marker and idempotency key.
      const standard = await createFixture("CODEX");
      const defaultStart = await app.inject({ method: "POST", url: `/api/proof-rooms/${encodeURIComponent(standard.room.id)}/cli-render/start`, headers, payload: {} });
      expect(defaultStart.statusCode).toBe(200);
      expect(host.input.mock.calls[0]!.slice(2)).toEqual(["SPACE_RENDER_START\n", "hidden", `cli-render:${standard.sessionIds[0]}`]);
    } finally { await app.close(); }
  });

  it("creates and retrieves a persistent isolated proof room with independent Codex sessions", async () => {
    const store = new InMemorySpaceStore();
    const workspace = store.createRoom({ name: "Operator workspace", initialPaneCount: 0 }, "trace:workspace");
    const eventBus = new SpaceEventBus();
    const published: Array<{ type: string; roomId: string | null; paneId: string | null }> = [];
    eventBus.subscribe((event) => published.push(event));
    const host = readyHostClient();
    const { app, cookie, csrfToken } = await authedApp({
      store,
      eventBus,
      cliHostClient: host.client,
      config: await enabledProofConfig()
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/proof-rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneCount: 2, roomLabel: "Mobile regression" }
      });

      expect(response.statusCode).toBe(201);
      const proof = proofRoomSchema.parse(response.json());
      expect(proof.room).toMatchObject({ kind: "AGENT_PROOF", name: "Agent Proof · Mobile regression" });
      expect(proof.panes).toHaveLength(2);
      expect(proof.panes.map((pane) => ({ roomId: pane.roomId, mode: pane.mode, runtime: pane.terminalRuntimeId, cwd: pane.cwd }))).toEqual([
        { roomId: proof.room.id, mode: "TERMINAL", runtime: "cli:codex", cwd: "/etc" },
        { roomId: proof.room.id, mode: "TERMINAL", runtime: "cli:codex", cwd: "/etc" }
      ]);
      expect(new Set(proof.panes.map((pane) => pane.id)).size).toBe(2);
      expect(new Set(proof.sessionIds).size).toBe(2);
      expect(proof.sessionIds).toHaveLength(2);
      expect(host.attach).toHaveBeenCalledTimes(2);
      for (const pane of proof.panes) {
        const session = store.getActivePaneCliSession(pane.id);
        expect(session).toMatchObject({ roomId: proof.room.id, paneId: pane.id, runtimeId: "cli:codex", cwd: "/etc" });
        expect(session?.sessionId).not.toContain(workspace.id);
      }
      expect(store.listPanes(workspace.id)).toEqual([]);
      expect(published.filter((event) => event.roomId === proof.room.id).map((event) => event.type)).toEqual([
        "ROOM_CREATED",
        "PANE_CREATED",
        "PANE_CREATED"
      ]);

      const retrieved = await app.inject({
        method: "GET",
        url: `/api/proof-rooms/${encodeURIComponent(proof.room.id)}`,
        headers: { cookie }
      });
      expect(retrieved.statusCode).toBe(200);
      expect(proofRoomSchema.parse(retrieved.json())).toEqual(proof);

      const workspaceLookup = await app.inject({
        method: "GET",
        url: `/api/proof-rooms/${encodeURIComponent(workspace.id)}`,
        headers: { cookie }
      });
      expect(workspaceLookup.statusCode).toBe(404);

      const normalRoom = await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { name: "Normal", initialPaneCount: 0, kind: "AGENT_PROOF" }
      });
      expect(normalRoom.statusCode).toBe(200);
      expect(normalRoom.json().kind).toBe("WORKSPACE");
    } finally {
      await app.close();
    }
  });

  it("creates a fixed CLI input proof pane without pre-spawning its terminal transport", async () => {
    const store = new InMemorySpaceStore();
    const host = readyHostClient();
    const { app, cookie, csrfToken } = await authedApp({
      store,
      cliHostClient: host.client,
      config: await enabledProofConfig()
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/proof-rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: {
          profile: "CLI_INPUT",
          paneCount: 1,
          runtimeId: "cli:codex",
          roomLabel: "Codex input"
        }
      });

      expect(response.statusCode).toBe(201);
      const proof = proofRoomSchema.parse(response.json());
      expect(proof).toMatchObject({
        profile: "CLI_INPUT",
        runtimeId: "cli:codex",
        room: { kind: "AGENT_PROOF", name: "Agent Proof · Codex input" },
        panes: [{
          mode: "TERMINAL",
          terminalRuntimeId: "cli:codex",
          cwd: "/etc"
        }],
        sessionIds: []
      });
      expect(host.attach).not.toHaveBeenCalled();
      expect(store.getActivePaneCliSession(proof.panes[0]!.id)).toBeNull();

      const retrieved = await app.inject({
        method: "GET",
        url: `/api/proof-rooms/${encodeURIComponent(proof.room.id)}`,
        headers: { cookie }
      });
      expect(retrieved.statusCode).toBe(200);
      expect(proofRoomSchema.parse(retrieved.json())).toEqual(proof);

      const forbidden = await app.inject({
        method: "POST",
        url: "/api/proof-rooms",
        headers: signedHeaders("OPERATOR"),
        payload: {
          profile: "CLI_INPUT",
          paneCount: 1,
          runtimeId: "cli:codex"
        }
      });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json().error.code).toBe("ADMIN_REQUIRED");
      expect(store.listRooms()).toHaveLength(1);
      expect(host.attach).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns only an uncached direct-host identity for the matching ADMIN CLI input proof pane", async () => {
    const store = new InMemorySpaceStore();
    let inspectedSession: CliHostSessionSummary | null = null;
    const host = readyHostClient({
      inspectSession: (identity) =>
        inspectedSession?.cliSessionId === identity.cliSessionId
          ? inspectedSession
          : null
    });
    const { app, cookie, csrfToken } = await authedApp({
      store,
      cliHostClient: host.client,
      config: await enabledProofConfig()
    });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/proof-rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: {
          profile: "CLI_INPUT",
          paneCount: 1,
          runtimeId: "cli:codex",
          roomLabel: "Codex identity"
        }
      });
      expect(created.statusCode).toBe(201);
      const proof = proofRoomSchema.parse(created.json());
      const pane = proof.panes[0]!;
      const session = store.createPaneCliSession({
        sessionId: "cli_session:proof-codex-identity",
        paneId: pane.id,
        roomId: proof.room.id,
        runtimeId: "cli:codex",
        providerId: "codex",
        agentId: "codex",
        modelId: null,
        reasoningEffort: "medium",
        cwd: "/etc",
        status: "RUNNING",
        statusReason: "CLI running.",
        isActive: true
      });
      inspectedSession = {
        cliSessionId: session.sessionId,
        paneId: pane.id,
        roomId: proof.room.id,
        runtimeId: "cli:codex",
        codexThreadId: null,
        modelId: null,
        reasoningEffort: "medium",
        generationId: "00000000-0000-4000-8000-000000000777",
        pid: 6777,
        status: "RUNNING",
        statusReason: "CLI running.",
        exitCode: null,
        signal: null,
        nextOutputSequence: 8,
        attachmentCount: 1,
        startedAt: "2026-07-26T12:00:00.000Z",
        detachedAt: null,
        endedAt: null
      };

      const identity = await app.inject({
        method: "GET",
        url:
          `/api/proof-rooms/${encodeURIComponent(proof.room.id)}` +
          `/panes/${encodeURIComponent(pane.id)}/cli-identity`,
        headers: { cookie }
      });
      expect(identity.statusCode).toBe(200);
      expect(identity.headers["cache-control"]).toBe("no-store");
      expect(identity.json()).toEqual({
        sessionId: session.sessionId,
        pid: 6777,
        generationId: "00000000-0000-4000-8000-000000000777",
        sampledAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
      });
      expect(Object.keys(identity.json()).sort()).toEqual([
        "generationId",
        "pid",
        "sampledAt",
        "sessionId"
      ]);
      expect(host.inspect).toHaveBeenCalledTimes(1);

      const operator = await app.inject({
        method: "GET",
        url:
          `/api/proof-rooms/${encodeURIComponent(proof.room.id)}` +
          `/panes/${encodeURIComponent(pane.id)}/cli-identity`,
        headers: signedHeaders("OPERATOR")
      });
      expect(operator.statusCode).toBe(403);
      expect(operator.json().error.code).toBe("ADMIN_REQUIRED");
      expect(host.inspect).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("fails closed when proof identity scope or active host identity does not match", async () => {
    const store = new InMemorySpaceStore();
    const operatorRoom = store.createRoom({
      name: "Operator workspace",
      initialPaneCount: 1
    });
    const host = readyHostClient();
    const { app, cookie, csrfToken } = await authedApp({
      store,
      cliHostClient: host.client,
      config: await enabledProofConfig()
    });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/proof-rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: {
          profile: "CLI_INPUT",
          paneCount: 1,
          runtimeId: "cli:codex"
        }
      });
      const proof = proofRoomSchema.parse(created.json());
      const pane = proof.panes[0]!;
      store.createPaneCliSession({
        sessionId: "cli_session:proof-stale-host",
        paneId: pane.id,
        roomId: proof.room.id,
        runtimeId: "cli:codex",
        providerId: "codex",
        agentId: "codex",
        modelId: null,
        reasoningEffort: "medium",
        cwd: "/etc",
        status: "RUNNING",
        statusReason: "CLI running.",
        isActive: true
      });

      const wrongPane = await app.inject({
        method: "GET",
        url:
          `/api/proof-rooms/${encodeURIComponent(proof.room.id)}` +
          `/panes/${encodeURIComponent(store.listPanes(operatorRoom.id)[0]!.id)}/cli-identity`,
        headers: { cookie }
      });
      expect(wrongPane.statusCode).toBe(404);
      expect(host.inspect).not.toHaveBeenCalled();

      const staleHost = await app.inject({
        method: "GET",
        url:
          `/api/proof-rooms/${encodeURIComponent(proof.room.id)}` +
          `/panes/${encodeURIComponent(pane.id)}/cli-identity`,
        headers: { cookie }
      });
      expect(staleHost.statusCode).toBe(409);
      expect(host.inspect).toHaveBeenCalledTimes(1);

      const standard = await app.inject({
        method: "POST",
        url: "/api/proof-rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneCount: 1 }
      });
      const standardProof = proofRoomSchema.parse(standard.json());
      const inspectCountBeforeWrongProfile = host.inspect.mock.calls.length;
      const wrongProfile = await app.inject({
        method: "GET",
        url:
          `/api/proof-rooms/${encodeURIComponent(standardProof.room.id)}` +
          `/panes/${encodeURIComponent(standardProof.panes[0]!.id)}/cli-identity`,
        headers: { cookie }
      });
      expect(wrongProfile.statusCode).toBe(404);
      expect(host.inspect).toHaveBeenCalledTimes(inspectCountBeforeWrongProfile);
    } finally {
      await app.close();
    }
  });

  it("supports zero panes and rejects unsupported pane counts without creating rooms", async () => {
    const store = new InMemorySpaceStore();
    const host = readyHostClient();
    const { app, cookie, csrfToken } = await authedApp({
      store,
      cliHostClient: host.client,
      config: await enabledProofConfig()
    });

    try {
      const zero = await app.inject({
        method: "POST",
        url: "/api/proof-rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneCount: 0 }
      });
      expect(zero.statusCode).toBe(201);
      expect(proofRoomSchema.parse(zero.json())).toMatchObject({ panes: [], sessionIds: [] });
      expect(host.attach).not.toHaveBeenCalled();

      const roomsBeforeInvalid = store.listRooms().length;
      const invalid = await app.inject({
        method: "POST",
        url: "/api/proof-rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneCount: 3 }
      });
      expect(invalid.statusCode).toBe(422);
      expect(store.listRooms()).toHaveLength(roomsBeforeInvalid);
    } finally {
      await app.close();
    }
  });

  it("creates only advertised mini/low active-agent stress rooms with one through six independent panes", async () => {
    const store = new InMemorySpaceStore();
    const host = readyHostClient();
    const codexCliModeDefaultsService = activeAgentCatalogService();
    const { app, cookie, csrfToken } = await authedApp({
      store,
      cliHostClient: host.client,
      codexCliModeDefaultsService,
      config: await enabledProofConfig()
    });

    try {
      for (let paneCount = 1; paneCount <= 6; paneCount += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/proof-rooms",
          headers: { cookie, [csrfHeaderName]: csrfToken },
          payload: {
            profile: "ACTIVE_AGENT_STRESS",
            paneCount,
            roomLabel: `Stress ${paneCount}`
          }
        });

        expect(response.statusCode).toBe(201);
        const proof = proofRoomSchema.parse(response.json());
        expect(proof.profile).toBe("ACTIVE_AGENT_STRESS");
        expect(proof.panes).toHaveLength(paneCount);
        expect(proof.sessionIds).toHaveLength(paneCount);
        expect(proof.panes.every((pane) =>
          pane.modelId === "gpt-5.4-mini" &&
          pane.reasoningEffort === "low" &&
          pane.terminalRuntimeId === "cli:codex"
        )).toBe(true);
      }
      expect(host.attach).toHaveBeenCalledTimes(21);
      expect(codexCliModeDefaultsService.read).toHaveBeenCalledTimes(6);
    } finally {
      await app.close();
    }
  });

  it("fails closed before stress room creation when mini/low is unavailable and requires ADMIN", async () => {
    const store = new InMemorySpaceStore();
    const host = readyHostClient();
    const unavailableCatalog = activeAgentCatalogService({ advertised: false });
    const { app, cookie, csrfToken } = await authedApp({
      store,
      cliHostClient: host.client,
      codexCliModeDefaultsService: unavailableCatalog,
      config: await enabledProofConfig()
    });

    try {
      const unavailable = await app.inject({
        method: "POST",
        url: "/api/proof-rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { profile: "ACTIVE_AGENT_STRESS", paneCount: 1 }
      });
      expect(unavailable.statusCode).toBe(503);
      expect(store.listRooms()).toEqual([]);
      expect(host.attach).not.toHaveBeenCalled();

      const forbidden = await app.inject({
        method: "POST",
        url: "/api/proof-rooms",
        headers: signedHeaders("OPERATOR"),
        payload: { profile: "ACTIVE_AGENT_STRESS", paneCount: 1 }
      });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json().error.code).toBe("ADMIN_REQUIRED");
      expect(store.listRooms()).toEqual([]);
      expect(unavailableCatalog.read).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("creates the proof room after transport attach while the isolated Codex prompt is still warming", async () => {
    const store = new InMemorySpaceStore();
    const workspace = store.createRoom({ name: "Operator workspace", initialPaneCount: 0 }, "trace:workspace");
    const host = readyHostClient({ replayReady: false });
    const { app, cookie, csrfToken } = await authedApp({
      store,
      cliHostClient: host.client,
      config: await enabledProofConfig()
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/proof-rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneCount: 1, roomLabel: "Slow isolated startup" }
      });

      expect(response.statusCode).toBe(201);
      const proof = proofRoomSchema.parse(response.json());
      expect(proof.room.kind).toBe("AGENT_PROOF");
      expect(proof.panes).toHaveLength(1);
      expect(proof.sessionIds).toHaveLength(1);
      expect(host.attach).toHaveBeenCalledTimes(1);
      expect(store.listPanes(workspace.id)).toEqual([]);
      expect(store.getActivePaneCliSession(proof.panes[0]!.id)).toMatchObject({
        roomId: proof.room.id,
        paneId: proof.panes[0]!.id,
        status: "RUNNING"
      });
    } finally {
      await app.close();
    }
  });

  it("sends only fixed idempotent story cycles to the exact stress-room pane set", async () => {
    const store = new InMemorySpaceStore();
    const workspace = store.createRoom({ name: "Operator workspace", initialPaneCount: 0 }, "trace:workspace");
    const host = readyHostClient();
    const codexCliModeDefaultsService = activeAgentCatalogService();
    const { app, cookie, csrfToken } = await authedApp({
      store,
      cliHostClient: host.client,
      codexCliModeDefaultsService,
      config: await enabledProofConfig()
    });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/proof-rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { profile: "ACTIVE_AGENT_STRESS", paneCount: 2, roomLabel: "Fixed turns" }
      });
      const proof = proofRoomSchema.parse(created.json());
      const paneIds = proof.panes.map((pane) => pane.id);
      const standardCreated = await app.inject({
        method: "POST",
        url: "/api/proof-rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneCount: 1, roomLabel: "Standard" }
      });
      const standardProof = proofRoomSchema.parse(standardCreated.json());
      const initialInputCallCount = host.input.mock.calls.length;

      const first = await app.inject({
        method: "POST",
        url: `/api/proof-rooms/${encodeURIComponent(proof.room.id)}/active-agent-turns`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneIds, cycle: 0 }
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({
        roomId: proof.room.id,
        paneIds,
        cycle: 0,
        acceptedCount: 2
      });
      expect(first.json()).not.toHaveProperty("prompt");
      expect(first.json()).not.toHaveProperty("sessionIds");

      const firstTurnCalls = host.input.mock.calls.slice(initialInputCallCount);
      expect(firstTurnCalls).toHaveLength(4);
      const firstPrompts = firstTurnCalls.filter((call) => call[2] !== "\r");
      const firstSubmits = firstTurnCalls.filter((call) => call[2] === "\r");
      expect(firstPrompts).toHaveLength(2);
      expect(new Set(firstPrompts.map((call) => call[2])).size).toBe(1);
      expect(firstPrompts[0]?.[2]).toContain("fictional story");
      expect(firstSubmits).toHaveLength(2);
      expect(firstTurnCalls.every((call) =>
        typeof call[4] === "string" &&
        call[4].startsWith(`active-agent-stress:${proof.room.id}:`)
      )).toBe(true);

      const retried = await app.inject({
        method: "POST",
        url: `/api/proof-rooms/${encodeURIComponent(proof.room.id)}/active-agent-turns`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneIds, cycle: 0 }
      });
      expect(retried.statusCode).toBe(200);
      const retryCalls = host.input.mock.calls.slice(initialInputCallCount + firstTurnCalls.length);
      expect(retryCalls.map((call) => call[4]).sort()).toEqual(firstTurnCalls.map((call) => call[4]).sort());

      const callerPrompt = await app.inject({
        method: "POST",
        url: `/api/proof-rooms/${encodeURIComponent(proof.room.id)}/active-agent-turns`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneIds, cycle: 1, prompt: "caller controlled" }
      });
      expect(callerPrompt.statusCode).toBe(422);

      const wrongPaneSet = await app.inject({
        method: "POST",
        url: `/api/proof-rooms/${encodeURIComponent(proof.room.id)}/active-agent-turns`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneIds: paneIds.slice(0, 1), cycle: 1 }
      });
      expect(wrongPaneSet.statusCode).toBe(409);

      const workspaceTarget = await app.inject({
        method: "POST",
        url: `/api/proof-rooms/${encodeURIComponent(workspace.id)}/active-agent-turns`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneIds, cycle: 1 }
      });
      expect(workspaceTarget.statusCode).toBe(404);

      const standardTarget = await app.inject({
        method: "POST",
        url: `/api/proof-rooms/${encodeURIComponent(standardProof.room.id)}/active-agent-turns`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneIds: standardProof.panes.map((pane) => pane.id), cycle: 1 }
      });
      expect(standardTarget.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("rechecks the advertised mini/low model before every active-agent turn cycle", async () => {
    const store = new InMemorySpaceStore();
    const host = readyHostClient();
    const codexCliModeDefaultsService = activeAgentCatalogService();
    const { app, cookie, csrfToken } = await authedApp({
      store,
      cliHostClient: host.client,
      codexCliModeDefaultsService,
      config: await enabledProofConfig()
    });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/proof-rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { profile: "ACTIVE_AGENT_STRESS", paneCount: 1 }
      });
      const proof = proofRoomSchema.parse(created.json());
      vi.mocked(codexCliModeDefaultsService.read).mockImplementation(
        activeAgentCatalogService({ advertised: false }).read
      );
      const inputCallsBefore = host.input.mock.calls.length;

      const response = await app.inject({
        method: "POST",
        url: `/api/proof-rooms/${encodeURIComponent(proof.room.id)}/active-agent-turns`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneIds: proof.panes.map((pane) => pane.id), cycle: 0 }
      });

      expect(response.statusCode).toBe(503);
      expect(host.input.mock.calls).toHaveLength(inputCallsBefore);
    } finally {
      await app.close();
    }
  });

  it("rate limits high-cost stress room creation and active-agent turn dispatch", async () => {
    const store = new InMemorySpaceStore();
    const host = readyHostClient();
    const { app, cookie, csrfToken } = await authedApp({
      store,
      cliHostClient: host.client,
      codexCliModeDefaultsService: activeAgentCatalogService(),
      config: await enabledProofConfig()
    });

    try {
      const createdRooms = [];
      for (let attempt = 0; attempt < 16; attempt += 1) {
        createdRooms.push(await app.inject({
          method: "POST",
          url: "/api/proof-rooms",
          headers: { cookie, [csrfHeaderName]: csrfToken },
          payload: { profile: "ACTIVE_AGENT_STRESS", paneCount: 1 }
        }));
      }
      expect(createdRooms.every((response) => response.statusCode === 201)).toBe(true);
      const createLimited = await app.inject({
        method: "POST",
        url: "/api/proof-rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { profile: "ACTIVE_AGENT_STRESS", paneCount: 1 }
      });
      expect(createLimited.statusCode).toBe(429);

      const proof = proofRoomSchema.parse(createdRooms[0]!.json());
      const paneIds = proof.panes.map((pane) => pane.id);
      const turns = [];
      for (let attempt = 0; attempt < 30; attempt += 1) {
        turns.push(await app.inject({
          method: "POST",
          url: `/api/proof-rooms/${encodeURIComponent(proof.room.id)}/active-agent-turns`,
          headers: { cookie, [csrfHeaderName]: csrfToken },
          payload: { paneIds, cycle: attempt % 4 }
        }));
      }
      expect(turns.every((response) => response.statusCode === 200)).toBe(true);
      const turnsLimited = await app.inject({
        method: "POST",
        url: `/api/proof-rooms/${encodeURIComponent(proof.room.id)}/active-agent-turns`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { paneIds, cycle: 0 }
      });
      expect(turnsLimited.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("rolls back only the incomplete proof room and its sessions when setup fails", async () => {
    const store = new InMemorySpaceStore();
    const workspace = store.createRoom({ name: "Keep me", initialPaneCount: 1 }, "trace:workspace");
    const host = readyHostClient({ failAttachAt: 2 });
    const { app, cookie, csrfToken } = await authedApp({
      store,
      cliHostClient: host.client,
      codexCliModeDefaultsService: activeAgentCatalogService(),
      config: await enabledProofConfig()
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/proof-rooms",
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: {
          profile: "ACTIVE_AGENT_STRESS",
          paneCount: 2,
          roomLabel: "Broken setup"
        }
      });

      expect(response.statusCode).toBe(500);
      expect(store.listRooms()).toEqual([expect.objectContaining({ id: workspace.id, kind: "WORKSPACE" })]);
      expect(store.listPanes(workspace.id)).toHaveLength(1);
      expect(host.terminate).toHaveBeenCalledTimes(2);
      const terminatedRoomIds = host.terminate.mock.calls.map(([identity]) => identity.roomId);
      expect(new Set(terminatedRoomIds).size).toBe(1);
      expect(terminatedRoomIds).not.toContain(workspace.id);
    } finally {
      await app.close();
    }
  });
});
