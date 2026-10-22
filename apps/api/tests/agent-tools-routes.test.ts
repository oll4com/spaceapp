import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import type { AgentToolsOptions } from "../src/agent-tools.js";

const sessionSecret = "agent-tools-routes-test-secret";
const csrfHeaderName = "x-space-csrf-token";
const apps: FastifyInstance[] = [];

function authHeaders(role: "OPERATOR" | "ADMIN") {
  const session = signSession(
    { id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role },
    sessionSecret
  );
  return {
    cookie: `space_session=${session}`,
    [csrfHeaderName]: createCsrfToken(session, sessionSecret)!
  };
}

function fixtureOptions(): { options: AgentToolsOptions; root: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-tools-routes-"));
  const codexDir = join(root, ".codex");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(codexDir, "config.toml"),
    [
      "model = \"gpt-5.6\"",
      "",
      "[mcp_servers.space_ops]",
      "command = \"npx\"",
      "args = [\"@space/mcp\"]",
      "",
      "[[skills.config]]",
      "name = \"space-live-ops\"",
      "path = \"/var/lib/spaceapp-user/.codex/skills/space-live-ops\""
    ].join("\n")
  );
  const kimiDir = join(root, "space-kimi");
  mkdirSync(kimiDir, { recursive: true });
  writeFileSync(
    join(kimiDir, "mcp.json"),
    JSON.stringify({ mcpServers: { space_ops: { type: "stdio", command: "npx", args: ["@space/mcp"] } } })
  );
  const skillsRoot = join(root, "skills");
  mkdirSync(join(skillsRoot, "space-live-ops"), { recursive: true });
  writeFileSync(join(skillsRoot, "space-live-ops", "SKILL.md"), "# space-live-ops\n");
  mkdirSync(join(skillsRoot, "mission-control-fast-change"), { recursive: true });
  writeFileSync(join(skillsRoot, "mission-control-fast-change", "SKILL.md"), "# mission-control-fast-change\n");
  const canonicalRoot = join(root, "space-bin");
  mkdirSync(canonicalRoot, { recursive: true });
  return {
    options: {
      baseRoot: root,
      configHome: join(root, ".config/opencode"),
      skillsRoot,
      canonicalRoot
    },
    root
  };
}

async function setup(options?: AgentToolsOptions) {
  const store = new InMemorySpaceStore();
  const app = await createApp({
    store,
    config: getApiConfig({}),
    auth: { sessionSecret, devLogin: false, secureCookies: false },
    agentToolsOptions: options
  });
  apps.push(app);
  return { app, store };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("agent-tools routes", () => {
  it("restores the previous policy after projection failure and permits a recovered save", async () => {
    const { options, root } = fixtureOptions();
    const fs = await import("node:fs/promises");
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "not a directory");
    const { app, store } = await setup({ ...options, canonicalRoot: blocked });
    const payload = { expectedRevision: 0, enabledRuntimeIds: [], overrides: [] };
    const failed = await app.inject({ method: "PUT", url: "/api/agent-tools/policies", headers: authHeaders("ADMIN"), payload });
    expect(failed.statusCode).toBe(500);
    const restored = await store.getToolRoutingState();
    expect(restored.enabledRuntimeIds).toEqual(["cli:codex", "cli:claude"]);
    expect(restored.revision).toBe(2);
    await fs.unlink(blocked);
    await fs.mkdir(blocked);
    const recovered = await app.inject({ method: "PUT", url: "/api/agent-tools/policies", headers: authHeaders("ADMIN"), payload: { ...payload, expectedRevision: 2 } });
    expect(recovered.statusCode).toBe(200);
    expect(JSON.parse(await fs.readFile(join(blocked, "tool-routing-state.json"), "utf8")).revision).toBe(3);
  });

  it("rejects unsupported startup adapters and nonexistent vision-exception sessions", async () => {
    const { app } = await setup(fixtureOptions().options);
    const unsupported = await app.inject({ method: "PUT", url: "/api/agent-tools/policies", headers: authHeaders("ADMIN"),
      payload: { expectedRevision: 0, enabledRuntimeIds: ["cli:opencode"], overrides: [] } });
    expect(unsupported.statusCode).toBe(422);
    const missing = await app.inject({ method: "POST", url: "/api/agent-tools/vision-exceptions", headers: authHeaders("ADMIN"),
      payload: { runtimeId: "cli:codex", modelId: "gpt-6-astra", sessionId: "cli_session:missing", turnId: "turn:missing", expectedRevision: 0 } });
    expect(missing.statusCode).toBe(409);
  });
  it("plans Claude Code startup without MCP and with native vision, like Codex", async () => {
    const { app } = await setup(fixtureOptions().options);
    const effective = await app.inject({ method: "GET", url: "/api/agent-tools/effective?runtimeId=cli%3Aclaude&modelId=unknown", headers: authHeaders("ADMIN") });
    expect(effective.statusCode, effective.body).toBe(200);
    expect(effective.json()).toMatchObject({ managed: true, registration: "NONE" });
    expect(effective.json().routes.find((entry: { toolId: string }) => entry.toolId === "mcp:space_vision").route).toBe("NATIVE");
  });
  it("saves routing with optimistic concurrency and projects it for CLI consumers", async () => {
    const { options, root } = fixtureOptions();
    const { app, store } = await setup(options);
    const input = { expectedRevision: 0, enabledRuntimeIds: ["cli:codex"], overrides: [
      { toolId: "mcp:vision", runtimeId: "cli:codex", modelId: "*", mode: "NATIVE_ONLY" }
    ] };
    const denied = await app.inject({ method: "PUT", url: "/api/agent-tools/policies", headers: authHeaders("OPERATOR"), payload: input });
    expect(denied.statusCode).toBe(403);
    const saved = await app.inject({ method: "PUT", url: "/api/agent-tools/policies", headers: authHeaders("ADMIN"), payload: input });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().revision).toBe(1);
    expect((await store.getToolRoutingState()).overrides[0]?.mode).toBe("NATIVE_ONLY");
    const fs = await import("node:fs/promises");
    const projection = JSON.parse(await fs.readFile(join(root, "space-bin/tool-routing-state.json"), "utf8"));
    expect(projection.revision).toBe(1);
    const conflict = await app.inject({ method: "PUT", url: "/api/agent-tools/policies", headers: authHeaders("ADMIN"), payload: input });
    expect(conflict.statusCode).toBe(409);
    const effective = await app.inject({ method: "GET", url: "/api/agent-tools/effective?runtimeId=cli%3Acodex&modelId=unknown", headers: authHeaders("ADMIN") });
    expect(effective.statusCode).toBe(200);
    expect(effective.json().routes.find((entry: { toolId: string }) => entry.toolId === "mcp:space_vision").route).toBe("UNAVAILABLE");
  });

  it("does not start tools or expose credentials when listing model capabilities", async () => {
    const { options, root } = fixtureOptions();
    writeFileSync(join(root, ".codex/models_cache.json"), JSON.stringify({
      fetched_at: "2026-09-05T10:00:00Z",
      models: [{ slug: "gpt-6-astra", input_modalities: ["text", "image"], shell_type: "unified_exec", secret: "DO_NOT_EXPOSE" }]
    }));
    const { app } = await setup(options);
    const result = await app.inject({ method: "GET", url: "/api/model-capabilities", headers: authHeaders("ADMIN") });
    expect(result.statusCode).toBe(200);
    expect(result.json().profiles[0].capabilities.vision.state).toBe("AVAILABLE");
    expect(result.body).not.toContain("DO_NOT_EXPOSE");
  });
  it("requires ADMIN role", async () => {
    const { app } = await setup();
    const catalog = await app.inject({
      method: "GET",
      url: "/api/agent-tools/catalog",
      headers: authHeaders("OPERATOR")
    });
    expect(catalog.statusCode).toBe(403);
    const apply = await app.inject({
      method: "POST",
      url: "/api/agent-tools/apply",
      headers: authHeaders("OPERATOR"),
      payload: { assignments: [] }
    });
    expect(apply.statusCode).toBe(403);
    const launch = await app.inject({
      method: "POST",
      url: "/api/agent-tools/launch",
      headers: authHeaders("OPERATOR"),
      payload: { roomId: "room:x", runtimeId: "cli:codex", taskText: "hi" }
    });
    expect(launch.statusCode).toBe(403);
  });

  it("GET catalog returns discovered tools with per-runtime states", async () => {
    const { options } = fixtureOptions();
    const { app, store } = await setup(options);
    const room = store.createRoom({ name: "AT", initialPaneCount: 0 });
    store.createPane({ roomId: room.id, title: "Pane", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });

    const res = await app.inject({
      method: "GET",
      url: "/api/agent-tools/catalog",
      headers: authHeaders("ADMIN")
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runtimes.some((r: { runtimeId: string }) => r.runtimeId === "cli:codex")).toBe(true);
    const mcp = body.entries.find((t: { toolId: string }) => t.toolId === "mcp:space_ops");
    expect(mcp).toBeDefined();
    const codexState = body.states.find((s: { runtimeId: string; toolId: string }) => s.runtimeId === "cli:codex" && s.toolId === "mcp:space_ops");
    expect(codexState.enabled).toBe(true);
    const skill = body.entries.find((t: { toolId: string }) => t.toolId === "skill:space-live-ops");
    expect(skill).toBeDefined();
    expect(skill.kind).toBe("SKILL");
  });

  it("GET catalog falls back to canonical config when primary is unreadable (API runs as space)", async () => {
    const { options, root } = fixtureOptions();
    const canonicalRoot = mkdtempSync(join(tmpdir(), "agent-tools-canonical-"));
    writeFileSync(
      join(canonicalRoot, "kimi-space-mcp.json"),
      JSON.stringify({ mcpServers: { kimi_dispatcher: { command: "/usr/bin/node", args: ["/tmp/dispatcher.mjs"] } } })
    );
    // Simulate the production permission situation: primary home config unreadable by the API user.
    chmodSync(join(root, "space-kimi"), 0o700);
    chmodSync(join(root, "space-kimi", "mcp.json"), 0o000);

    try {
      const { app } = await setup({ ...options, canonicalRoot });
      const res = await app.inject({
        method: "GET",
        url: "/api/agent-tools/catalog",
        headers: authHeaders("ADMIN")
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const kimiMcp = body.entries.find((t: { toolId: string }) => t.toolId === "mcp:kimi_dispatcher");
      expect(kimiMcp).toBeDefined();
      const kimiState = body.states.find(
        (s: { runtimeId: string; toolId: string }) => s.runtimeId === "cli:kimi" && s.toolId === "mcp:kimi_dispatcher"
      );
      expect(kimiState).toBeDefined();
      expect(kimiState.enabled).toBe(true);
    } finally {
      chmodSync(join(root, "space-kimi", "mcp.json"), 0o644);
    }
  });

  it("PATCH assignment validation: SPECIFIC requires runtimeIds", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/agent-tools/assignments/mcp:space_ops",
      headers: authHeaders("ADMIN"),
      payload: { kind: "MCP", scope: "SPECIFIC", runtimeIds: [] }
    });
    expect(res.statusCode).toBe(422);
  });

  it("PATCH creates a persisted assignment", async () => {
    const { app, store } = await setup();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/agent-tools/assignments/mcp:space_ops",
      headers: authHeaders("ADMIN"),
      payload: { kind: "MCP", scope: "SPECIFIC", runtimeIds: ["cli:codex"] }
    });
    expect(res.statusCode).toBe(200);
    expect(store.getAgentToolAssignment("mcp:space_ops")).toMatchObject({
      scope: "SPECIFIC",
      runtimeIds: ["cli:codex"]
    });
  });

  // These exercise multiple real config writes/backups on the VM filesystem.
  it("POST apply writes real config files with backups", { timeout: 15_000 }, async () => {
    const { options, root } = fixtureOptions();
    const { app, store } = await setup(options);
    store.updateAgentToolAssignment("mcp:space_ops", {
      kind: "MCP",
      scope: "SPECIFIC",
      runtimeIds: ["cli:codex"]
    }, "user:admin");

    const res = await app.inject({
      method: "POST",
      url: "/api/agent-tools/apply",
      headers: authHeaders("ADMIN"),
      payload: {
        assignments: [
          { toolId: "mcp:space_ops", kind: "MCP", scope: "SPECIFIC", runtimeIds: ["cli:codex"] }
        ]
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const codexResult = body.results.find((r: { runtimeId: string }) => r.runtimeId === "cli:codex");
    expect(codexResult.files.length).toBeGreaterThan(0);
    expect(codexResult.files.some((f: { path: string }) => f.path.endsWith("config.toml"))).toBe(true);
    const toml = require("node:fs").readFileSync(join(root, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("space-agent-tools-managed");
    expect(toml).toContain("space_ops");

    const backupExists = (await import("node:fs")).readdirSync(join(root, ".codex"))
      .some((name: string) => name.includes(".bak-space-agent-tools-"));
    expect(backupExists).toBe(true);
  });

  it("POST apply honors NONE scope (disables previously enabled server)", { timeout: 15_000 }, async () => {
    const { options, root } = fixtureOptions();
    const { app } = await setup(options);
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-tools/apply",
      headers: authHeaders("ADMIN"),
      payload: {
        assignments: [{ toolId: "mcp:space_ops", kind: "MCP", scope: "NONE", runtimeIds: [] }]
      }
    });
    expect(res.statusCode).toBe(200);
    const toml = require("node:fs").readFileSync(join(root, ".codex", "config.toml"), "utf8");
    expect(toml).not.toContain("[mcp_servers.space_ops]");
  });

  it("POST apply bulk toggles every MCP entry COMMON then NONE across all runtimes", { timeout: 15_000 }, async () => {
    const { options, root } = fixtureOptions();
    const { app } = await setup(options);
    const catalog = await app.inject({
      method: "GET",
      url: "/api/agent-tools/catalog",
      headers: authHeaders("ADMIN")
    });
    expect(catalog.statusCode).toBe(200);
    const mcpEntries = (catalog.json().entries as Array<{ toolId: string; kind: string }>).filter(
      (entry) => entry.kind === "MCP"
    );
    expect(mcpEntries.length).toBeGreaterThan(0);

    const on = await app.inject({
      method: "POST",
      url: "/api/agent-tools/apply",
      headers: authHeaders("ADMIN"),
      payload: {
        assignments: mcpEntries.map((entry) => ({
          toolId: entry.toolId,
          kind: "MCP",
          scope: "COMMON",
          runtimeIds: []
        }))
      }
    });
    expect(on.statusCode).toBe(200);
    const onBody = on.json();
    const writableResults = onBody.results.filter((r: { status: string }) => r.status === "OK");
    expect(writableResults.length).toBeGreaterThan(1);
    for (const runtime of writableResults) {
      expect(runtime.files.some((f: { path: string; changed: boolean }) => f.changed)).toBe(true);
    }

    const codexToml = require("node:fs").readFileSync(join(root, ".codex", "config.toml"), "utf8");
    expect(codexToml).toContain("[mcp_servers.space_ops]");

    const off = await app.inject({
      method: "POST",
      url: "/api/agent-tools/apply",
      headers: authHeaders("ADMIN"),
      payload: {
        assignments: mcpEntries.map((entry) => ({
          toolId: entry.toolId,
          kind: "MCP",
          scope: "NONE",
          runtimeIds: []
        }))
      }
    });
    expect(off.statusCode).toBe(200);
    const codexTomlAfter = require("node:fs").readFileSync(join(root, ".codex", "config.toml"), "utf8");
    expect(codexTomlAfter).not.toContain("[mcp_servers.space_ops]");
  });

  it("POST launch loads task text into a CLI pane session", async () => {
    const { app, store } = await launchHarness();
    const room = store.createRoom({ name: "AT launch", initialPaneCount: 0 });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-tools/launch",
      headers: authHeaders("ADMIN"),
      payload: { roomId: room.id, runtimeId: "cli:codex", taskText: "list files" }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.loaded).toBe(true);
    expect(body.reusedPane).toBe(false);
    expect(body.pane.mode).toBe("TERMINAL");
    expect(body.session.session.sessionId).toBeTruthy();
  });

  it("POST launch reuses an existing TERMINAL pane in the same room", async () => {
    const { app, store } = await launchHarness();
    const room = store.createRoom({ name: "AT reuse", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-tools/launch",
      headers: authHeaders("ADMIN"),
      payload: { roomId: room.id, paneId: pane.id, runtimeId: "cli:codex", taskText: "hi" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reusedPane).toBe(true);
    expect(res.json().pane.id).toBe(pane.id);
  });

  it("POST launch rejects a pane from another room", async () => {
    const { app, store } = await launchHarness();
    const roomA = store.createRoom({ name: "AT room A", initialPaneCount: 0 });
    const roomB = store.createRoom({ name: "AT room B", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: roomA.id, title: "Codex CLI", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-tools/launch",
      headers: authHeaders("ADMIN"),
      payload: { roomId: roomB.id, paneId: pane.id, runtimeId: "cli:codex", taskText: "hi" }
    });
    expect(res.statusCode).toBe(409);
  });

  it("DELETE assignment removes persisted scope", async () => {
    const { app, store } = await setup();
    store.updateAgentToolAssignment("mcp:space_ops", {
      kind: "MCP",
      scope: "COMMON",
      runtimeIds: []
    }, "user:admin");
    const res = await app.inject({
      method: "DELETE",
      url: "/api/agent-tools/assignments/mcp:space_ops",
      headers: authHeaders("ADMIN")
    });
    expect(res.statusCode).toBe(200);
    expect(store.getAgentToolAssignment("mcp:space_ops")).toBeNull();
  });
});

async function launchHarness() {
  const commandDir = mkdtempSync(join(tmpdir(), "agent-tools-command-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "agent-tools-workspace-"));
  const commandPath = join(commandDir, "codex-vscode-parity");
  mkdirSync(commandDir, { recursive: true });
  writeFileSync(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(commandPath, 0o755);

  const store = new InMemorySpaceStore();
  let runningSession: {
    cliSessionId: string;
    generationId: string;
    pid: number;
    status: "RUNNING";
    statusReason: string;
    exitCode: number | null;
    signal: string | null;
    nextOutputSequence: number;
    attachmentCount: number;
    startedAt: string;
    detachedAt: string | null;
    endedAt: string | null;
  } | null = null;
  const host = {
    health: async () => ({ hostPid: 4043, startedAt: "2026-07-23T08:00:00.000Z", buildCommit: null, sessions: [] }),
    inspect: async (identity: { cliSessionId: string }) =>
      runningSession?.cliSessionId === identity.cliSessionId ? runningSession : null,
    attach: async (request: { identity: { cliSessionId: string } }) => {
      runningSession = {
        ...request.identity,
        generationId: "00000000-0000-4000-8000-000000000043",
        pid: 4043,
        status: "RUNNING" as const,
        statusReason: "Running in the agent-tools test host.",
        exitCode: null,
        signal: null,
        nextOutputSequence: 1,
        attachmentCount: 1,
        startedAt: "2026-07-23T08:00:00.000Z",
        detachedAt: null,
        endedAt: null
      };
      return {
        attachmentId: `attachment:${request.identity.cliSessionId}`,
        session: runningSession,
        replay: [{
          type: "output" as const,
          generationId: "00000000-0000-4000-8000-000000000043",
          sequence: 0,
          stream: "stdout" as const,
          data: "OpenAI Codex\nmodel: gpt-5.6-sol medium  /model to change\n› "
        }]
      };
    },
    input: async () => ({ accepted: true, acceptedAtMs: Date.now() }),
    resize: async () => undefined,
    detach: async () => true,
    terminate: async () => true,
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
    auth: { sessionSecret, devLogin: false, secureCookies: false },
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
      update: async () => undefined
    },
    cliHostClient: host
  });
  apps.push(app);
  return { app, store };
}
