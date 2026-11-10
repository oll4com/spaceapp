import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePublicRelease } from "../public-release-readiness.mjs";

const policy = {
  schemaVersion: 1,
  packages: {
    "@anthropic-ai/claude-code": {
      version: "2.1.301",
      distribution: "owner-installed-only",
      imageBundled: false
    }
  }
};

const notices = [
  "Claude Code (`@anthropic-ai/claude-code@2.1.301`)",
  "Claude Code is therefore not included in published SpaceApp images.",
  "owner-initiated"
].join("\n");

test("public release readiness blocks version drift", () => {
  const result = evaluatePublicRelease({
    requestedVersion: "0.1.1",
    packageVersion: "0.1.0",
    notices,
    dockerfile: "FROM node:22\n",
    distributionPolicy: policy
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, [
    "Requested version 0.1.1 does not match run-spaceapp 0.1.0.",
    "Requested runtime version 0.1.1 does not match run-spaceapp runtime 0.1.0."
  ]);
});

test("public release readiness accepts exact semantic prerelease versions", () => {
  const result = evaluatePublicRelease({
    requestedVersion: "0.1.15-hostroot.0",
    requestedNpmTag: "personal",
    packageVersion: "0.1.15-hostroot.0",
    notices,
    dockerfile: "FROM node:22\n",
    distributionPolicy: policy
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
});

test("launcher-only readiness accepts a new launcher pinned to an older runtime", () => {
  const result = evaluatePublicRelease({
    requestedVersion: "0.1.15-hostroot.1",
    requestedNpmTag: "personal",
    requestedReleaseMode: "launcher-only",
    requestedRuntimeVersion: "0.1.15-hostroot.0",
    packageVersion: "0.1.15-hostroot.1",
    packageRuntimeVersion: "0.1.15-hostroot.0",
    packageHostRootRuntimeCompatible: false,
    notices,
    dockerfile: "FROM node:22\n",
    distributionPolicy: policy
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
});

test("launcher-only readiness blocks runtime input drift", () => {
  const result = evaluatePublicRelease({
    requestedVersion: "0.1.15-hostroot.1",
    requestedNpmTag: "personal",
    requestedReleaseMode: "launcher-only",
    requestedRuntimeVersion: "0.1.15-hostroot.0",
    packageVersion: "0.1.15-hostroot.1",
    packageRuntimeVersion: "0.1.15-hostroot.9",
    packageHostRootRuntimeCompatible: false,
    notices,
    dockerfile: "FROM node:22\n",
    distributionPolicy: policy
  });

  assert.equal(result.ok, false);
  assert.match(result.blockers.join("\n"), /runtime.*does not match/i);
});

test("amd64 core and CLI readiness accepts a matching host-root runtime for an x64 launcher", () => {
  const result = evaluatePublicRelease({
    requestedVersion: "0.1.15-hostroot.2",
    requestedNpmTag: "personal",
    requestedReleaseMode: "amd64-core-cli",
    requestedRuntimeVersion: "0.1.15-hostroot.2",
    requestedBrowserSourceVersion: "0.1.15-hostroot.0",
    packageVersion: "0.1.15-hostroot.2",
    packageRuntimeVersion: "0.1.15-hostroot.2",
    packageHostRootRuntimeCompatible: true,
    packageCpu: ["x64"],
    notices,
    dockerfile: "FROM node:22\n",
    distributionPolicy: policy
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
});

test("amd64 core and CLI readiness blocks a launcher that could install on arm64", () => {
  const result = evaluatePublicRelease({
    requestedVersion: "0.1.15-hostroot.2",
    requestedNpmTag: "personal",
    requestedReleaseMode: "amd64-core-cli",
    requestedRuntimeVersion: "0.1.15-hostroot.2",
    requestedBrowserSourceVersion: "0.1.15-hostroot.0",
    packageVersion: "0.1.15-hostroot.2",
    packageRuntimeVersion: "0.1.15-hostroot.2",
    packageHostRootRuntimeCompatible: true,
    notices,
    dockerfile: "FROM node:22\n",
    distributionPolicy: policy
  });

  assert.equal(result.ok, false);
  assert.match(result.blockers.join("\n"), /must support x64 hosts/i);
});

test("public release readiness reserves host-root versions for the personal tag", () => {
  const result = evaluatePublicRelease({
    requestedVersion: "0.1.15-hostroot.0",
    requestedNpmTag: "next",
    packageVersion: "0.1.15-hostroot.0",
    notices,
    dockerfile: "FROM node:22\n",
    distributionPolicy: policy
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, [
    "Host-root prereleases must publish only to the npm personal tag."
  ]);
});

test("public release readiness requires a positive owner-installed-only Claude record", () => {
  const result = evaluatePublicRelease({
    requestedVersion: "0.1.0",
    packageVersion: "0.1.0",
    notices: notices.replace("owner-initiated", "manual"),
    dockerfile: "RUN npm install @anthropic-ai/claude-code@2.1.301\n",
    distributionPolicy: {
      ...policy,
      packages: {
        "@anthropic-ai/claude-code": {
          ...policy.packages["@anthropic-ai/claude-code"],
          imageBundled: true
        }
      }
    }
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, [
    "Claude Code distribution policy must be owner-installed-only and imageBundled=false.",
    "The distributed Dockerfile must not install @anthropic-ai/claude-code.",
    "Third-party notices must document the owner-initiated Claude installation boundary."
  ]);
});

test("public release readiness accepts the exact non-redistribution policy", () => {
  const result = evaluatePublicRelease({
    requestedVersion: "0.1.0",
    packageVersion: "0.1.0",
    notices,
    dockerfile: "FROM node:22\n",
    distributionPolicy: policy
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
});

test("readiness CLI validates an exact refreshed 1.2 prerelease seed and rejects stale seeds", () => {
  const root = new URL("../../", import.meta.url); const fixture = mkdtempSync(join(tmpdir(), "space-seed-release-"));
  try {
    for (const path of ["scripts/public-release-readiness.mjs", "scripts/release-version.mjs", "scripts/space-shared-memory-seed.mjs", "packages/contracts/src/nous-shared-memory.ts"]) {
      const target = join(fixture, path); mkdirSync(dirname(target), { recursive: true }); cpSync(new URL(path, root), target);
    }
    symlinkSync(fileURLToPath(new URL("node_modules", root)), join(fixture, "node_modules"), "dir");
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(join(fixture, "packages/run-spaceapp"), { recursive: true });
    writeFileSync(join(fixture, "packages/run-spaceapp/package.json"), JSON.stringify({ version: "1.2.0-hostroot.0" }));
    mkdirSync(join(fixture, "docs/legal"), { recursive: true });
    writeFileSync(join(fixture, "docs/legal/cli-distribution-policy.json"), JSON.stringify(policy));
    writeFileSync(join(fixture, "THIRD_PARTY_NOTICES.md"), notices); writeFileSync(join(fixture, "Dockerfile"), "FROM node:22\n");
    for (const path of ["packages/contracts/src/nous-shared-memory-seed.ts", "packages/db/src/nous-shared-memory-repository.ts", "packages/db/migrations/0266_nous_shared_memory.sql", "apps/api/src/nous/wiring.ts"]) {
      mkdirSync(dirname(join(fixture, path)), { recursive: true });
      writeFileSync(join(fixture, path), path.endsWith("wiring.ts") ? "registerSharedMemoryRoutes sharedMemory.ready sharedMemory.world" : "fixture");
    }
    const seedPath = join(fixture, "packages/contracts/src/nous-shared-memory-seed.json");
    const seed = JSON.parse(readFileSync(new URL("packages/contracts/src/nous-shared-memory-seed.json", root), "utf8"));
    writeFileSync(seedPath, JSON.stringify({ ...seed, releaseVersion: "1.2.0-hostroot.0" }));
    const args = [join(fixture, "scripts/public-release-readiness.mjs"), "--version", "1.2.0-hostroot.0", "--npm-tag", "personal", "--release-mode", "full", "--runtime-version", "1.2.0-hostroot.0"];
    assert.equal(JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).ok, true);
    writeFileSync(join(fixture, "apps/api/src/nous/wiring.ts"), "older core without shared memory");
    assert.throws(() => execFileSync(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] }));
    writeFileSync(seedPath, JSON.stringify(seed));
    assert.throws(() => execFileSync(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] }));
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
