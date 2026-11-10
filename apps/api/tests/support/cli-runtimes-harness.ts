import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import { paneCliWebSocketServerMessageSchema, type PaneCliWebSocketServerMessage } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemorySystemAnalyticsRepository } from "@space/db";
import { SystemAnalyticsService } from "../../src/system-analytics-service.js";
import { CliHostClient, CliHostSessionRegistry, createCliHostServer, spawnNodePty } from "@space/cli-host";
import { createApp as createApiApp, type CreateAppOptions } from "../../src/app.js";
import { getApiConfig } from "../../src/config.js";
import { createCsrfToken, signSession } from "../../src/auth.js";
import type { SpaceAgentControl } from "../../src/space-agent.js";

// Shared by cli-runtimes and cli-runtimes-host tests: apps it closes after each test, a signed-in operator, CLI host
// helpers and fixtures.
// The checkout root from this file, so deploy/ and scripts/ resolve from any working directory and worktree depth.
export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const ownedApps = new Set<Awaited<ReturnType<typeof createApiApp>>>();
export async function createApp(options: CreateAppOptions = {}) {
  const app = await createApiApp(options);
  ownedApps.add(app);
  app.addHook("onClose", async () => { ownedApps.delete(app); });
  return app;
}

export const csrfHeaderName = "x-space-csrf-token";
export const execFileAsync = promisify(execFile);
export const cliHostSocketTmpdir = "/tmp";
export const pngImage = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d
]);

export function userRuntimeDir(user: string): string | null {
  const record = readFileSync("/etc/passwd", "utf8")
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${user}:`));
  const uid = record?.split(":")[2];
  return uid && /^[0-9]+$/.test(uid) ? `/run/user/${uid}` : null;
}

export function multipartPayload(parts: Array<{ field?: string; filename?: string; mimeType?: string; body?: Buffer }>) {
  const boundary = "space-cli-upload-test-boundary";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${part.field ?? "file"}"; filename="${part.filename ?? "upload.bin"}"\r\n` +
          `Content-Type: ${part.mimeType ?? "application/octet-stream"}\r\n\r\n`
      )
    );
    chunks.push(part.body ?? Buffer.from("hello from upload\n"));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

export async function authedApp(options: CreateAppOptions = {}) {
  const store = options.store ?? new InMemorySpaceStore();
  const analyticsRoot = await mkdtemp(join(tmpdir(), "space-cli-analytics-test-"));
  // CLI contracts retain the real PTY host. Unrelated host telemetry and
  // provider-history ingestion use an owned empty fixture, not operator data.
  const analytics = options.systemAnalyticsService ?? new SystemAnalyticsService({
    store, repository: new InMemorySystemAnalyticsRepository(),
    codexHome: analyticsRoot, stateRoot: analyticsRoot, hermesHome: analyticsRoot,
    liveSessions: async () => [], readProcessTable: async () => [],
    readMeminfo: async () => "MemTotal: 1024 kB\nMemAvailable: 1024 kB\n",
    readProcStat: async () => "cpu 0 0 0 100 0 0 0 0 0 0\n", coreCount: 1
  });
  let cliHostServer: Awaited<ReturnType<typeof createCliHostServer>> | null = null;
  let cliHostClient = options.cliHostClient;
  if (options.config?.cliEnabled && !cliHostClient) {
    const cliHostRoot = await mkdtemp(join(cliHostSocketTmpdir, "space-cli-host-test-"));
    const socketPath = join(cliHostRoot, "pane-host.sock");
    cliHostServer = await createCliHostServer({
      socketPath,
      registry: new CliHostSessionRegistry({ spawn: spawnNodePty })
    });
    cliHostClient = new CliHostClient({ socketPath });
  }
  const codexAgentControl = options.config?.cliEnabled && !Object.hasOwn(options, "codexAgentControl")
    ? testCodexAgentControl
    : options.codexAgentControl;
  const app = await createApp({
    ...options,
    store,
    systemAnalyticsService: analytics,
    ...(Object.hasOwn(options, "codexAgentControl") || options.config?.cliEnabled
      ? { codexAgentControl: codexAgentControl ?? null }
      : {}),
    cliHostClient,
    auth: {
      sessionSecret: "test-secret-with-enough-length",
      devLogin: true,
      secureCookies: false,
      ...(options.auth ?? {})
    }
  });
  app.addHook("onClose", async () => {
    await analytics.dispose();
    await rm(analyticsRoot, { recursive: true, force: true });
  });
  if (cliHostServer) {
    app.addHook("onClose", async () => {
      await cliHostServer?.close();
    });
  }
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "space@space.local", password: "space-dev" }
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.find((entry) => entry.name === "space_session")?.value;
  expect(cookie).toBeTruthy();
  const cookieHeader = `space_session=${cookie}`;
  const csrf = await app.inject({
    method: "GET",
    url: "/api/auth/csrf",
    headers: { cookie: cookieHeader }
  });
  expect(csrf.statusCode).toBe(200);
  return { app, cookie: cookieHeader, csrfToken: csrf.json().csrfToken as string };
}

export const testCodexAgentControl = {
  async readConfigRequirements() {
    return {
      allowedApprovalPolicies: ["on-request", "never"],
      allowedApprovalsReviewers: ["user", "guardian_subagent"],
      allowedSandboxModes: ["workspace-write", "danger-full-access"],
      defaultPermissions: null
    };
  },
  async listModels() {
    return [{
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      description: "Provider-advertised integration-test model.",
      isDefault: true,
      defaultReasoningEffort: "xhigh",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"]
    }];
  },
  async listCollaborationModes() {
    return [{
      name: "Default",
      mode: "default" as const,
      model: "gpt-5.6-sol",
      reasoning_effort: "xhigh"
    }];
  },
  async setGoal() {
    throw new Error("Goal control is not used by CLI runtime tests.");
  },
  async clearGoal() {
    throw new Error("Goal control is not used by CLI runtime tests.");
  }
} satisfies SpaceAgentControl;

export function operatorAuth() {
  const secret = "test-secret-with-enough-length";
  const token = signSession({ id: "user:operator", email: "operator@space.test", role: "OPERATOR" }, secret);
  return {
    cookie: `space_session=${token}`,
    csrfToken: createCsrfToken(token, secret) ?? ""
  };
}

export function decodeWsMessage(raw: unknown): PaneCliWebSocketServerMessage {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  return paneCliWebSocketServerMessageSchema.parse(JSON.parse(text));
}

export async function enabledCliConfig(commandDir: string, extra: NodeJS.ProcessEnv = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "space-cli-workspaces-"));
  return getApiConfig({
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_COMMAND_PATH: commandDir,
    SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
    SPACE_CLI_WORKSPACE_ROOT: workspaceRoot,
    ...extra
  });
}

export const readyRuntimeAuth = {
  adapterStatus: "ENABLED",
  authMode: "NONE",
  authState: "READY",
  authReason: "Enabled for test.",
  canStartLogin: false
} as const;

export async function waitForWsMessage(
  messages: PaneCliWebSocketServerMessage[],
  predicate: (message: PaneCliWebSocketServerMessage) => boolean
): Promise<PaneCliWebSocketServerMessage> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for WebSocket message. Seen: ${JSON.stringify(messages)}`);
}

export async function closeOwnedApps() {
  await Promise.all([...ownedApps].map(app => app.close()));
  ownedApps.clear();
}
