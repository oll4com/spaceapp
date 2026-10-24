import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const vitest = path.resolve(here, "../../../node_modules/vitest/vitest.mjs");
const child = spawn(process.execPath, [vitest, "run", "tests/temporal-workflows.test.ts", "tests/temporal-legacy-history.test.ts", "--config", "vitest.config.ts"], {
  cwd: path.resolve(here, ".."),
  env: { ...process.env, TEMPORAL_RECORD_HISTORIES: "1" },
  stdio: "inherit"
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
