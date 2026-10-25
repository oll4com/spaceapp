import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentRuntimeRegistrySchema, agentRuntimeSchema, instanceBackgroundJobs } from "@space/contracts";
import type { CliHostAttachInput } from "@space/cli-host";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { CliTerminalManager } from "../src/cli-terminal.js";
import { getApiConfig } from "../src/config.js";

describe("stable and dev instances", () => {
  it("runs every background job on stable and only opted-in jobs on dev", () => {
    const stable = getApiConfig({});
    expect(stable.instance).toBe("stable");
    expect(Object.values(stable.instanceJobs).every(Boolean)).toBe(true);
    expect(Object.keys(stable.instanceJobs).sort()).toEqual([...instanceBackgroundJobs].sort());

    const dev = getApiConfig({ SPACE_INSTANCE: "dev", SPACE_INSTANCE_ENABLED_JOBS: "dot-schedules" });
    expect(dev.instance).toBe("dev");
    expect(Object.entries(dev.instanceJobs).filter(([, enabled]) => enabled).map(([job]) => job)).toEqual(["dot-schedules"]);
    expect(() => getApiConfig({ SPACE_INSTANCE: "prod" })).toThrow();
  });

  it("reports the instance on the public version endpoint", async () => {
    for (const instance of ["stable", "dev"] as const) {
      const app = await createApp({ config: getApiConfig({ SPACE_INSTANCE: instance }) });
      try {
        const response = await app.inject({ method: "GET", url: "/version" });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ name: "space-api", instance });
      } finally {
        await app.close();
      }
    }
  });

  it("refuses to start another CLI once the configured number of sessions is running", async () => {
    const commandDir = await mkdtemp(join(tmpdir(), "space-instance-cli-cap-"));
    const commandPath = join(commandDir, "codex-vscode-parity");
    await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(commandPath, 0o755);
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Dev CLI cap", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", cwd: "/etc" });
    const session = store.createPaneCliSession({
      sessionId: "cli_session:dev-cap",
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      status: "IDLE",
      statusReason: "Waiting for attach.",
      isActive: true
    });
    const runtime = agentRuntimeSchema.parse({
      id: "cli:codex",
      providerId: "codex",
      providerName: "Codex",
      agentId: "codex",
      agentName: "Codex CLI",
      displayName: "Codex CLI",
      capabilities: ["CLI"],
      adapterStatus: "ENABLED",
      authMode: "NONE",
      authState: "READY",
      authReason: "Enabled for test.",
      canStartLogin: false,
      status: "ENABLED",
      statusReason: "Enabled for test.",
      commandName: "codex-vscode-parity",
      detectedCommandPath: commandPath,
      defaultModelId: "gpt-5.6-sol",
      supportedReasoningEfforts: ["high"],
      checkedAt: "2026-10-12T00:00:00.000Z"
    });
    const hostSession = (id: string, status: "RUNNING" | "EXITED") => ({
      cliSessionId: id,
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      codexThreadId: null,
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      generationId: "00000000-0000-4000-8000-000000000041",
      pid: 5041,
      status,
      statusReason: status,
      exitCode: null,
      signal: null,
      nextOutputSequence: 0,
      attachmentCount: 1,
      startedAt: "2026-10-12T00:00:00.000Z",
      endedAt: null
    });
    const running = [hostSession("cli_session:other-a", "RUNNING"), hostSession("cli_session:other-b", "RUNNING")];
    const hostSessions = [...running, hostSession("cli_session:closed", "EXITED")];
    const attachInputs: CliHostAttachInput[] = [];
    const workspaceRoot = await mkdtemp(join(tmpdir(), "space-instance-cli-workspaces-"));
    const manager = new CliTerminalManager({
      store,
      config: getApiConfig({
        SPACE_CLI_ENABLED: "true",
        SPACE_CLI_COMMAND_PATH: commandDir,
        SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
        SPACE_CLI_WORKSPACE_ROOT: workspaceRoot,
        SPACE_CLI_MAX_RUNNING_SESSIONS: "2"
      }),
      discoverRuntimes: async () =>
        agentRuntimeRegistrySchema.parse({ data: [runtime], checkedAt: "2026-10-12T00:00:00.000Z" }),
      hostClient: {
        health: async () => ({ hostPid: 1, startedAt: "2026-10-12T00:00:00.000Z", buildCommit: null, sessions: hostSessions }),
        inspect: async () => null,
        attach: async (input: CliHostAttachInput) => {
          attachInputs.push(input);
          return { attachmentId: "attachment:dev-cap", session: hostSession(session.sessionId, "RUNNING"), replay: [] };
        },
        input: async () => ({ accepted: true, acceptedAtMs: 1_720_000_000_000 }),
        close: async () => undefined
      } as never
    });

    await expect(manager.sendInput(session.sessionId, "", "req:dev-cap-full"))
      .rejects.toThrow("This Space instance runs at most 2 CLI sessions at a time. Close a CLI pane to start another.");
    expect(attachInputs).toHaveLength(0);

    hostSessions.splice(0, 1);
    await manager.sendInput(session.sessionId, "", "req:dev-cap-free");
    expect(attachInputs).toHaveLength(1);
    expect(attachInputs[0]?.spawn).toBeDefined();
  });
});
