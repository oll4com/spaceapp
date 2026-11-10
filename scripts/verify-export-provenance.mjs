#!/usr/bin/env node
// Checks this checkout against PUBLIC_EXPORT_MANIFEST.json without access to the private tree:
// every exported file must match the manifest's SHA-256 and size; a file whose bytes still hash to
// the recorded private git blob id was exported unchanged, any other file was sanitized.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function blobId(buffer, recorded) {
  return createHash(recorded.length === 64 ? "sha256" : "sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

// Exported files change only through the export: a commit on public main that edited one is named, so the failure says
// who changed what and where the change belongs. A shallow or missing history names nothing.
function editedAfterExport(root, path) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const lastExport = git("log", "-1", "--format=%H", "--", "PUBLIC_EXPORT_MANIFEST.json");
    const commits = lastExport ? git("log", "--no-merges", "--format=%h %an: %s", `${lastExport}..HEAD`, "--", path) : "";
    return commits ? ` (edited on public main outside the export by ${commits.split("\n").join("; ")}; port the change into SpaceApp's source so the next export carries it)` : "";
  } catch {
    return "";
  }
}

export async function verifyExportProvenance(root) {
  const manifest = JSON.parse(await readFile(join(root, "PUBLIC_EXPORT_MANIFEST.json"), "utf8"));
  const result = { sourceCommit: manifest.sourceCommit, files: manifest.files.length, unchanged: 0, sanitized: [], problems: [] };
  for (const file of manifest.files) {
    let buffer;
    try { buffer = await readFile(join(root, file.path)); } catch { result.problems.push(`missing: ${file.path}`); continue; }
    if (buffer.length !== file.size || createHash("sha256").update(buffer).digest("hex") !== file.sha256) {
      result.problems.push(`differs from the manifest: ${file.path}${editedAfterExport(root, file.path)}`);
    } else if (blobId(buffer, file.sourceObjectId) === file.sourceObjectId) {
      result.unchanged += 1;
    } else {
      result.sanitized.push(file.path);
    }
  }
  if (result.sanitized.length !== manifest.transformations) {
    result.problems.push(`manifest records ${manifest.transformations} transformations, found ${result.sanitized.length}`);
  }
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await verifyExportProvenance(resolve(process.argv[2] ?? "."));
  process.stdout.write(`${JSON.stringify({ ...result, ok: result.problems.length === 0 }, null, 2)}\n`);
  if (result.problems.length) process.exitCode = 1;
}
