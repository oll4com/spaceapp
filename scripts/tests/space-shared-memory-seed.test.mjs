import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
const root = new URL("../../", import.meta.url);
const script = new URL("../space-shared-memory-seed.mjs", import.meta.url);
const seed = JSON.parse(readFileSync(new URL("packages/contracts/src/nous-shared-memory-seed.json", root), "utf8"));
const run = (code) => JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { validateSeed, exportSeed } from ${JSON.stringify(script.href)}; ${code}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

test("the staged 1.2.0 seed has the identity, unique keys, privacy checks and exact release validation", () => {
  assert.equal(run(`console.log(JSON.stringify(validateSeed(${JSON.stringify(seed)}, '1.2.0')))`), true);
  assert.throws(() => run(`validateSeed(${JSON.stringify(seed)}, '1.2.1')`));
  assert.throws(() => run(`validateSeed({...${JSON.stringify(seed)}, entries: [...${JSON.stringify(seed.entries)}, ${JSON.stringify(seed.entries[0])}]}, '1.2.0')`));
});
test("exports only ACTIVE content and applies the same screen without echoing private text", () => {
  const entries = [{ id: "nous_shared:example", ...seed.entries[0], status: "ACTIVE", seedKey: "identity" }, { id: "proposal", title: "Working rules", body: "Verify the result.", tags: [], status: "PROPOSED" }];
  const out = run(`console.log(JSON.stringify(exportSeed(${JSON.stringify(entries)}, '1.2.0')))`);
  assert.equal(out.entries.length, 1); assert.equal(out.entries[0].key, "identity"); assert.equal(out.releaseVersion, "1.2.0");
  assert.throws(() => run(`exportSeed([{...${JSON.stringify(entries[0])}, body:'Ask Alice.'}], '1.2.0')`), (error) => !error.stderr.toString().includes("Ask Alice."));
});

test("refreshes exact registry-safe prereleases while rejecting malformed versions", () => {
  const prerelease = { ...seed, releaseVersion: "1.2.0-hostroot.0" };
  assert.equal(run(`console.log(JSON.stringify(validateSeed(${JSON.stringify(prerelease)}, '1.2.0-hostroot.0')))`), true);
  assert.throws(() => run(`validateSeed(${JSON.stringify(prerelease)}, '1.2.0')`));
  assert.throws(() => run(`validateSeed({...${JSON.stringify(seed)}, releaseVersion:'01.2.0'}, '01.2.0')`));
});
