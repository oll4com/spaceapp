import { mkdir, readdir, writeFile } from "node:fs/promises";
import { TemporalSandbox } from "./support/temporal-sandbox.js";
import { scenarios, runScenario } from "./support/temporal-scenarios.js";
import { historyDirectory } from "./support/temporal-replay.js";

// Explicit maintenance entry point; ordinary tests never write fixtures.
// Read the fixture README before replacing baselines.
const initial = process.argv.includes("--initial-baseline");
const suffix = process.argv.find(arg => arg.startsWith("--patch="))?.slice("--patch=".length);
if (!process.argv.includes("--confirm-patched-change") && !initial) {
  throw Error("History recording requires --confirm-patched-change (or --initial-baseline for the first baseline). Read the fixture README.");
}
await mkdir(historyDirectory, { recursive: true });
const existing = (await readdir(historyDirectory)).filter(name => name.endsWith(".json"));
if (initial && existing.length) throw Error("The initial baseline already exists; keep it and add a patched baseline.");
if (!initial && (!suffix || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(suffix))) {
  throw Error("A patched baseline requires a unique --patch=patch-id suffix; existing histories are never overwritten.");
}
const sandbox = new TemporalSandbox();
try {
  await sandbox.open();
  for (const scenario of scenarios) {
    console.log(`Recording: ${scenario.name}`);
    await runScenario(sandbox, scenario);
  }
  for (const [name, json] of sandbox.histories) {
    await writeFile(`${historyDirectory}/${name}${initial ? "" : `--${suffix}`}.json`, `${json}\n`, { flag: "wx" });
  }
  console.log(`Recorded ${sandbox.histories.size} genuine workflow histories.`);
} finally { await sandbox.close(); }
