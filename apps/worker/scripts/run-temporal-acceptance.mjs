import { fileURLToPath } from "node:url";
import { measureCommand } from "./temporal-measurement.mjs";

const vitest = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
const selection = process.argv.slice(2);
const report = measureCommand(process.execPath, [vitest, "run", ...selection], {
  cwd: fileURLToPath(new URL("../", import.meta.url)), env: process.env, stdio: "inherit"
});
// Keep machine-readable timing and the child's failure status independent of
// afterAll hooks, wall-clock corrections, and framework console formatting.
console.log(JSON.stringify({ scope: selection.length ? "selected-worker-tests" : "complete-worker-suite", clock: "monotonic", ...report }));
process.exitCode = report.exitCode;
