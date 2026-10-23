import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  extractPinnedImages,
  initializeSecrets,
  parseCommand
} from "../dev-stack.mjs";

test("parseCommand correctly resolves up, down, reset", () => {
  assert.equal(parseCommand([]), "up");
  assert.equal(parseCommand(["down"]), "down");
  assert.equal(parseCommand(["reset"]), "reset");
  assert.equal(parseCommand(["unknown"]), "up");
});

test("extractPinnedImages reads postgres and temporal images by digest from compose template", () => {
  const images = extractPinnedImages();
  assert.match(images.postgresImage, /^pgvector\/pgvector:.*@sha256:[a-f0-9]{64}$/);
  assert.match(images.temporalImage, /^temporalio\/auto-setup:.*@sha256:[a-f0-9]{64}$/);
});

test("initializeSecrets generates securely isolated secrets with mode 0600", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "spaceapp-secrets-test-"));
  try {
    const secrets1 = initializeSecrets(tempDir);
    assert.ok(secrets1.dbPassword.length >= 24);
    assert.ok(secrets1.sessionSecret.length >= 32);
    assert.match(secrets1.setupToken, /^dev-setup-[a-f0-9]{32}$/);

    // Re-reading loads same generated secrets
    const secrets2 = initializeSecrets(tempDir);
    assert.equal(secrets1.dbPassword, secrets2.dbPassword);
    assert.equal(secrets1.sessionSecret, secrets2.sessionSecret);
    assert.equal(secrets1.setupToken, secrets2.setupToken);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
