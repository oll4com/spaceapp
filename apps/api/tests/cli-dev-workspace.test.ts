// 龙娘 · 2026-10-26: a contributor workspace is an intentional working directory, not stable's legacy /etc default.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { cookieName, createCsrfToken, signSession } from "../src/auth.js";
import { resolveDirectOperatorParityCwd } from "../src/cli-parity.js";
import { getApiConfig } from "../src/config.js";
import { ownedSystemAnalytics } from "./owned-system-analytics.js";

describe("contributor CLI workspace", () => {
  it("retains dev defaults and explicit projects while keeping stable parity behavior", () => {
    const workspace = "/checkout/.dev-stack/workspaces";
    expect(resolveDirectOperatorParityCwd(workspace, workspace, "dev")).toBe(workspace);
    expect(resolveDirectOperatorParityCwd(null, workspace, "dev")).toBe(workspace);
    expect(resolveDirectOperatorParityCwd("/checkout/source", workspace, "dev")).toBe("/checkout/source");
    expect(resolveDirectOperatorParityCwd(workspace, workspace, "stable")).toBe("/etc");
    expect(resolveDirectOperatorParityCwd(null, workspace)).toBe("/etc");
    expect(resolveDirectOperatorParityCwd("/checkout/source", workspace, "stable")).toBe("/checkout/source");
  });

  it("inherits the room workspace through pane creation and HTTP allocation when neither request specifies cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-cli-"));
    const workspace = join(root, "workspaces");
    const commandDir = join(root, "bin");
    await mkdir(workspace);
    await mkdir(commandDir);
    const wrapper = join(commandDir, "opencode-vscode-parity");
    await writeFile(wrapper, "#!/bin/sh\nif [ \"$1\" = credential-status ]; then printf 'READY\\n'; else exit 0; fi\n");
    await chmod(wrapper, 0o700);
    const store = new InMemorySpaceStore();
    const user = store.upsertUser({ id: "user:dev-owner", email: "dev-owner@example.invalid", role: "ADMIN" });
    const room = store.createRoom({ name: "Getting Started", projectPath: workspace, initialPaneCount: 0 }, "trace:workspace", user.id);
    const host = { inspect: vi.fn(async () => null), attach: vi.fn(async () => { throw new Error("Allocation must not spawn a terminal"); }),
      detach: vi.fn(async () => true), terminate: vi.fn(async () => true), input: vi.fn(), resize: vi.fn(), close: async () => undefined };
    const sessionSecret = "isolated-workspace-regression-secret";
    const app = await createApp({ store, config: getApiConfig({
      SPACE_INSTANCE: "dev", SPACE_INSTALL_ROOT: root, SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: commandDir,
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
      expect(pane.cwd).toBe(workspace);
      const allocated = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/cli/session`, headers,
        payload: { runtimeId: "cli:opencode", includeTranscript: false } });
      expect(allocated.statusCode).toBe(200);
      expect(allocated.json().session).toMatchObject({ cwd: workspace, status: "IDLE", isActive: true });
      expect(host.attach).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
