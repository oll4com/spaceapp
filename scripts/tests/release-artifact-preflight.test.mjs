import assert from "node:assert/strict";
import test from "node:test";
import { evaluateArtifactAvailability } from "../release-artifact-preflight.mjs";

const absent = {
  status: 1,
  output: "manifest unknown: manifest unknown"
};

test("artifact preflight accepts only authoritative not-found responses", () => {
  const result = evaluateArtifactAvailability({
    releaseMode: "full",
    version: "0.1.4",
    npm: { status: 1, output: "npm error code E404" },
    images: {
      core: absent,
      cli: absent,
      browser: absent
    }
  });

  assert.deepEqual(result, { ok: true, blockers: [] });
});

test("artifact preflight blocks an existing npm version or image tag", () => {
  const result = evaluateArtifactAvailability({
    releaseMode: "full",
    version: "0.1.4",
    npm: { status: 0, output: "0.1.4" },
    images: {
      core: { status: 0, output: "Name: ghcr.io/oll4com/spaceapp-core:0.1.4" },
      cli: absent,
      browser: absent
    }
  });

  assert.deepEqual(result.blockers, [
    "npm package run-spaceapp@0.1.4 already exists.",
    "GHCR tag ghcr.io/oll4com/spaceapp-core:0.1.4 already exists."
  ]);
});

test("artifact preflight fails closed on registry or network ambiguity", () => {
  const result = evaluateArtifactAvailability({
    releaseMode: "full",
    version: "0.1.4",
    npm: { status: 1, output: "npm error code ETIMEDOUT" },
    images: {
      core: {
        status: 1,
        output: "docker-credential-secretservice: executable file not found"
      },
      cli: absent,
      browser: absent
    }
  });

  assert.deepEqual(result.blockers, [
    "Could not prove that npm package run-spaceapp@0.1.4 is absent.",
    "Could not prove that GHCR tag ghcr.io/oll4com/spaceapp-core:0.1.4 is absent."
  ]);
});

test("launcher-only preflight requires a new npm version but reuses existing images", () => {
  const existing = { status: 0, output: "existing immutable image" };
  const result = evaluateArtifactAvailability({
    releaseMode: "launcher-only",
    version: "0.1.15-hostroot.1",
    npm: { status: 1, output: "npm error code E404" },
    images: {
      core: existing,
      cli: existing,
      browser: existing
    }
  });

  assert.deepEqual(result, { ok: true, blockers: [] });
});

test("amd64 core and CLI preflight reserves new tags for every runtime service", () => {
  const result = evaluateArtifactAvailability({
    releaseMode: "amd64-core-cli",
    version: "0.1.15-hostroot.2",
    npm: { status: 1, output: "npm error code E404" },
    images: {
      core: absent,
      cli: absent,
      browser: absent
    }
  });

  assert.deepEqual(result, { ok: true, blockers: [] });
});
