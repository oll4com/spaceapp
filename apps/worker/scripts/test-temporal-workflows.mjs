import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const files = (await readdir(new URL("../tests/", import.meta.url)))
  .filter(name => /^temporal-.*\.test\.ts$/.test(name)).sort().map(name => `tests/${name}`);
if (!files.length) throw new Error("No Temporal sandbox/replay tests found");

async function runVitest(args, bounded = false) {
  const start = performance.now();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url)), "run", ...args], {
    cwd: workspace, stdio: "inherit"
  });
  let exceeded = false;
  const deadline = bounded ? setTimeout(() => {
    exceeded = true;
    console.error("Temporal sandbox/replay suite exceeded its 180-second CI budget");
    child.kill("SIGTERM");
  }, 180_000) : undefined;
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code === 0 && !signal && !exceeded && (!bounded || performance.now() - start < 180_000) ? 0 : 1));
    });
  } finally {
    clearTimeout(deadline);
    if (bounded) console.log(`Temporal sandbox/replay: ${((performance.now() - start) / 1000).toFixed(2)} seconds (budget <180 seconds).`);
  }
}

const args = process.argv.slice(2);
const all = args[0] === "--all";
if (all) args.shift();
// Preserve `npm test -- <Vitest filters/options>` for focused development runs.
if (args.length) process.exitCode = await runVitest(args);
else {
  process.exitCode = await runVitest(files, true);
  // The public suite runs each test once. Keep the new suite's wall-clock budget
  // independent from the existing worker tests, including their optional proofs.
  if (all && process.exitCode === 0) process.exitCode = await runVitest(["--exclude", "tests/temporal-*.test.ts"]);
}
