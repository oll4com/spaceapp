import { Writable } from "node:stream";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { composeCommand, profileRuntimeSettings, PROFILE_REQUIREMENTS } from "./index.mjs";
import { localImageRefs } from "./image-lock.mjs";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
// Upper bounds include extraction/transfer headroom, not the size of existing data.
const imageReserve = { core: 1.4 * GiB, cli: 3.8 * GiB, browser: 2.2 * GiB, postgres: 700 * MiB, temporal: 800 * MiB };

/**
 * Captures probe command output from stdout with a 1MB limit.
 *
 * @param {Function} execute Command execution function.
 * @param {object} spec Command specification object.
 * @returns {Promise<string|null>} Captured stdout string or null on error.
 */
export async function captureProbe(execute, spec) {
  let output = "";
  const stdout = new Writable({ write(chunk, _encoding, done) {
    if (output.length < 1024 * 1024) output += chunk.toString();
    done();
  } });
  try {
    const code = await execute({ ...spec, timeoutMs: 15000 }, { stdout, stderr: null });
    return code === 0 ? output.trim() : null;
  } catch { return null; }
}

/**
 * Calculates total size in bytes of existing SpaceApp configuration, secrets, and compose files.
 *
 * @param {string} root Installation root directory path.
 * @returns {Promise<number>} Total size in bytes.
 */
async function configurationBytes(root) {
  let bytes = 0;
  // Checkpoints copy configuration and secrets; workspaces/volumes are retained in place.
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) bytes += (await stat(child)).size;
    }
  }
  await walk(join(root, "secrets"));
  for (const file of ["config.json", "runtime.env", "compose.yml", "compose.workspaces.yml", "compose.host-access.yml"]) {
    bytes += (await stat(join(root, file)).catch(() => ({ size: 0 }))).size;
  }
  return bytes;
}

/**
 * Computes storage plan including required and checkpoint disk bytes for an operation.
 *
 * @param {object} options Calculation parameters.
 * @param {string} options.operation Operation type ("fresh", "upgrade", etc.).
 * @param {string} options.profile Resource profile name.
 * @param {number} [options.missingImageBytes=0] Size of missing container images in bytes.
 * @param {number} [options.databaseBytes=0] Size of database data in bytes.
 * @param {number} [options.configBytes=0] Size of configuration files in bytes.
 * @param {boolean} [options.databaseSizeKnown=true] Whether database size was successfully measured.
 * @returns {object} Calculated storage plan object.
 */
export function calculateStoragePlan({ operation, profile, missingImageBytes = 0, databaseBytes = 0, configBytes = 0, databaseSizeKnown = true }) {
  const checkpointBytes = operation === "upgrade"
    ? Math.max(64 * MiB, databaseSizeKnown ? databaseBytes * 3 + configBytes : 512 * MiB + configBytes)
    : 0;
  return {
    operation, missingImageBytes, checkpointBytes, databaseSizeKnown,
    requiredDiskBytes: Math.ceil(missingImageBytes + checkpointBytes + 512 * MiB),
    freshDiskBytes: PROFILE_REQUIREMENTS[profile].freshDiskBytes
  };
}

/**
 * Estimates missing layer byte size with extraction headroom for uncached image layers.
 *
 * @param {Array<{ size: number }>} layers Image layer descriptors from manifest.
 * @param {string[]} diffIds Uncompressed layer diff IDs from image config.
 * @param {Set<string>} cachedLayers Set of layer diff IDs already present locally.
 * @returns {number} Estimated bytes required for missing layers.
 */
export function estimateMissingLayers(layers, diffIds, cachedLayers) {
  if (!Array.isArray(layers) || layers.length !== diffIds?.length) throw new Error("Invalid image layer metadata.");
  let bytes = 0;
  for (let i = 0; i < layers.length; i++) {
    if (cachedLayers.has(diffIds[i])) continue;
    if (!Number.isSafeInteger(layers[i].size) || layers[i].size < 0) throw new Error("Invalid image layer size.");
    bytes += Math.max(64 * MiB, layers[i].size * 5);
  }
  return bytes;
}

/**
 * Fetches registry image manifest and rootfs layer diff IDs from GHCR.
 *
 * @param {string} image Full container image reference name.
 * @param {string} arch Target CPU architecture ("amd64" or "arm64").
 * @param {Function} fetch HTTP fetch implementation function.
 * @returns {Promise<{ layers: Array<{ size: number }>, diffIds: string[] }|null>}
 */
async function registryLayers(image, arch, fetch) {
  const match = /^ghcr\.io\/(oll4com\/spaceapp-(?:core|cli|browser)):([0-9]+\.[0-9]+\.[0-9]+)$/.exec(image);
  if (!match) return null;
  const repository = match[1], tag = match[2];
  const requestJson = async (url, headers = {}) => {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000), redirect: "follow" });
    if (!response.ok) throw new Error("Public image metadata unavailable.");
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error("Oversized image metadata.");
    return JSON.parse(text);
  };
  const credentials = await requestJson(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`);
  if (typeof credentials.token !== "string") return null;
  const headers = { authorization: `Bearer ${credentials.token}`, accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" };
  let manifest = await requestJson(`https://ghcr.io/v2/${repository}/manifests/${tag}`, headers);
  if (manifest.manifests) {
    const descriptor = manifest.manifests.find((item) => item.platform?.os === "linux" && item.platform?.architecture === arch);
    if (!/^sha256:[a-f0-9]{64}$/.test(descriptor?.digest ?? "")) return null;
    manifest = await requestJson(`https://ghcr.io/v2/${repository}/manifests/${descriptor.digest}`, headers);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.config?.digest ?? "")) return null;
  const config = await requestJson(`https://ghcr.io/v2/${repository}/blobs/${manifest.config.digest}`, headers);
  return { layers: manifest.layers, diffIds: config.rootfs?.diff_ids };
}

// The digests the existing installation pinned (its runtime.env), so its by-digest images count as cached.
async function installedImageDigests(root, version) {
  let text = "";
  try { text = await readFile(join(root, "runtime.env"), "utf8"); } catch { return {}; }
  if (!text.split("\n").includes(`SPACEAPP_IMAGE_TAG=${version}`)) return {};
  const digests = {};
  for (const [, type, digest] of text.matchAll(/^SPACEAPP_(CORE|CLI|BROWSER)_IMAGE_DIGEST=@(sha256:[a-f0-9]{64})$/gm)) digests[type.toLowerCase()] = digest;
  return digests;
}

/**
 * Inspects system and engine storage requirements, cached layers, and free space.
 * Supports Docker and Podman container engines.
 *
 * @param {object} options Storage inspection options.
 * @param {string} options.root Installation root directory.
 * @param {object} options.config Target configuration.
 * @param {object} [options.existingConfig] Currently installed configuration.
 * @param {object} options.resources Detected system resources.
 * @param {Function} options.execute Command execution function.
 * @param {string} options.operation Current operation ("fresh", "repair", "upgrade").
 * @param {Function} [options.fetch=globalThis.fetch] Fetch implementation.
 * @returns {Promise<object>} Complete storage plan and engine-constrained resources.
 */
export async function inspectStoragePlan({ root, config, existingConfig, resources, execute, operation, fetch = globalThis.fetch }) {
  const engineCommand = (config?.engine === "podman" || existingConfig?.engine === "podman") ? "podman" : "docker";
  const dockerInfo = await captureProbe(execute, { command: engineCommand, args: ["info", "--format", "{{json .}}"] });
  let engine = null;
  try { engine = JSON.parse(dockerInfo); } catch { /* Conservative reserve when the engine is unavailable. */ }
  const cachedLayers = new Set();
  if (engine && existingConfig) {
    const existingDigests = await installedImageDigests(root, existingConfig.version);
    for (const type of ["core", "cli", "browser"]) {
      for (const ref of localImageRefs(type, existingConfig.version, existingDigests[type])) {
        const output = await captureProbe(execute, { command: engineCommand, args: ["image", "inspect", "--format", "{{json .RootFS.Layers}}", ref] });
        try { for (const layer of JSON.parse(output)) cachedLayers.add(layer); break; } catch {}
      }
    }
  }
  const settings = profileRuntimeSettings(config.profile);
  const images = [
    ["core", `ghcr.io/oll4com/spaceapp-core:${config.version}`],
    ["cli", `ghcr.io/oll4com/spaceapp-cli:${config.version}`],
    ["postgres", "pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b"],
    ...(settings.browserEnabled ? [["browser", `ghcr.io/oll4com/spaceapp-browser:${config.version}`]] : []),
    ...(settings.temporalEnabled ? [["temporal", "temporalio/auto-setup:1.29.1@sha256:5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312"]] : []),
    ...(config.companionsEnabled ? [["companion", "ghcr.io/soju06/codex-lb:1.22.0@sha256:3010b3c5567522fbb6e7225bdbe963fa1038c2584641fcec69094875e40e36e5"], ["companion", "ghcr.io/oll4com/headroom-codex-lb:code-5b15319@sha256:491c856a8bd8205d45e980370c3ffe7ffe438b6444216c36ac7c60ad24308aa2"]] : [])
  ];
  let missingImageBytes = 0;
  const missingImages = [];
  let sharedLayersEstimated = false;
  for (const [type, image] of images) {
    // SpaceApp images pulled by digest have no local version tag: look them up by their pinned digest as well.
    const refs = ["core", "cli", "browser"].includes(type) ? localImageRefs(type, config.version) : [image];
    let cached = null;
    for (const ref of refs) {
      cached = await captureProbe(execute, { command: engineCommand, args: ["image", "inspect", "--format", "{{.Id}}", ref] });
      if (/^(?:sha256:)?[a-f0-9]{64}$/.test(cached ?? "")) break;
    }
    if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(cached ?? "")) {
      missingImages.push(image);
      let reserve = imageReserve[type] ?? GiB;
      if (engine && existingConfig && cachedLayers.size && typeof fetch === "function") {
        try {
          const metadata = await registryLayers(image, /arm|aarch64/.test(engine?.Architecture ?? engine?.host?.arch ?? "") ? "arm64" : "amd64", fetch);
          if (metadata) { reserve = estimateMissingLayers(metadata.layers, metadata.diffIds, cachedLayers); sharedLayersEstimated = true; }
        } catch { /* Offline/private registry: retain the full conservative reserve. */ }
      }
      missingImageBytes += reserve;
    }
  }
  let databaseBytes = 0, databaseSizeKnown = true;
  if (operation === "upgrade") {
    const size = await captureProbe(execute, composeCommand("databaseSize", root, { ...(existingConfig ?? config), engine: engineCommand }));
    databaseSizeKnown = /^\d+$/.test(size ?? "");
    if (databaseSizeKnown) databaseBytes = Number(size);
  }
  const plan = calculateStoragePlan({ operation, profile: config.profile, missingImageBytes, databaseBytes,
    configBytes: await configurationBytes(root), databaseSizeKnown });
  plan.engine = engineCommand;
  let dockerFreeDiskBytes = null;
  if (existingConfig) {
    const free = await captureProbe(execute, composeCommand("storageFree", root, { ...existingConfig, engine: engineCommand }));
    if (/^\d+$/.test(free ?? "")) dockerFreeDiskBytes = Number(free);
  }
  // Linux can measure the engine storage directory directly even on a fresh install.
  const rootDir = engine?.DockerRootDir || engine?.store?.graphRoot || engine?.graphRoot || engine?.GraphRoot;
  if (rootDir && process.platform === "linux") {
    const { inspectSystemResources } = await import("./index.mjs");
    try { dockerFreeDiskBytes = (await inspectSystemResources(rootDir)).freeDiskBytes; } catch {}
  }
  return { ...plan, missingImages, sharedLayersEstimated, dockerFreeDiskBytes,
    resources: { ...resources,
      freeDiskBytes: dockerFreeDiskBytes === null ? resources.freeDiskBytes : Math.min(resources.freeDiskBytes, dockerFreeDiskBytes),
      engineCpuCount: engine?.NCPU ?? engine?.host?.cpus,
      engineMemoryBytes: engine?.MemTotal ?? engine?.host?.memTotal
    } };
}

/**
 * Generates storage health checks comparing available space against calculated storage plans.
 *
 * @param {object} plan Storage plan from calculateStoragePlan / inspectStoragePlan.
 * @param {object} resources Current system and engine resources.
 * @returns {Array<{ name: string, ok: boolean, detail: string }>} Array of storage checks.
 */
export function storageChecks(plan, resources) {
  const engineLabel = plan?.engine === "podman" ? "Podman" : "Docker";
  const checks = [{ name: "Free disk", ok: resources.freeDiskBytes >= plan.requiredDiskBytes,
    detail: `${gib(resources.freeDiskBytes)} GiB available; ${gib(plan.requiredDiskBytes)} GiB required additionally for ${plan.operation} (images ${gib(plan.missingImageBytes)}, checkpoint ${gib(plan.checkpointBytes)}, reserve 0.5)` }];
  if (plan.dockerFreeDiskBytes !== null) checks.push({ name: `${engineLabel} storage`, ok: plan.dockerFreeDiskBytes >= plan.requiredDiskBytes,
    detail: `${gib(plan.dockerFreeDiskBytes)} GiB available; ${gib(plan.requiredDiskBytes)} GiB required additionally` });
  else checks.push({ name: `${engineLabel} storage`, ok: true, detail: `Separate engine disk capacity unavailable; host estimate used. ${engineLabel} ENOSPC will stop the operation before cutover.` });
  return checks;
}

/**
 * Formats a byte count into a human-readable string with two decimal places in gibibytes.
 *
 * @param {number} bytes Number of bytes.
 * @returns {string} Formatted GiB string.
 */
function gib(bytes) { return (bytes / GiB).toFixed(2); }
