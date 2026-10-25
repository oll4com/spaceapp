import { readFileSync } from "node:fs";

// The release writes templates/images.lock.json into the published package after it built and verified the images
// (scripts/embed-image-lock.mjs), so an install pulls SpaceApp's own images by digest instead of a movable version
// tag (external review 2026-10-16 #8). A source checkout has no lock and keeps pulling by tag; a lock that is present
// but invalid stops the launcher instead of falling back to tags.
export const IMAGE_TARGETS = ["core", "cli", "browser"];
export const IMAGE_REPOSITORY = "ghcr.io/oll4com/spaceapp";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function parseImageLock(text) {
  const lock = JSON.parse(text);
  const images = lock?.images;
  if (
    lock?.schemaVersion !== 1 ||
    typeof lock.runtimeVersion !== "string" || !VERSION_PATTERN.test(lock.runtimeVersion) ||
    typeof images !== "object" || images === null ||
    Object.keys(images).sort().join(",") !== [...IMAGE_TARGETS].sort().join(",") ||
    !IMAGE_TARGETS.every((target) => DIGEST_PATTERN.test(images[target] ?? ""))
  ) {
    throw new Error("images.lock.json needs schemaVersion 1, a runtimeVersion and a sha256 digest for core, cli and browser.");
  }
  return { schemaVersion: 1, runtimeVersion: lock.runtimeVersion, images: { ...images } };
}

export function readImageLock(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    return parseImageLock(text);
  } catch (error) {
    throw new Error(`This run-spaceapp package carries an invalid image lock: ${error.message}`);
  }
}

export const PACKAGE_IMAGE_LOCK = readImageLock(new URL("../templates/images.lock.json", import.meta.url));

/**
 * The digests an installation recorded for each runtime version it ran with a lock (image-digests.json next to
 * runtime.env), so a rollback to that version pulls the same images by digest (1.1.7 review, Codex #7). Only well-formed
 * entries count; anything else is ignored.
 */
export function parseRecordedDigests(text) {
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { return {}; }
  const recorded = {};
  for (const [version, images] of Object.entries(parsed && typeof parsed === "object" ? parsed : {})) {
    if (VERSION_PATTERN.test(version) && IMAGE_TARGETS.every((target) => DIGEST_PATTERN.test(images?.[target] ?? ""))) {
      recorded[version] = Object.fromEntries(IMAGE_TARGETS.map((target) => [target, images[target]]));
    }
  }
  return recorded;
}

/** The digest pinned for this runtime version: the package lock's for its own version, else the recorded one, else null. */
export function pinnedImageDigest(target, runtimeVersion, lock = PACKAGE_IMAGE_LOCK, recorded = {}) {
  if (lock?.runtimeVersion === runtimeVersion) return lock.images[target];
  return recorded[runtimeVersion]?.[target] ?? null;
}

/** runtime.env lines read by compose.yml: `@sha256:…` appended to the version tag, or empty. */
export function imageDigestEnv(runtimeVersion, lock = PACKAGE_IMAGE_LOCK, recorded = {}) {
  return IMAGE_TARGETS.map((target) => {
    const digest = pinnedImageDigest(target, runtimeVersion, lock, recorded);
    return `SPACEAPP_${target.toUpperCase()}_IMAGE_DIGEST=${digest ? `@${digest}` : ""}`;
  });
}

/**
 * Local references of a SpaceApp image. An image pulled by digest has no local version tag, so the digest reference
 * comes first when pinned; the tag still finds images loaded locally (development, devtest local images).
 */
export function localImageRefs(target, runtimeVersion, digest = pinnedImageDigest(target, runtimeVersion)) {
  const tagRef = `${IMAGE_REPOSITORY}-${target}:${runtimeVersion}`;
  return digest ? [`${IMAGE_REPOSITORY}-${target}@${digest}`, tagRef] : [tagRef];
}
