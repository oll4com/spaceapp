#!/usr/bin/env node
import { normalizeRootSpawn } from "./admin-policy.js";
import { spawnNodePty } from "./node-pty-spawn.js";
import { createCliHostServer } from "./server.js";
import { CliHostSessionRegistry } from "./session-registry.js";

const socketPath = process.env.SPACE_CLI_ADMIN_HOST_SOCKET || "/run/space-admin-pane-host/pane-host.sock";
const outputBufferBytes = Number.parseInt(process.env.SPACE_CLI_HOST_OUTPUT_BUFFER_BYTES || "8388608", 10);
const registry = new CliHostSessionRegistry({
  spawn: spawnNodePty,
  normalizeSpawn: normalizeRootSpawn,
  outputBufferBytes
});
const server = await createCliHostServer({ socketPath, socketMode: 0o660, registry });
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`space-admin-pane-host shutting down after ${signal}\n`);
  registry.terminateAll();
  await server.close();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

process.stderr.write(`space-admin-pane-host ready socket=${server.socketPath} pid=${process.pid}\n`);
