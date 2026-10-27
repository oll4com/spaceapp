import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { CliHostClient, CliHostSessionRegistry, createCliHostServer, spawnNodePty } from "@space/cli-host";
import type { Pane } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { createCliPaneReopener } from "../src/cli-pane-reopen.js";
import { getApiConfig } from "../src/config.js";

const sessionSecret = "cli-pane-reopen-test-secret";
const csrfHeaderName = "x-space-csrf-token";
const claudeConversationId = "77788aa8-aa3d-49f8-aa75-bc8969b9f077";
const apps: FastifyInstance[] = [];
const roots: string[] = [];

afterEach(async () => {
  try { await Promise.all(apps.splice(0).map((app) => app.close())); }
  finally { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); }
});

function adminHeaders() {
  const session = signSession({ id: "user:admin", email: "admin@space.local", role: "ADMIN" }, sessionSecret);
  return { cookie: `space_session=${session}`, [csrfHeaderName]: createCsrfToken(session, sessionSecret)! };
}

async function setup(store: InMemorySpaceStore) {
  const root = await mkdtemp(join(tmpdir(), "space-cli-pane-reopen-"));
  roots.push(root);
  const commandPath = join(root, "claude-vscode-parity");
  await writeFile(commandPath, "#!/bin/sh\nprintf 'claude-args:%s\\n' \"$*\"\n", "utf8");
  await chmod(commandPath, 0o755);
  // An owned pane host; the operator's live host is never contacted.
  const socketPath = join(root, "pane-host.sock");
  // Unix socket paths hold about 104-107 bytes: a long TMPDIR fails here, not later as ENOENT or EADDRINUSE (1.1.7 review).
  if (socketPath.length > 103) throw new Error(`TMPDIR is too long for a Unix socket path (${socketPath.length} bytes); use a short TMPDIR such as /tmp/s.`);
  const cliHostServer = await createCliHostServer({ socketPath, registry: new CliHostSessionRegistry({ spawn: spawnNodePty }) });
  const app = await createApp({
    cliHostClient: new CliHostClient({ socketPath }),
    store,
    config: getApiConfig({
      SPACE_ARTIFACT_ROOT: join(root, "artifacts"),
      SPACE_CLI_ENABLED: "true",
      SPACE_CLI_COMMAND_PATH: root,
      SPACE_CLI_CLAUDE_CREDENTIAL_SMOKE: "true",
      SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces")
    }),
    auth: { sessionSecret, devLogin: false, secureCookies: false }
  });
  app.addHook("onClose", async () => { await cliHostServer.close(); });
  apps.push(app);
  return app;
}

/** A Claude pane whose CLI was killed; `close` closes it the way a runtime disable does. */
function claudePane(
  store: InMemorySpaceStore,
  nativeTaskRef: string | null,
  room = store.createRoom({ name: "Reopen", initialPaneCount: 0 })
) {
  const pane = store.createPane({ roomId: room.id, title: "Claude Code CLI", mode: "TERMINAL", terminalRuntimeId: "cli:claude", cwd: "/etc" });
  const session = store.createPaneCliSession({
    paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "anthropic", agentId: "claude",
    modelId: null, reasoningEffort: "medium", launchMode: "FRESH", cwd: "/etc",
    status: "RUNNING", statusReason: "Running.", isActive: true
  });
  if (nativeTaskRef) store.updateCliTaskRevision(session.cliTaskRevisionId!, { nativeTaskRef });
  store.updatePaneCliSession(session.sessionId, {
    status: "EXITED", statusReason: "CLI process exited by signal 9.", exitCode: null, isActive: false, endedAt: new Date().toISOString()
  });
  const close = () => store.updatePane(pane.id, { isClosed: true, status: "CLOSED" });
  return { room, pane, session, close };
}

describe("reopening a CLI pane", () => {
  it("resumes the pane's exact Claude conversation, so it opens working instead of an empty terminal", async () => {
    const store = new InMemorySpaceStore();
    const { pane, session, close } = claudePane(store, claudeConversationId);
    close();
    const app = await setup(store);
    const headers = adminHeaders();

    const reopened = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}`,
      headers,
      payload: { isClosed: false, isMinimized: false, status: "IDLE" }
    });

    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toMatchObject({ id: pane.id, isClosed: false });
    const resumed = store.getActivePaneCliSession(pane.id);
    expect(resumed).toMatchObject({ runtimeId: "cli:claude", launchMode: "RESUME", cliTaskId: session.cliTaskId, isActive: true });
    expect(store.getCliTaskRevision(resumed!.cliTaskRevisionId!)?.nativeTaskRef).toBe(claudeConversationId);

    const active = await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(pane.id)}/cli/session`, headers });
    expect(active.statusCode).toBe(200);
    expect(active.json()?.session?.sessionId).toBe(resumed!.sessionId);
  });

  it("opens the pane as before, with Reconnect, when the conversation cannot be resumed exactly", async () => {
    const store = new InMemorySpaceStore();
    const { pane, close } = claudePane(store, null);
    close();
    const app = await setup(store);

    const reopened = await app.inject({
      method: "PATCH",
      url: `/api/panes/${encodeURIComponent(pane.id)}`,
      headers: adminHeaders(),
      payload: { isClosed: false, isMinimized: false, status: "IDLE" }
    });

    expect(reopened.statusCode).toBe(200);
    expect(store.getPane(pane.id).isClosed).toBe(false);
    expect(store.getActivePaneCliSession(pane.id)).toBeNull();
  });
});

describe("re-enabling a CLI runtime", () => {
  it("reopens the panes its disable closed, in their order, each resumed in its own conversation", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Disabled by mistake", initialPaneCount: 0 });
    const first = claudePane(store, claudeConversationId, room);
    const second = claudePane(store, "69495730-93c9-46bc-ae9b-47c6e85e7245", room);
    first.close();
    second.close();
    const openedLater = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
    store.updateCliRuntimeSetting("cli:claude", { enabled: false, confirmationToken: "f".repeat(32) }, "user:admin");
    store.recordAuditEvent({
      actorUserId: "user:admin",
      traceId: "trace:disable-claude",
      action: "cli.runtime.setting.update",
      targetType: "cli_runtime",
      targetId: "cli:claude",
      metadata: { enabled: false, cleanup: { closedPaneIds: [second.pane.id, first.pane.id] } }
    });
    const app = await setup(store);

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/cli/runtime-settings/cli:claude",
      headers: adminHeaders(),
      payload: { enabled: true }
    });

    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().restoredPaneIds).toEqual([first.pane.id, second.pane.id]);
    await vi.waitFor(() => {
      for (const { pane, session } of [first, second]) {
        expect(store.getActivePaneCliSession(pane.id)).toMatchObject({ launchMode: "RESUME", cliTaskId: session.cliTaskId });
      }
    });
    const order = store.listPanes(room.id, false).map((pane) => pane.id);
    expect(order).toEqual([openedLater.id, first.pane.id, second.pane.id]);
  });
});

describe("CLI pane reopener", () => {
  const pane = { id: "pane:reopen-unit" } as Pane;

  it("lets a session read wait for the resume that a reopen started", async () => {
    let finishResume!: (resumed: boolean) => void;
    const reopener = createCliPaneReopener({ resume: () => new Promise<boolean>((resolve) => { finishResume = resolve; }) });
    const { resumed } = reopener.reopen(pane.id, async () => pane, "trace:reopen");
    let settled = false;
    const read = reopener.settled(pane.id).then(() => { settled = true; });
    await vi.waitFor(() => expect(finishResume).toBeTypeOf("function"));
    expect(settled).toBe(false);
    finishResume(true);
    await read;
    await expect(resumed).resolves.toBe(true);
    await expect(reopener.settled(pane.id, 1)).resolves.toBeUndefined();
  });

  it("bounds the wait and reports resume failures without failing the reopen", async () => {
    const onResumeError = vi.fn();
    const stuck = createCliPaneReopener({ resume: () => new Promise<boolean>(() => undefined) });
    stuck.reopen(pane.id, () => pane, "trace:reopen");
    await expect(stuck.settled(pane.id, 5)).resolves.toBeUndefined();

    const failing = createCliPaneReopener({ resume: async () => { throw new Error("no exact resume"); }, onResumeError });
    const reopen = failing.reopen(pane.id, () => pane, "trace:reopen");
    await expect(reopen.pane).resolves.toBe(pane);
    await expect(reopen.resumed).resolves.toBe(false);
    expect(onResumeError).toHaveBeenCalledWith(pane.id, expect.any(Error));

    const closedFails = failing.reopen(pane.id, async () => { throw new Error("room is full"); }, "trace:reopen");
    await expect(closedFails.pane).rejects.toThrow("room is full");
    await expect(closedFails.resumed).resolves.toBe(false);
    expect(onResumeError).toHaveBeenCalledTimes(1);
  });
});

describe("a new Job Copilot pane", () => {
  /** A closed Job Copilot pane whose Claude conversation has an exact native reference. */
  function closedCopilot(store: InMemorySpaceStore, room = store.createRoom({ name: "Jobs", initialPaneCount: 0 })) {
    const pane = store.createPane({ roomId: room.id, title: "Job Copilot 36", mode: "JOB_APPLY", terminalRuntimeId: "cli:claude", cwd: "/etc" });
    const session = store.createPaneCliSession({
      paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "anthropic", agentId: "claude",
      modelId: null, reasoningEffort: "medium", launchMode: "FRESH", cwd: "/etc", status: "RUNNING", statusReason: "Running.", isActive: true
    });
    store.updateCliTaskRevision(session.cliTaskRevisionId!, { nativeTaskRef: claudeConversationId });
    store.updatePaneCliSession(session.sessionId, { status: "EXITED", statusReason: "Pane closed.", exitCode: null, isActive: false, endedAt: new Date().toISOString() });
    store.updatePane(pane.id, { isClosed: true, status: "CLOSED" });
    return { room, pane, session };
  }
  async function openCopilot(app: FastifyInstance, roomId: string) {
    const headers = adminHeaders();
    const created = await app.inject({ method: "POST", url: "/api/panes", headers, payload: { roomId, title: "Job Copilot 10", mode: "JOB_APPLY", terminalRuntimeId: "cli:claude" } });
    expect(created.statusCode, created.body).toBe(200);
    const pane = created.json() as Pane;
    // The terminal reads the active session first; the read waits for the resume the creation started.
    const active = await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(pane.id)}/cli/session`, headers });
    expect(active.statusCode).toBe(200);
    return { pane, active: active.json() as { session?: { sessionId: string } } | null };
  }

  it("continues the previous Job Copilot pane's Claude conversation and keeps its own title", async () => {
    const store = new InMemorySpaceStore();
    const { room, session } = closedCopilot(store);
    const app = await setup(store);
    const { pane, active } = await openCopilot(app, room.id);
    const resumed = store.getActivePaneCliSession(pane.id);
    expect(resumed).toMatchObject({ runtimeId: "cli:claude", launchMode: "RESUME", cliTaskId: session.cliTaskId, isActive: true });
    expect(active?.session?.sessionId).toBe(resumed!.sessionId);
    expect(store.getPane(pane.id).title).toBe("Job Copilot 10");

    // A second new copilot while this one is open does not take the same conversation.
    const second = await openCopilot(app, room.id);
    expect(store.getActivePaneCliSession(second.pane.id)).toBeNull();
    expect(second.active).toBeNull();
  });

  it("starts fresh, as before, when the room has no earlier Job Copilot pane", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Empty", initialPaneCount: 0 });
    const app = await setup(store);
    const { pane, active } = await openCopilot(app, room.id);
    expect(store.getActivePaneCliSession(pane.id)).toBeNull();
    expect(active).toBeNull();
  });
});
