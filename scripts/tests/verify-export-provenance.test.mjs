import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyExportProvenance } from "../verify-export-provenance.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const blob = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");

test("separates unchanged and sanitized files and reports any file that differs from the manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-provenance-"));
  await writeFile(join(root, "same.txt"), "same\n");
  await writeFile(join(root, "clean.txt"), "public value\n");
  await writeFile(join(root, "edited.txt"), "edited after export\n");
  const files = [
    { path: "same.txt", sourceObjectId: blob("same\n"), sha256: sha256("same\n"), size: 5 },
    { path: "clean.txt", sourceObjectId: blob("private value\n"), sha256: sha256("public value\n"), size: 13 },
    { path: "edited.txt", sourceObjectId: blob("x\n"), sha256: sha256("original\n"), size: 9 }
  ];
  await writeFile(join(root, "PUBLIC_EXPORT_MANIFEST.json"), JSON.stringify({ sourceCommit: "a".repeat(40), transformations: 1, files }));
  const result = await verifyExportProvenance(root);
  assert.equal(result.unchanged, 1);
  assert.deepEqual(result.sanitized, ["clean.txt"]);
  assert.deepEqual(result.problems, ["differs from the manifest: edited.txt"]);
});
