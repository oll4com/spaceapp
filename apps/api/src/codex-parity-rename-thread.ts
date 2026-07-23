import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeCodexThreadTitle } from "./codex-parity.js";

const execFileAsync = promisify(execFile);
const stateDbPath = process.env.CODEX_STATE_DB_PATH || "/var/lib/spaceapp-user/.codex/state_5.sqlite";

function sqliteQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function main() {
  const threadId = process.argv[2];
  if (!threadId) {
    throw new Error("Missing thread id.");
  }
  const title = normalizeCodexThreadTitle(readFileSync(0, "utf8"));
  await execFileAsync("sqlite3", [
    stateDbPath,
    `update threads set title = ${sqliteQuote(title)} where id = ${sqliteQuote(threadId)}`
  ], {
    timeout: 5000,
    maxBuffer: 64 * 1024
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
