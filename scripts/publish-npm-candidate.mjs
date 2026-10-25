#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isRegistrySafeReleaseVersion } from "./release-version.mjs";

const registry = "https://registry.npmjs.org/run-spaceapp";

export async function registryJson(url) {
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(30_000)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry query failed: HTTP ${response.status}`);
  return response.json();
}

export function verifyIdentity(metadata, { version, gitHead, integrity }) {
  if (metadata?.name !== "run-spaceapp" || metadata.version !== version ||
      metadata.gitHead !== gitHead || metadata.dist?.integrity !== integrity) {
    throw new Error("Published npm candidate differs in name, version, gitHead or tarball integrity; refusing publication.");
  }
}

export async function publishCandidate({
  version, gitHead, tag, integrity, publish,
  query = registryJson,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = console.log,
  attempts = 60
}) {
  if (!isRegistrySafeReleaseVersion(version) || !/^[a-f0-9]{40}$/.test(gitHead) ||
      !["next", "personal"].includes(tag) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new Error("Invalid npm candidate identity or prerelease channel.");
  }
  const versionUrl = `${registry}/${encodeURIComponent(version)}`;
  const existing = await query(versionUrl);
  if (existing) {
    verifyIdentity(existing, { version, gitHead, integrity });
    log("Exact npm candidate already exists; publication is not repeated.");
  } else {
    await publish();
  }

  // Read JSON directly from the registry, independently of npm workspace output
  // formatting/cache. Allow propagation after a successful immutable publish.
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let metadata, tags;
    try {
      metadata = await query(versionUrl);
      tags = await query("https://registry.npmjs.org/-/package/run-spaceapp/dist-tags");
    } catch (error) {
      log(`Registry verification attempt ${attempt}: ${error.message}`);
    }
    if (metadata) {
      verifyIdentity(metadata, { version, gitHead, integrity });
      if (tags?.[tag] === version && metadata.dist?.attestations?.provenance) {
        log(`Verified run-spaceapp@${version}, ${tag}, gitHead, SHA-512 and provenance metadata.`);
        return { published: !existing, version, gitHead, integrity, tag };
      }
    }
    if (attempt < attempts) await sleep(5000);
  }
  throw new Error("npm publication exists or may have succeeded, but registry verification is incomplete. Retry the failed job; do not republish or change immutable artifacts.");
}

export async function runCli(tarball, env = process.env) {
  if (!tarball) throw new Error("Usage: publish-npm-candidate.mjs <reviewed-tarball>");
  const integrity = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`;
  const manifestResult = spawnSync("tar", ["-xOf", tarball, "package/package.json"], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024
  });
  if (manifestResult.status !== 0) throw new Error("Cannot read reviewed tarball manifest.");
  const manifest = JSON.parse(manifestResult.stdout);
  const { RELEASE_VERSION: version, RELEASE_GIT_HEAD: gitHead, RELEASE_DIST_TAG: tag } = env;
  verifyIdentity({ ...manifest, dist: { integrity } }, { version, gitHead, integrity });
  return publishCandidate({ version, gitHead, tag, integrity, publish: async () => {
    const result = spawnSync("npm", ["publish", tarball, "--tag", tag, "--provenance"], {
      stdio: "inherit", timeout: 120_000
    });
    if (result.status !== 0) throw new Error("npm publish failed; inspect the registry before retrying.");
  } });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli(process.argv[2]).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
