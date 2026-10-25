import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { agentRuntimeSchema, proofRoomSchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import * as runtimes from "../src/cli-runtimes.js";
import { TaskTitleProviders } from "../src/task-title-providers.js";

afterEach(() => vi.restoreAllMocks());

it("keeps the CLI input fixture workspace at /etc so session creation cannot inherit the production project", async () => {
  // External CLI discovery is unrelated to the room/session cwd contract.
  const checkedAt = "2026-10-08T06:00:00.000Z";
  vi.spyOn(runtimes, "discoverAgentRuntimes").mockResolvedValue({ checkedAt, data: [agentRuntimeSchema.parse({
    id: "cli:codex", providerId: "codex", providerName: "Codex", agentId: "codex",
    agentName: "Codex", displayName: "Codex CLI", capabilities: ["CLI"],
    adapterStatus: "ENABLED", authMode: "BROWSER_OAUTH", authState: "READY",
    authReason: "Fixture ready", canStartLogin: false, status: "ENABLED",
    statusReason: "Fixture ready", commandName: "codex", checkedAt
  })] });
  vi.spyOn(TaskTitleProviders.prototype, "refresh").mockResolvedValue();
  const store = new InMemorySpaceStore();
  const secret = "test-secret-with-enough-length";
  const token = signSession({ id: "user:admin", email: "admin@space.test", role: "ADMIN" }, secret);
  // Proof rooms now require an enabled CLI with its controlled command directory.
  const commandDir = await mkdtemp(join(tmpdir(), "space-proof-cli-input-"));
  await writeFile(join(commandDir, "codex-vscode-parity"), "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(join(commandDir, "codex-vscode-parity"), 0o755);
  const app = await createApp({ store, codexAgentControl: null, config: getApiConfig({
    SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: commandDir, SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true"
  }), auth: { sessionSecret: secret, devLogin: true, secureCookies: false } });
  try {
    const response = await app.inject({ method: "POST", url: "/api/proof-rooms",
      headers: { cookie: `space_session=${token}`, "x-space-csrf-token": createCsrfToken(token, secret)! },
      payload: { profile: "CLI_INPUT", paneCount: 1, runtimeId: "cli:codex" } });
    expect(response.statusCode).toBe(201);
    const proof = proofRoomSchema.parse(response.json());
    expect(proof.room.projectPath).toBe("/etc");
    expect(proof.panes[0]?.cwd).toBe("/etc");
    expect(store.getRoom(proof.room.id)?.projectPath).toBe("/etc");
    expect(proof.sessionIds).toEqual([]);
  } finally {
    await app.close();
    await rm(commandDir, { recursive: true, force: true });
  }
}, 30_000);
