#!/usr/bin/env node
import { join, resolve } from "node:path";
import { readCodexEnvironmentMetadata } from "./codex-parity.js";
import { SPACE_AGENT_HOME } from "@space/contracts";

const codexHome = resolve(process.env.CODEX_HOME || `${SPACE_AGENT_HOME}/.codex`);
const stateDbPath = resolve(process.env.SPACE_CODEX_STATE_DB_PATH || join(codexHome, "state_5.sqlite"));

try {
  const environment = await readCodexEnvironmentMetadata(codexHome, stateDbPath);
  process.stdout.write(`${JSON.stringify(environment)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Codex environment inspect failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
