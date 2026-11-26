import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
const root = new URL("../../", import.meta.url);
const script = new URL("../space-shared-memory-seed.mjs", import.meta.url);
const seed = JSON.parse(readFileSync(new URL("packages/contracts/src/nous-shared-memory-seed.json", root), "utf8"));
const run = (code) => JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { validateSeed, exportSeed } from ${JSON.stringify(script.href)}; ${code}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

test("the committed seed has the identity, unique keys, privacy checks and exact release validation", () => {
  const version = seed.releaseVersion;
  assert.equal(run(`console.log(JSON.stringify(validateSeed(${JSON.stringify(seed)}, '${version}')))`), true);
  assert.throws(() => run(`validateSeed(${JSON.stringify(seed)}, '9.9.9')`));
  assert.throws(() => run(`validateSeed({...${JSON.stringify(seed)}, entries: [...${JSON.stringify(seed.entries)}, ${JSON.stringify(seed.entries[0])}]}, '${version}')`));
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

test("a seed staged for a newer release passes the staged check, an older one and the exact check refuse it (14/11: a 1.2.2 seed under setup 1.2.1 blocked every remote push for 30 h)", () => {
  const staged = { ...seed, releaseVersion: "1.2.2" };
  assert.equal(run(`console.log(JSON.stringify(validateSeed(${JSON.stringify(staged)}, '1.2.1', { allowStaged: true })))`), true);
  assert.equal(run(`console.log(JSON.stringify(validateSeed(${JSON.stringify({ ...seed, releaseVersion: "1.2.0" })}, '1.1.9', { allowStaged: true })))`), true);
  assert.throws(() => run(`validateSeed(${JSON.stringify(staged)}, '1.2.1')`));
  assert.throws(() => run(`validateSeed(${JSON.stringify(staged)}, '1.2.3', { allowStaged: true })`));
  assert.throws(() => run(`validateSeed(${JSON.stringify(staged)}, '1.10.0', { allowStaged: true })`));
});
