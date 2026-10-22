import { ownedSystemAnalytics } from "./owned-system-analytics.js";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PANE_CATALOG_VERSION, PANE_TYPES } from "@space/contracts";
import { InMemorySpaceStore, createCanonicalSpaceMemoryBridge } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";

// Full app shutdown waits for background collectors, as in room-pane-counts.
// This suite checks API semantics; it is not a startup latency benchmark.
vi.setConfig({ testTimeout: 30_000 });

const csrfHeaderName = "x-space-csrf-token";
const temporaryRoots: string[] = [];

async function enabledBatchConfig(options: { claudeReady?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "space-pane-batch-"));
  temporaryRoots.push(root);
  for (const command of ["codex-vscode-parity", "opencode-vscode-parity", ...(options.claudeReady ? ["claude-vscode-parity"] : [])]) {
    const path = join(root, command);
    await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(path, 0o755);
  }
  return getApiConfig({
    SPACE_ROOM_PANE_COMMANDS_ENABLED: "true",
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_COMMAND_PATH: root,
    SPACE_CLI_HOST_SOCKET: join(root, "pane-host.sock"),
    SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
    SPACE_CLI_OPENCODE_CREDENTIAL_SMOKE: "true",
    ...(options.claudeReady ? { SPACE_CLI_CLAUDE_CREDENTIAL_SMOKE: "true" } : {}),
    SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces"),
    // Pane account selections go next to the artifacts: never into the live Space's var/.
    SPACE_ARTIFACT_ROOT: join(root, "artifacts")
  });
}

async function authedApp(store: InMemorySpaceStore, configOptions: { claudeReady?: boolean } = {}) {
  const chatModel = { supportsTools: true, stream: vi.fn(async function* () { yield { content: "Ready." }; }) };
  const config = await enabledBatchConfig(configOptions);
  const app = await createApp({
    store,
    canonicalMemory: createCanonicalSpaceMemoryBridge({
      indexPath: "/nonexistent/room-pane-batch-index",
      monthlyPath: "/nonexistent/room-pane-batch-month"
    }),
    systemAnalyticsService: ownedSystemAnalytics(store, config.cliWorkspaceRoot),
    config,
    roomAgentChatModel: chatModel,
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
  return { app, cookie, csrfToken: csrf.json().csrfToken as string, chatModel };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("room pane batch API", () => {
  it("creates an ordered 2 Codex + 3 OpenCode + 3 Chat batch with audit and events", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Mixed proof", projectPath: "/etc", initialPaneCount: 0 }, "trace:room");
    const { app, cookie, csrfToken } = await authedApp(store);

    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/panes`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: {
        panes: [
          { mode: "TERMINAL", terminalRuntimeId: "cli:codex" },
          { mode: "TERMINAL", terminalRuntimeId: "cli:codex" },
          { mode: "TERMINAL", terminalRuntimeId: "cli:opencode" },
          { mode: "TERMINAL", terminalRuntimeId: "cli:opencode" },
          { mode: "TERMINAL", terminalRuntimeId: "cli:opencode" },
          { mode: "CHAT" },
          { mode: "CHAT" },
          { mode: "CHAT" }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ roomId: room.id });
    expect(response.json().data.map((pane: { title: string; order: number; terminalRuntimeId: string | null; cwd: string | null }) => ({
      title: pane.title,
      order: pane.order,
      runtime: pane.terminalRuntimeId,
      cwd: pane.cwd
    }))).toEqual([
      { title: "Codex CLI 1", order: 0, runtime: "cli:codex", cwd: "/etc" },
      { title: "Codex CLI 2", order: 1, runtime: "cli:codex", cwd: "/etc" },
      { title: "OpenCode CLI 3", order: 2, runtime: "cli:opencode", cwd: "/etc" },
      { title: "OpenCode CLI 4", order: 3, runtime: "cli:opencode", cwd: "/etc" },
      { title: "OpenCode CLI 5", order: 4, runtime: "cli:opencode", cwd: "/etc" },
      { title: "Chat 6", order: 5, runtime: null, cwd: null },
      { title: "Chat 7", order: 6, runtime: null, cwd: null },
      { title: "Chat 8", order: 7, runtime: null, cwd: null }
    ]);
    expect(store.listEvents(room.id).filter((event) => event.type === "PANE_CREATED")).toHaveLength(8);
    expect(store.listAuditEvents().find((event) => event.action === "room.panes.create")).toMatchObject({
      action: "room.panes.create",
      targetType: "room",
      targetId: room.id,
      metadata: expect.objectContaining({ paneCount: 8 })
    });
    await app.close();
  });

  it("opens Job Copilot panes on the first ready CLI when Claude Code is not ready, and on a chosen ready CLI", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Jobs proof", projectPath: "/etc", initialPaneCount: 0 }, "trace:room");
    const { app, cookie, csrfToken } = await authedApp(store);
    const submit = (panes: unknown[]) => app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/panes`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { panes }
    });

    const response = await submit([{ mode: "JOB_APPLY" }, { mode: "JOB_APPLY", terminalRuntimeId: "cli:codex" }]);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((pane: { title: string; mode: string; terminalRuntimeId: string | null; cwd: string | null; jobApplyMetadata?: unknown }) => ({
      title: pane.title, mode: pane.mode, runtime: pane.terminalRuntimeId, cwd: pane.cwd, metadata: pane.jobApplyMetadata ?? null
    }))).toEqual([
      { title: "Job Copilot 1", mode: "JOB_APPLY", runtime: "cli:opencode", cwd: null, metadata: null },
      { title: "Job Copilot 2", mode: "JOB_APPLY", runtime: "cli:codex", cwd: null, metadata: null }
    ]);
    // Claude has no wrapper in this fixture, so it is not a ready runtime.
    expect((await submit([{ mode: "JOB_APPLY", terminalRuntimeId: "cli:claude" }])).statusCode).toBe(409);
    expect((await submit([{ mode: "JOB_APPLY", cwd: "/root" }])).statusCode).toBe(422);
    expect(store.listPanes(room.id)).toHaveLength(2);
    await app.close();
  });

  it("opens Mail Copilot panes like Job Copilot: first ready CLI by default, a chosen ready CLI, never a cwd", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Mail proof", projectPath: "/etc", initialPaneCount: 0 }, "trace:room");
    const { app, cookie, csrfToken } = await authedApp(store);
    const submit = (panes: unknown[]) => app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/panes`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { panes }
    });
    const response = await submit([{ mode: "MAIL_COPILOT" }, { mode: "MAIL_COPILOT", terminalRuntimeId: "cli:codex" }]);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((pane: { title: string; mode: string; terminalRuntimeId: string | null; cwd: string | null; mailCopilotMetadata?: unknown }) => ({
      title: pane.title, mode: pane.mode, runtime: pane.terminalRuntimeId, cwd: pane.cwd, metadata: pane.mailCopilotMetadata ?? null
    }))).toEqual([
      { title: "Mail Copilot 1", mode: "MAIL_COPILOT", runtime: "cli:opencode", cwd: null, metadata: null },
      { title: "Mail Copilot 2", mode: "MAIL_COPILOT", runtime: "cli:codex", cwd: null, metadata: null }
    ]);
    expect((await submit([{ mode: "MAIL_COPILOT", terminalRuntimeId: "cli:claude" }])).statusCode).toBe(409);
    expect((await submit([{ mode: "MAIL_COPILOT", cwd: "/root" }])).statusCode).toBe(422);
    // The pane's settings read as Assist defaults until the operator changes them; the view is stamped by the server.
    const paneId = response.json().data[0].id as string;
    const settings = await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(paneId)}/mail-copilot/settings`, headers: { cookie } });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().metadata.settings.autonomy).toBe("ASSIST");
    const updated = await app.inject({ method: "PUT", url: `/api/panes/${encodeURIComponent(paneId)}/mail-copilot/settings`, headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { version: 1, settings: { autonomy: "RULES", accounts: ["me@gmail.com"] } } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().metadata.settings).toMatchObject({ autonomy: "RULES", accounts: ["me@gmail.com"], paused: false });
    const view = await app.inject({ method: "PUT", url: `/api/panes/${encodeURIComponent(paneId)}/mail-copilot/view`, headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { account: "me@gmail.com", labelId: "INBOX", threadId: "thread-1" } });
    expect(view.statusCode).toBe(200);
    expect(view.json().view).toMatchObject({ account: "me@gmail.com", labelId: "INBOX", threadId: "thread-1", messageId: null });
    expect(typeof view.json().view.updatedAt).toBe("string");
    expect(store.getPane(paneId).mailCopilotMetadata?.settings.autonomy).toBe("RULES");
    const other = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
    expect((await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(other.id)}/mail-copilot/settings`, headers: { cookie } })).statusCode).toBe(409);
    await app.close();
  });

  it("opens Marketing Copilot panes like the other copilots and keeps their channel settings on the pane", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Marketing proof", projectPath: "/etc", initialPaneCount: 0 }, "trace:room");
    const { app, cookie, csrfToken } = await authedApp(store);
    const submit = (panes: unknown[]) => app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/panes`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { panes }
    });
    const response = await submit([{ mode: "MARKETING_COPILOT" }]);
    expect(response.statusCode).toBe(200);
    const created = response.json().data[0] as { id: string; title: string; terminalRuntimeId: string | null; cwd: string | null };
    expect({ title: created.title, runtime: created.terminalRuntimeId, cwd: created.cwd }).toEqual({ title: "Marketing Copilot 1", runtime: "cli:opencode", cwd: null });
    expect((await submit([{ mode: "MARKETING_COPILOT", cwd: "/root" }])).statusCode).toBe(422);
    const url = `/api/panes/${encodeURIComponent(created.id)}/marketing-copilot/settings`;
    const settings = await app.inject({ method: "GET", url, headers: { cookie } });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().metadata.settings).toMatchObject({ autonomy: "ASSIST", channels: { HACKER_NEWS: { enabled: true, autonomyCap: "ASSIST", posts: 1, perDays: 7 } } });
    const updated = await app.inject({ method: "PUT", url, headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { version: 1, settings: { autonomy: "FULL", channels: { REDDIT: { enabled: false, autonomyCap: "ASSIST", posts: 1, perDays: 7 } } } } });
    expect(updated.statusCode).toBe(200);
    // Channels the client did not name keep their defaults.
    expect(updated.json().metadata.settings.channels.REDDIT.enabled).toBe(false);
    expect(updated.json().metadata.settings.channels.X).toEqual({ enabled: true, autonomyCap: "FULL", posts: 3, perDays: 1 });
    expect(store.getPane(created.id).marketingCopilotMetadata?.settings.autonomy).toBe("FULL");
    expect((await app.inject({ method: "PUT", url, headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { version: 1, settings: { channels: { MASTODON: { enabled: true } } } } })).statusCode).toBe(422);
    const other = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
    expect((await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(other.id)}/marketing-copilot/settings`, headers: { cookie } })).statusCode).toBe(409);
    await app.close();
  });

  it("opens Design panes with Claude Code as the designer, no cwd and no browser, like the copilots", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Design proof", projectPath: "/etc", initialPaneCount: 0 }, "trace:room");
    const { app, cookie, csrfToken } = await authedApp(store, { claudeReady: true });
    const submit = (panes: unknown[]) => app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/panes`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { panes }
    });
    const response = await submit([{ mode: "DESIGN" }, { mode: "DESIGN", terminalRuntimeId: "cli:codex" }]);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((pane: { title: string; mode: string; terminalRuntimeId: string | null; cwd: string | null; designMetadata?: unknown }) => ({
      title: pane.title, mode: pane.mode, runtime: pane.terminalRuntimeId, cwd: pane.cwd, metadata: pane.designMetadata ?? null
    }))).toEqual([
      { title: "Design 1", mode: "DESIGN", runtime: "cli:claude", cwd: null, metadata: null },
      { title: "Design 2", mode: "DESIGN", runtime: "cli:codex", cwd: null, metadata: null }
    ]);
    expect((await submit([{ mode: "DESIGN", cwd: "/root" }])).statusCode).toBe(422);
    expect((await submit([{ mode: "DESIGN", terminalRuntimeId: "cli:gemini" }])).statusCode).toBe(409);
    await app.close();
  });

  it("opens App Studio panes with Claude Code as the app builder, no cwd and no browser, like the copilots", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "App Studio proof", projectPath: "/etc", initialPaneCount: 0 }, "trace:room");
    const { app, cookie, csrfToken } = await authedApp(store, { claudeReady: true });
    const submit = (panes: unknown[]) => app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/panes`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { panes }
    });
    const response = await submit([{ mode: "APP_STUDIO" }, { mode: "APP_STUDIO", terminalRuntimeId: "cli:codex" }]);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((pane: { title: string; mode: string; terminalRuntimeId: string | null; cwd: string | null; appStudioMetadata?: unknown }) => ({
      title: pane.title, mode: pane.mode, runtime: pane.terminalRuntimeId, cwd: pane.cwd, metadata: pane.appStudioMetadata ?? null
    }))).toEqual([
      { title: "App Studio 1", mode: "APP_STUDIO", runtime: "cli:claude", cwd: null, metadata: null },
      { title: "App Studio 2", mode: "APP_STUDIO", runtime: "cli:codex", cwd: null, metadata: null }
    ]);
    expect((await submit([{ mode: "APP_STUDIO", cwd: "/root" }])).statusCode).toBe(422);
    expect((await submit([{ mode: "APP_STUDIO", terminalRuntimeId: "cli:gemini" }])).statusCode).toBe(409);
    await app.close();
  });

  it("accepts the account a Job Copilot pane's CLI starts on without writing it to the pane row, and rejects an unknown one", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Jobs account", projectPath: "/etc", initialPaneCount: 0 }, "trace:room");
    store.createCliAccountProfile("cli:claude", { runtimeId: "cli:claude", profileId: "work", displayName: "Work" }, "user:operator");
    const { app, cookie, csrfToken } = await authedApp(store, { claudeReady: true });
    const submit = (panes: unknown[]) => app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/panes`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { panes }
    });
    const response = await submit([
      { mode: "JOB_APPLY", terminalRuntimeId: "cli:claude", accountProfileId: "work" },
      // Codex has no account profiles (its panes run on the Space Gateway pool): nothing to keep.
      { mode: "JOB_APPLY", terminalRuntimeId: "cli:codex", accountProfileId: "work" }
    ]);
    expect(response.statusCode).toBe(200);
    // The Browser Host parses pane rows with the contracts it started with: the account never lands in the row.
    const [claude, codex] = response.json().data as Array<{ id: string; jobApplyMetadata?: unknown }>;
    expect(store.getPane(claude!.id).jobApplyMetadata ?? null).toBeNull();
    expect(store.getPane(codex!.id).jobApplyMetadata ?? null).toBeNull();
    const missing = await submit([{ mode: "JOB_APPLY", terminalRuntimeId: "cli:claude", accountProfileId: "personal" }]);
    expect(missing.statusCode).toBe(409);
    expect(store.listPanes(room.id)).toHaveLength(2);
    await app.close();
  });

  it("prefers Claude Code for Job Copilot panes when it is ready, even though OpenCode leads the catalog", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Jobs claude", projectPath: "/etc", initialPaneCount: 0 }, "trace:room");
    const { app, cookie, csrfToken } = await authedApp(store, { claudeReady: true });
    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/panes`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { panes: [{ mode: "JOB_APPLY" }, { mode: "JOB_APPLY", terminalRuntimeId: "cli:opencode" }, { mode: "TERMINAL", terminalRuntimeId: "cli:opencode" }] }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((pane: { title: string; terminalRuntimeId: string | null }) => [pane.title, pane.terminalRuntimeId])).toEqual([
      ["Job Copilot 1", "cli:claude"],
      ["Job Copilot 2", "cli:opencode"],
      ["OpenCode CLI 3", "cli:opencode"]
    ]);
    await app.close();
  });

  it("rejects root, unavailable, and invalid runtime combinations without writes", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Rejected", initialPaneCount: 0 }, "trace:room");
    const { app, cookie, csrfToken } = await authedApp(store);
    const submit = (panes: unknown[]) => app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/panes`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { panes }
    });

    expect((await submit([{ mode: "TERMINAL", terminalRuntimeId: "cli:root" }])).statusCode).toBe(409);
    expect((await submit([{ mode: "TERMINAL", terminalRuntimeId: "cli:claude" }])).statusCode).toBe(409);
    expect((await submit([{ mode: "TERMINAL", terminalRuntimeId: "cli:missing" }])).statusCode).toBe(409);
    expect((await submit([{ mode: "CHAT", terminalRuntimeId: "cli:codex" }])).statusCode).toBe(422);
    expect(store.listPanes(room.id)).toEqual([]);
    expect(store.listEvents(room.id).filter((event) => event.type === "PANE_CREATED")).toEqual([]);
    await app.close();
  });

  it("rejects capacity overflow atomically", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Full", initialPaneCount: 15 }, "trace:room");
    const { app, cookie, csrfToken } = await authedApp(store);
    const beforeEvents = store.listEvents(room.id).length;

    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${encodeURIComponent(room.id)}/panes`,
      headers: { cookie, [csrfHeaderName]: csrfToken },
      payload: { panes: [{ mode: "CHAT" }, { mode: "CHAT" }] }
    });

    expect(response.statusCode).toBe(409);
    expect(store.listPanes(room.id)).toHaveLength(15);
    expect(store.listEvents(room.id)).toHaveLength(beforeEvents);
    await app.close();
  });
});

describe("durable room pane command API", () => {
  it("replays concurrent mixed requests, rejects changed payloads, and preserves defaults", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Command proof", kind: "AGENT_PROOF", initialPaneCount: 0 });
    const { app, cookie, csrfToken } = await authedApp(store);
    try {
      const catalog = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/pane-catalog`, headers: { cookie } });
      expect(catalog.statusCode).toBe(200);
      // One entry per shared pane type; the catalog grows as pane types are added.
      expect(catalog.json().data).toHaveLength(PANE_TYPES.length);
      expect(catalog.json().data.every((entry: { preparedCount: number }) => entry.preparedCount === 0)).toBe(true);
      const payload = { requestId: "command:first", catalogVersion: PANE_CATALOG_VERSION,
        action: { type: "OPEN_PANES", counts: { codex: 2, browser: 1, youtube: 1, vnc: 1, chat: 1 } } };
      const submit = (body: unknown) => app.inject({ method: "POST", url: `/api/rooms/${room.id}/commands`,
        headers: { cookie, [csrfHeaderName]: csrfToken }, payload: body });
      const results = await Promise.all([submit(payload), submit(payload)]);
      expect(results.map(result => result.statusCode)).toEqual([200, 200]);
      expect(results[0]!.json()).toEqual(results[1]!.json());
      expect(store.listPanes(room.id)).toHaveLength(6);
      const panes = results[0]!.json().data;
      expect(panes.find((pane: { mode: string }) => pane.mode === "VNC").vncTarget).toBeNull();
      expect(panes.filter((pane: { mode: string }) => pane.mode === "TERMINAL").every((pane: { modelId: string | null }) => pane.modelId === null)).toBe(true);
      expect((await submit({ ...payload, action: { type: "OPEN_PANES", counts: { codex: 3 } } })).statusCode).toBe(409);
      expect((await submit({ ...payload, requestId: "command:bad", action: { type: "OPEN_PANES", counts: { codex: 1, claude: 1 } } })).statusCode).toBe(409);
      expect((await submit({ ...payload, requestId: "command:full", action: { type: "OPEN_PANES", counts: { codex: 16 } } })).statusCode).toBe(409);
      expect(store.listPanes(room.id)).toHaveLength(6);
      expect((await app.inject({ method: "POST", url: `/api/rooms/${room.id}/commands`, payload })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: `/api/rooms/${room.id}/commands`, headers: { cookie }, payload })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});


it("connects a complete pane phrase on the Room Agent message endpoint to the batch executor without a model", async () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Agent Proof direct endpoint", kind: "AGENT_PROOF", initialPaneCount: 0 });
  const { app, cookie, csrfToken, chatModel } = await authedApp(store);
  try {
    const submit = (content: string) => app.inject({ method: "POST", url: `/api/rooms/${room.id}/room-agent/messages`,
      headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { content, clientRequestId: "direct:endpoint" } });
    const first = await submit("άνοιξε 2 codex panes");
    expect(first.statusCode).toBe(202);
    expect(first.json().directCommand.status).toBe("COMPLETED");
    expect(store.listPanes(room.id)).toHaveLength(2);
    expect((await submit("άνοιξε 2 codex panes")).json().directCommand.status).toBe("REPLAYED");
    expect((await submit("A different request")).statusCode).toBe(409);
    expect(chatModel.stream).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

it("executes typed playback without the mini router and exposes authenticated acknowledgment", async () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Agent Proof typed commands", kind: "AGENT_PROOF", initialPaneCount: 0 });
  const { app, cookie, csrfToken, chatModel } = await authedApp(store);
  try {
    const payload = { requestId: "command:playback", catalogVersion: PANE_CATALOG_VERSION,
      action: { type: "PLAYBACK", action: "NEXT", target: "AUTO" } };
    const submit = (body: unknown) => app.inject({ method: "POST", url: `/api/rooms/${room.id}/commands`,
      headers: { cookie, [csrfHeaderName]: csrfToken }, payload: body });
    expect((await submit(payload)).json().directCommand).toMatchObject({ status: "CLIENT_PENDING", music: { action: "NEXT" } });
    expect((await submit(payload)).json().directCommand.music).toBeUndefined();
    expect((await submit({ ...payload, action: { type: "OPEN_PANES", counts: { codex: 1 } } })).statusCode).toBe(409);
    const ack = await app.inject({ method: "POST", url: `/api/rooms/${room.id}/commands/${payload.requestId}/ack`,
      headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { ok: true } });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().messages.some((message: { content: string }) => message.content === "Playback control applied.")).toBe(true);
    expect(chatModel.stream).not.toHaveBeenCalled();
    expect(store.listPanes(room.id)).toHaveLength(0);
  } finally { await app.close(); }
});
