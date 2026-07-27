import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePublicRelease } from "../public-release-readiness.mjs";

const policy = {
  schemaVersion: 1,
  packages: {
    "@anthropic-ai/claude-code": {
      version: "2.1.206",
      distribution: "owner-installed-only",
      imageBundled: false
    }
  }
};

const notices = [
  "Claude Code (`@anthropic-ai/claude-code@2.1.206`)",
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
    "Requested version 0.1.1 does not match run-spaceapp 0.1.0."
  ]);
});

test("public release readiness accepts exact semantic prerelease versions", () => {
  const result = evaluatePublicRelease({
    requestedVersion: "0.1.15-hostroot.0",
    packageVersion: "0.1.15-hostroot.0",
    notices,
    dockerfile: "FROM node:22\n",
    distributionPolicy: policy
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
});

test("public release readiness requires a positive owner-installed-only Claude record", () => {
  const result = evaluatePublicRelease({
    requestedVersion: "0.1.0",
    packageVersion: "0.1.0",
    notices: notices.replace("owner-initiated", "manual"),
    dockerfile: "RUN npm install @anthropic-ai/claude-code@2.1.206\n",
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
