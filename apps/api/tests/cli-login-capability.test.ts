import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { isCliRuntimeLoginLaunchable } from "../src/cli-runtimes.js";

it("rejects a login operation not advertised by the runtime before allocating a pane or session", async () => {
  const root = await mkdtemp(join(tmpdir(), "login-capability-"));
  const command = join(root, "gemini-vscode-parity");
  await writeFile(command, "#!/bin/sh\nexit 0\n");
  await chmod(command, 0o700);
  const secret = "login-capability-fixture-secret-12345";
  const token = signSession({ id: "user:fixture", email: "fixture@example.test", role: "OPERATOR" }, secret);
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Capability fixture", initialPaneCount: 0 });
  const app = await createApp({ store,
    config: getApiConfig({ SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces") }),
    auth: { sessionSecret: secret, devLogin: false, secureCookies: false }
  });
  try {
    const response = await app.inject({ method: "POST", url: `/api/rooms/${encodeURIComponent(room.id)}/cli-login`,
      headers: { cookie: `space_session=${token}`, "x-space-csrf-token": createCsrfToken(token, secret)! },
      payload: { runtimeId: "cli:gemini" }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("CLI_LOGIN_UNAVAILABLE");
    expect(store.listPanes(room.id)).toEqual([]);
    expect(store.listAuditEvents().filter(item => item.action === "room.cli.login")).toEqual([]);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

it("requires a defined login action as well as an available executable", () => {
  const installed = { adapterStatus: "ENABLED" as const, detectedCommandPath: "/fixture/cli" };
  expect(isCliRuntimeLoginLaunchable({ ...installed, id: "cli:gemini" })).toBe(false);
  expect(isCliRuntimeLoginLaunchable({ ...installed, id: "cli:opencode" })).toBe(false);
  expect(isCliRuntimeLoginLaunchable({ ...installed, id: "cli:unknown" })).toBe(false);
  expect(isCliRuntimeLoginLaunchable({ ...installed, id: "cli:codex" })).toBe(true);
  expect(isCliRuntimeLoginLaunchable({ ...installed, id: "cli:codex", detectedCommandPath: null })).toBe(false);
  expect(isCliRuntimeLoginLaunchable({ ...installed, id: "cli:codex", adapterStatus: "DISABLED" })).toBe(false);
});
