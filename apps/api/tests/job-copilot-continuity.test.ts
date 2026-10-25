import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { CliHostClient, CliHostSessionRegistry, createCliHostServer, spawnNodePty } from "@space/cli-host";
import type { Pane } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";

const conversationId = "5d0b6c3e-27a4-4c35-9d55-0f1d4e2b7a11";
// Claude names its conversation only inside the live process; the host probe stands in for it here.
const nativeTurns = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../src/claude-native-turns.js", async (original) => ({
  ...(await original<typeof import("../src/claude-native-turns.js")>()),
  loadClaudeNativeTurns: vi.fn(async () => nativeTurns.value)
}));

const { createApp } = await import("../src/app.js");
const { createCsrfToken, signSession } = await import("../src/auth.js");
const { getApiConfig } = await import("../src/config.js");

const sessionSecret = "job-copilot-continuity-secret";
const apps: FastifyInstance[] = [];
const roots: string[] = [];

afterEach(async () => {
  nativeTurns.value = null;
  try { await Promise.all(apps.splice(0).map((app) => app.close())); }
  finally { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); }
});

function adminHeaders() {
  const session = signSession({ id: "user:admin", email: "admin@space.local", role: "ADMIN" }, sessionSecret);
  return { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! };
}

async function setup(store: InMemorySpaceStore) {
  const root = await mkdtemp(join(tmpdir(), "space-jcc-"));
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

describe("closing a Job Copilot pane and opening a new one", () => {
  it("records Claude's conversation while it still runs, so the new pane continues it", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Jobs", initialPaneCount: 0 });
    const cody = store.createPane({ roomId: room.id, title: "Job Copilot 10", mode: "JOB_APPLY", terminalRuntimeId: "cli:claude", cwd: "/etc" });
    const running = store.createPaneCliSession({
      paneId: cody.id, roomId: room.id, runtimeId: "cli:claude", providerId: "anthropic", agentId: "claude",
      modelId: null, reasoningEffort: "medium", launchMode: "FRESH", cwd: "/etc", status: "RUNNING", statusReason: "Running.", isActive: true
    });
    // Nothing polls a copilot pane's Claude, so its conversation was never named.
    expect(store.getCliTaskRevision(running.cliTaskRevisionId!)?.nativeTaskRef ?? null).toBeNull();
    const app = await setup(store);
    const headers = adminHeaders();
    nativeTurns.value = { nativeSessionId: conversationId, busy: false, status: null, waitingFor: null, statusUpdatedAt: null, modelId: null, reasoningEffort: null,
      title: null, titleManual: false, tasks: [{ id: "turn:1", title: "Apply to the queued postings", status: "COMPLETED" }] };

    expect((await app.inject({ method: "DELETE", url: `/api/panes/${encodeURIComponent(cody.id)}`, headers })).statusCode).toBe(200);
    expect(store.getCliTaskRevision(running.cliTaskRevisionId!)?.nativeTaskRef).toBe(conversationId);

    nativeTurns.value = null;
    const created = await app.inject({ method: "POST", url: "/api/panes", headers, payload: { roomId: room.id, title: "Job Copilot 11", mode: "JOB_APPLY", terminalRuntimeId: "cli:claude" } });
    expect(created.statusCode, created.body).toBe(200);
    const next = created.json() as Pane;
    const active = await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(next.id)}/cli/session`, headers });
    expect(active.statusCode).toBe(200);
    expect(store.getActivePaneCliSession(next.id)).toMatchObject({ launchMode: "RESUME", cliTaskId: running.cliTaskId, isActive: true });
  });
});
