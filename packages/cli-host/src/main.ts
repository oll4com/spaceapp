#!/usr/bin/env node
import { CliHostSessionRegistry } from "./session-registry.js";
import { createCliHostServer } from "./server.js";
import { spawnNodePty } from "./node-pty-spawn.js";

function positiveInteger(value: string | undefined, fallback: number, minimum = 1): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

const socketPath = process.env.SPACE_CLI_HOST_SOCKET || "/run/space-codex-pane-host/pane-host.sock";
const outputBufferBytes = positiveInteger(process.env.SPACE_CLI_HOST_OUTPUT_BUFFER_BYTES, 8 * 1024 * 1024);
const inactiveSessionMs = positiveInteger(process.env.SPACE_CLI_HOST_INACTIVE_SESSION_MS, 2 * 60 * 60_000);
const inactiveSweepMs = positiveInteger(process.env.SPACE_CLI_HOST_INACTIVE_SWEEP_MS, 60_000, 1_000);
const registry = new CliHostSessionRegistry({ spawn: spawnNodePty, outputBufferBytes });
const server = await createCliHostServer({ socketPath, socketMode: 0o660, registry });
let shuttingDown = false;
const inactiveSweep = setInterval(() => {
  const sessionIds = registry.reapInactiveSessions(Date.now(), inactiveSessionMs);
  if (sessionIds.length > 0) {
    process.stderr.write(`${JSON.stringify({
      event: "cli_host_inactive_sessions_reaped",
      count: sessionIds.length,
      sessionIds,
      inactiveSessionMs
    })}\n`);
  }
  const stale = registry.sweepStaleSessions();
  if (stale.reconciled > 0 || stale.pruned > 0) {
    process.stderr.write(`${JSON.stringify({
      event: "cli_host_stale_sessions_swept",
      reconciled: stale.reconciled,
      pruned: stale.pruned,
      retained: registry.sessionCount()
    })}\n`);
  }
}, inactiveSweepMs);
inactiveSweep.unref();

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(inactiveSweep);
  process.stderr.write(`codex-pane-host shutting down after ${signal}\n`);
  registry.terminateAll();
  await server.close();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

process.stderr.write(`codex-pane-host ready socket=${server.socketPath} pid=${process.pid}\n`);
