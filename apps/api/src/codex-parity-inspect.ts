#!/usr/bin/env node
import { join, resolve } from "node:path";
import { readCodexEnvironmentMetadata } from "./codex-parity.js";

const codexHome = resolve(process.env.CODEX_HOME || "/var/lib/spaceapp-user/.codex");
const stateDbPath = resolve(process.env.SPACE_CODEX_STATE_DB_PATH || join(codexHome, "state_5.sqlite"));

try {
  const environment = await readCodexEnvironmentMetadata(codexHome, stateDbPath);
  process.stdout.write(`${JSON.stringify(environment)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Codex environment inspect failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
