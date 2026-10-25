#!/usr/bin/env node
// Release step: after the SpaceApp images are published and verified, write their digests into the tested npm
// candidate (templates/images.lock.json) so installs pull them by digest (external review 2026-10-16 #8). The repacked
// tarball must differ from the tested one only by that file. The lock is never committed: the cross-platform evidence
// is bound to the committed tree (scripts/release-evidence.mjs).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { IMAGE_REPOSITORY, IMAGE_TARGETS, parseImageLock } from "../packages/run-spaceapp/src/image-lock.mjs";

const execFileAsync = promisify(execFile);
const LOCK_PATH = "templates/images.lock.json";

/** Digest of the image index the registry serves for a reference. */
export async function imagetoolsDigest(ref, run = execFileAsync) {
  const { stdout } = await run("docker", ["buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest}}"], { maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout).digest;
}

export async function resolveImageDigests(runtimeVersion, inspect = imagetoolsDigest) {
  const images = {};
  for (const target of IMAGE_TARGETS) images[target] = await inspect(`${IMAGE_REPOSITORY}-${target}:${runtimeVersion}`);
  return parseImageLock(JSON.stringify({ schemaVersion: 1, runtimeVersion, images }));
}

async function fileHashes(root) {
  const hashes = new Map();
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) hashes.set(relative(root, path), createHash("sha256").update(await readFile(path)).digest("hex"));
      else throw new Error(`Unexpected non-file entry in the npm package: ${relative(root, path)}`);
    }
  };
  await walk(root);
  return hashes;
}

/** Every tested file is unchanged and the lock is the only new file. */
export function assertOnlyLockAdded(tested, pinned, lockHash) {
  const problems = [];
  for (const [path, hash] of tested) if (pinned.get(path) !== hash) problems.push(`changed or missing: ${path}`);
  for (const path of pinned.keys()) if (!tested.has(path) && path !== LOCK_PATH) problems.push(`unexpected: ${path}`);
  if (pinned.get(LOCK_PATH) !== lockHash) problems.push(`${LOCK_PATH} is missing or differs from the resolved digests`);
  if (problems.length) throw new Error(`The pinned npm package differs from the tested candidate: ${problems.join("; ")}`);
}

export async function embedImageLock({ tarball, runtimeVersion, outDir, inspect = imagetoolsDigest, run = execFileAsync }) {
  const work = await mkdtemp(join(tmpdir(), "spaceapp-image-lock-"));
  try {
    for (const name of ["tested", "pinned", "check"]) await mkdir(join(work, name));
    await run("tar", ["-xzf", tarball, "-C", join(work, "tested")]);
    await run("tar", ["-xzf", tarball, "-C", join(work, "pinned")]);
    const packageDir = join(work, "pinned", "package");
    const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    if (manifest.name !== "run-spaceapp" || manifest.spaceappRuntimeVersion !== runtimeVersion) {
      throw new Error(`The candidate is ${manifest.name}@${manifest.version} for runtime ${manifest.spaceappRuntimeVersion}, not runtime ${runtimeVersion}.`);
    }
    if (await stat(join(packageDir, LOCK_PATH)).then(() => true, () => false)) {
      throw new Error(`The tested candidate already carries ${LOCK_PATH}; only this release step writes it.`);
    }
    const lock = await resolveImageDigests(runtimeVersion, inspect);
    const lockText = `${JSON.stringify(lock, null, 2)}\n`;
    await writeFile(join(packageDir, LOCK_PATH), lockText, { flag: "wx" });
    await mkdir(outDir, { recursive: true });
    const { stdout } = await run("npm", ["pack", packageDir, "--pack-destination", outDir, "--json"], { maxBuffer: 16 * 1024 * 1024 });
    const pinnedTarball = join(outDir, JSON.parse(stdout)[0].filename);
    await run("tar", ["-xzf", pinnedTarball, "-C", join(work, "check")]);
    assertOnlyLockAdded(
      await fileHashes(join(work, "tested", "package")),
      await fileHashes(join(work, "check", "package")),
      createHash("sha256").update(lockText).digest("hex")
    );
    return { tarball: pinnedTarball, lock };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!value || !["--tarball", "--runtime-version", "--out-dir"].includes(flag)) {
      throw new Error("Usage: embed-image-lock.mjs --tarball <candidate.tgz> --runtime-version <x.y.z> --out-dir <dir>");
    }
    options[flag.slice(2).replace(/-(\w)/g, (_, letter) => letter.toUpperCase())] = value;
  }
  if (!options.tarball || !options.runtimeVersion || !options.outDir) throw new Error("--tarball, --runtime-version and --out-dir are required.");
  return options;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const result = await embedImageLock(parseArguments(process.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
