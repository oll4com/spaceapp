#!/usr/bin/env node
// Resolves deploy/docker/provider-locks/<provider>.json, the lockfile each optional CLI is installed from on first use
// (review INT5-C-F14). Run it after changing a pin in deploy/docker/provider-install.mjs; it needs the npm registry and
// installs nothing.
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providers, vendorManifest } from "../deploy/docker/provider-install.mjs";

const work = await mkdtemp(join(tmpdir(), "provider-locks-"));
try {
  for (const [name, entry] of Object.entries(providers)) {
    if (!entry.package) continue;
    const directory = join(work, name);
    await mkdir(directory);
    await writeFile(join(directory, "package.json"), `${JSON.stringify(vendorManifest(entry), null, 2)}\n`);
    execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: directory, stdio: "inherit" });
    await copyFile(join(directory, "package-lock.json"), new URL(`../deploy/docker/provider-locks/${name}.json`, import.meta.url));
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
