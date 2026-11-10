import { afterEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

const sessionSecret = "cli-session-warm-registry-secret";
const roots: string[] = [];
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}, 30_000);

// 4/11 stable: after every restart each pane's GET cli/session waited ~4 s for the first CLI discovery, whose slowest
// credential probe (gh 4.0 s, cursor 3.7 s) held it. The discovery now starts with the app and onReady waits for it.
it("answers a pane's first session read after start without waiting for the CLI discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "space-warm-registry-"));
  roots.push(root);
  const copilot = join(root, "copilot-vscode-parity");
  await writeFile(copilot, "#!/bin/sh\ncase \"$1\" in credential-status) sleep 2; printf 'READY\\n' ;; *) exit 0 ;; esac\n", "utf8");
  await chmod(copilot, 0o755);
  const claude = join(root, "claude-vscode-parity");
  await writeFile(claude, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(claude, 0o755);
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Warm registry", initialPaneCount: 0 }, "trace:warm-registry");
  const pane = store.createPane({ roomId: room.id, title: "Claude", mode: "TERMINAL", terminalRuntimeId: "cli:claude", cwd: "/etc" }, "trace:warm-registry");
  store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "anthropic", agentId: "claude",
    modelId: null, reasoningEffort: "medium", cwd: "/etc", codexThreadId: null, status: "RUNNING", statusReason: "Running.", isActive: true },
    "trace:warm-registry");
  app = await createApp({ store, config: getApiConfig({ SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_HOST_SOCKET: join(root, "no-host.sock") }),
    auth: { sessionSecret, devLogin: false, secureCookies: false } });
  await app.ready();
  const session = signSession({ id: "user:admin", email: "admin@space.local", role: "ADMIN" }, sessionSecret);
  const startedAt = performance.now();
  const response = await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(pane.id)}/cli/session?includeTranscript=false`,
    headers: { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! } });
  const elapsedMs = performance.now() - startedAt;
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().runtime.id).toBe("cli:claude");
  expect(elapsedMs).toBeLessThan(1_000);
}, 30_000);
