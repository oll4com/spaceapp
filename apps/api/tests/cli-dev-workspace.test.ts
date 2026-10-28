// Longniang, 2026-10-28: use existing public-distribution workspaces instead of global dev defaults.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { cookieName, createCsrfToken, signSession } from "../src/auth.js";
import { publicRoomWorkspacePath, resolveDirectOperatorParityCwd } from "../src/cli-parity.js";
import { getApiConfig } from "../src/config.js";
import { ownedSystemAnalytics } from "./owned-system-analytics.js";

describe("contributor CLI workspace", () => {
  it("keeps direct operator parity defaults and explicit projects unchanged", () => {
    const workspace = "/checkout/.dev-stack/workspaces";
    expect(resolveDirectOperatorParityCwd(workspace, workspace)).toBe("/etc");
    expect(resolveDirectOperatorParityCwd(null, workspace)).toBe("/etc");
    expect(resolveDirectOperatorParityCwd("/checkout/source", workspace)).toBe("/checkout/source");
  });

  it.each([
    ["dev", false], ["stable", false], ["dev", true], ["stable", true]
  ] as const)("allocates %s public rooms using configured workspaces; explicit project=%s", async (instance, explicitProject) => {
    const root = await mkdtemp(join(tmpdir(), "dev-cli-"));
    const workspace = join(root, "workspaces");
    const commandDir = join(root, "bin");
    await mkdir(workspace);
    await mkdir(commandDir);
    const wrapper = join(commandDir, "opencode-vscode-parity");
    await writeFile(wrapper, "#!/bin/sh\nif [ \"$1\" = credential-status ]; then printf 'READY\\n'; else exit 0; fi\n");
    await chmod(wrapper, 0o700);
    const project = join(root, "selected-project");
    await mkdir(project);
    const store = new InMemorySpaceStore();
    const user = store.upsertUser({ id: "user:dev-owner", email: "dev-owner@example.invalid", role: "ADMIN" });
    const room = store.createRoom({ name: "Getting Started", ...(explicitProject ? { projectPath: project } : {}), initialPaneCount: 0 }, "trace:workspace", user.id);
    const host = { inspect: vi.fn(async () => null), attach: vi.fn(async () => { throw new Error("Allocation must not spawn a terminal"); }),
      detach: vi.fn(async () => true), terminate: vi.fn(async () => true), input: vi.fn(), resize: vi.fn(), close: async () => undefined };
    const sessionSecret = "isolated-workspace-regression-secret";
    const app = await createApp({ store, config: getApiConfig({
      SPACE_INSTANCE: instance, SPACE_PUBLIC_DISTRIBUTION: "true", SPACE_INSTALL_ROOT: root, SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: commandDir,
      SPACE_CLI_WORKSPACE_ROOT: workspace, SPACE_CLI_HOST_SOCKET: join(root, "cli.sock"), SPACE_ARTIFACT_ROOT: join(root, "artifacts"),
      SPACE_MEMORY_INDEX_PATH: join(root, "memory.md"), SPACE_MEMORY_MONTHLY_PATH: join(root, "monthly.md"),
    }), cliHostClient: host, systemAnalyticsService: ownedSystemAnalytics(store, root),
    auth: { sessionSecret, devLogin: false, secureCookies: false } });
    try {
      const token = signSession(user, sessionSecret);
      const headers = { cookie: `${cookieName}=${token}`, "x-space-csrf-token": createCsrfToken(token, sessionSecret)! };
      const created = await app.inject({ method: "POST", url: `/api/rooms/${encodeURIComponent(room.id)}/panes`, headers,
        payload: { panes: [{ mode: "TERMINAL", terminalRuntimeId: "cli:opencode" }] } });
      expect(created.statusCode).toBe(200);
      const pane = created.json().data[0];
      expect(pane.cwd).toBe(explicitProject ? project : "/opt/spaceapp");
      const expectedCwd = explicitProject ? project : publicRoomWorkspacePath(workspace, room.id);
      const allocated = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/cli/session`, headers,
        payload: { runtimeId: "cli:opencode", includeTranscript: false } });
      expect(allocated.statusCode).toBe(200);
      expect(allocated.json().session).toMatchObject({ cwd: expectedCwd, status: "IDLE", isActive: true });
      expect(host.attach).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
