import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test("names the public commit that edited an exported file outside the export", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-provenance-git-"));
  const git = (...args) => execFileSync("git", ["-C", root, "-c", "user.name=SpaceApp export", "-c", "user.email=export@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  await writeFile(join(root, "README.md"), "exported\n");
  const files = [{ path: "README.md", sourceObjectId: blob("exported\n"), sha256: sha256("exported\n"), size: 9 }];
  await writeFile(join(root, "PUBLIC_EXPORT_MANIFEST.json"), JSON.stringify({ sourceCommit: "a".repeat(40), transformations: 0, files }));
  git("add", "-A");
  git("commit", "-qm", "release: export");
  await writeFile(join(root, "README.md"), "exported\nbadge\n");
  git("commit", "-qam", "docs: add a badge", "--author=Web Editor <web@example.invalid>");
  const result = await verifyExportProvenance(root);
  assert.deepEqual(result.problems, [`differs from the manifest: README.md (edited on public main outside the export by ${git("rev-parse", "--short", "HEAD")} Web Editor: docs: add a badge; port the change into SpaceApp's source so the next export carries it)`]);
});
