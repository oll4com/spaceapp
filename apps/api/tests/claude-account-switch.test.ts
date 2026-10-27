import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { CliHostClient, CliHostSessionRegistry, createCliHostServer, spawnNodePty } from "@space/cli-host";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

// Operator order 2026-10-19: Nous moves a Claude Code pane between its direct account and Space Gateway through Space Control
// configure {accountProfileId}, keeping the same conversation, only at an idle prompt.
const sessionSecret = "claude-account-switch-test-secret";
const conversation = "5f0c2d1e-8a4b-4c3d-9e2f-1a2b3c4d5e6f";
const apps: FastifyInstance[] = [];
const roots: string[] = [];

afterEach(async () => {
  try { await Promise.all(apps.splice(0).map((app) => app.close())); }
  finally { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); }
});

const headers = () => {
  const session = signSession({ id: "user:admin", email: "admin@space.local", role: "ADMIN" }, sessionSecret);
  return { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! };
};

async function setup(options: { busy?: boolean; mode?: "TERMINAL" | "DESIGN" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "space-claude-account-switch-"));
  roots.push(root);
  if (options.busy) await writeFile(join(root, "busy"), "", "utf8");
  // The stub CLI prints its arguments, then Claude's idle prompt, or its spinner while a "busy" marker exists; it keeps running.
  await writeFile(join(root, "claude-vscode-parity"), `#!/bin/sh\nprintf 'claude-args:%s\\n' "$*"\n`
    + `if [ -f '${join(root, "busy")}' ]; then printf '\\342\\234\\242 Nesting\\342\\200\\246\\n'; else printf '\\342\\235\\257 \\n'; fi\nexec sleep 60\n`, "utf8");
  await chmod(join(root, "claude-vscode-parity"), 0o755);
  const socketPath = join(root, "pane-host.sock");
  // Unix socket paths hold about 104-107 bytes: a long TMPDIR fails here, not later as ENOENT or EADDRINUSE (1.1.7 review).
  if (socketPath.length > 103) throw new Error(`TMPDIR is too long for a Unix socket path (${socketPath.length} bytes); use a short TMPDIR such as /tmp/s.`);
  const host = await createCliHostServer({ socketPath, registry: new CliHostSessionRegistry({ spawn: spawnNodePty }) });
  const store = new InMemorySpaceStore();
  store.createCliAccountProfile("cli:claude", { runtimeId: "cli:claude", profileId: "space-gateway", displayName: "Space Gateway" }, "user:admin");
  const app = await createApp({
    cliHostClient: new CliHostClient({ socketPath }), store,
    config: getApiConfig({ SPACE_ARTIFACT_ROOT: join(root, "artifacts"), SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root,
      SPACE_CLI_CLAUDE_CREDENTIAL_SMOKE: "true", SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces") }),
    auth: { sessionSecret, devLogin: false, secureCookies: false }
  });
  app.addHook("onClose", async () => { await host.close(); });
  apps.push(app);
  const room = store.createRoom({ name: "Alex", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Paul", mode: "TERMINAL", terminalRuntimeId: "cli:claude", cwd: "/etc" });
  const started = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/cli/session`, headers: headers(),
    payload: { runtimeId: "cli:claude", includeTranscript: false } });
  expect(started.statusCode).toBe(200);
  const first = store.getActivePaneCliSession(pane.id)!;
  // The conversation Claude wrote (recorded on the task revision once a turn exists).
  store.updateCliTaskRevision(first.cliTaskRevisionId!, { nativeTaskRef: conversation });
  const execute = async (requestId: string, action: Record<string, unknown>) => (await app.inject({ method: "POST", url: "/api/control/v1/commands",
    headers: headers(), payload: { roomId: room.id, requestId, waitForCompletion: true, actions: [{ target: { paneIds: [pane.id], state: "OPEN" }, ...action }] } })).json();
  const configure = (accountProfileId: string, when: "NOW" | "AFTER_TURN", requestId: string) =>
    execute(requestId, { kind: "configure", accountProfileId, when });
  // The arguments a session's CLI was launched with, from its own output.
  const launchArgs = async (sessionId: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const output = (await store.listPaneCliTranscriptChunks(sessionId)).map((chunk) => chunk.content).join("");
      const args = /claude-args:([^\r\n]*)/.exec(output);
      if (args) { await new Promise((resolve) => setTimeout(resolve, 300)); return args[1]!.trim(); }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Session ${sessionId} printed no launch arguments.`);
  };
  // Start the allocated CLI the way Space Control starts an active pane session.
  await execute("request:start", { kind: "pane", operation: "reopen" });
  await launchArgs(first.sessionId);
  // Space Control starts only terminal CLIs, so a copilot pane's running CLI is a terminal's that becomes the copilot's.
  if (options.mode) (store as unknown as { panes: Map<string, { mode: string }> }).panes.get(pane.id)!.mode = options.mode;
  return { root, store, app, pane, first, execute, configure, launchArgs };
}

describe("Claude Code pane account switch (Space Control configure accountProfileId)", () => {
  it("moves an idle pane to Space Gateway and back, resuming the same conversation each time", async () => {
    const f = await setup();
    expect(f.first.accountProfileId).toBeNull();
    // panes.update answered COMPLETED and changed nothing; it now names the way that works.
    const update = await f.execute("request:update", { kind: "resource", operation: "panes.update", id: f.pane.id, input: { accountProfileId: "space-gateway" }, target: undefined });
    expect(update.results?.[0]?.detail).toContain("use configure with accountProfileId");

    const toGateway = await f.configure("space-gateway", "NOW", "request:to-gateway");
    expect(toGateway.results?.[0]).toMatchObject({ status: "COMPLETED" });
    const gateway = f.store.getActivePaneCliSession(f.pane.id)!;
    expect(gateway).toMatchObject({ accountProfileId: "space-gateway", cliTaskId: f.first.cliTaskId, isActive: true });
    expect(gateway.sessionId).not.toBe(f.first.sessionId);
    expect(f.store.getPaneCliSession(f.first.sessionId)).toMatchObject({ isActive: false, status: "EXITED" });
    // The CLI restarted on the same conversation.
    expect(await f.launchArgs(gateway.sessionId)).toBe(`--resume ${conversation}`);

    const toDirect = await f.configure("main", "NOW", "request:to-direct");
    expect(toDirect.results?.[0]).toMatchObject({ status: "COMPLETED" });
    const direct = f.store.getActivePaneCliSession(f.pane.id)!;
    expect(direct).toMatchObject({ accountProfileId: null, cliTaskId: f.first.cliTaskId });
    expect(await f.launchArgs(direct.sessionId)).toBe(`--resume ${conversation}`);
  });

  it("refuses NOW on a working pane with the reason, and defers AFTER_TURN until the turn ends", async () => {
    // The stub shows Claude's spinner: the pane is mid-turn.
    const f = await setup({ busy: true });
    const busy = f.store.getActivePaneCliSession(f.pane.id)!;

    const now = await f.configure("space-gateway", "NOW", "request:busy-now");
    expect(now.results?.[0]?.status).toBe("FAILED");
    expect(now.results?.[0]?.detail).toContain("only at an idle prompt (state RUNNING)");
    const later = await f.configure("space-gateway", "AFTER_TURN", "request:busy-after-turn");
    expect(later.results?.[0]).toMatchObject({ status: "PENDING", detail: "Change scheduled after the current native turn." });
    expect(f.store.getActivePaneCliSession(f.pane.id)).toMatchObject({ sessionId: busy.sessionId, accountProfileId: null });
  });

  // Operator order 2026-10-20: a copilot pane's Claude CLI (Design here, also Job, Mail, Marketing, Freelance, App Studio) switches the same way.
  it("switches a copilot pane's Claude CLI on the same conversation and keeps the copilot's title", async () => {
    const f = await setup({ mode: "DESIGN" });
    // Claude's own title for the conversation names the task, not the copilot.
    f.store.updateCliTaskRevision(f.first.cliTaskRevisionId!, { displayTitle: "Make the launch banner" });
    const moved = await f.configure("space-gateway", "NOW", "request:design-to-gateway");
    expect(moved.results?.[0]).toMatchObject({ status: "COMPLETED" });
    const gateway = f.store.getActivePaneCliSession(f.pane.id)!;
    expect(gateway).toMatchObject({ accountProfileId: "space-gateway", cliTaskId: f.first.cliTaskId, isActive: true });
    expect(await f.launchArgs(gateway.sessionId)).toBe(`--resume ${conversation}`);
    expect(f.store.getPane(f.pane.id)).toMatchObject({ title: "Paul", mode: "DESIGN" });
  });

  it("defers a working copilot pane's switch until its turn ends instead of refusing it", async () => {
    const f = await setup({ mode: "DESIGN", busy: true });
    const later = await f.configure("space-gateway", "AFTER_TURN", "request:design-after-turn");
    expect(later.results?.[0]).toMatchObject({ status: "PENDING", detail: "Change scheduled after the current native turn." });
  });
});

describe("switchClaudePaneAccount at a usage limit (Cleo/Dana 2026-10-21)", () => {
  it("says why a limited turn Claude keeps running cannot switch now and when AFTER_TURN fires", async () => {
    const { switchClaudePaneAccount } = await import("../src/claude-account-switch.js");
    const deps = { store: { getCliAccountProfile: async () => ({ id: "space-gateway" }) }, inspect: async () => ({ state: "RUNNING", usageLimited: true }) };
    const refused = switchClaudePaneAccount(deps as never, { id: "pane:dana0001" } as never, { accountProfileId: null } as never, "space-gateway", "trace:1");
    await expect(refused).rejects.toThrow("It waits at its usage limit while Claude keeps the turn running (background agents or shells), so AFTER_TURN fires only when that work ends");
  });
});
