import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pruneForeignTemporalBinaries } from "../container-prune-platform-binaries.mjs";

test("prunes foreign Temporal release binaries for each supported Linux architecture", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spaceapp-temporal-prune-"));
  const releases = path.join(root, "node_modules", "@temporalio", "core-bridge", "releases");
  const platforms = [
    "aarch64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu"
  ];
  try {
    for (const platform of platforms) mkdirSync(path.join(releases, platform), { recursive: true });

    assert.equal(pruneForeignTemporalBinaries(root, "amd64").length, 4);
    assert.deepEqual(readdirSync(releases), ["x86_64-unknown-linux-gnu"]);

    for (const platform of platforms.filter((name) => name !== "x86_64-unknown-linux-gnu")) {
      mkdirSync(path.join(releases, platform), { recursive: true });
    }
    assert.equal(pruneForeignTemporalBinaries(root, "arm64").length, 4);
    assert.deepEqual(readdirSync(releases), ["aarch64-unknown-linux-gnu"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsupported architectures and tolerates workspaces without Temporal", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spaceapp-temporal-prune-"));
  try {
    assert.throws(() => pruneForeignTemporalBinaries(root, "riscv64"), /Unsupported Docker architecture/);
    assert.deepEqual(pruneForeignTemporalBinaries(root, "amd64"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
