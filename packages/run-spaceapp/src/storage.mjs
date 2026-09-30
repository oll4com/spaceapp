import { Writable } from "node:stream";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { composeCommand, profileRuntimeSettings, PROFILE_REQUIREMENTS } from "./index.mjs";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
// Upper bounds include extraction/transfer headroom, not the size of existing data.
const imageReserve = { core: 1.4 * GiB, cli: 3.8 * GiB, browser: 2.2 * GiB, postgres: 700 * MiB, temporal: 800 * MiB };

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

export async function inspectStoragePlan({ root, config, existingConfig, resources, execute, operation, fetch = globalThis.fetch }) {
  const dockerInfo = await captureProbe(execute, { command: "docker", args: ["info", "--format", "{{json .}}"] });
  let engine = null;
  try { engine = JSON.parse(dockerInfo); } catch { /* Conservative reserve when the engine is unavailable. */ }
  const cachedLayers = new Set();
  if (engine && existingConfig) {
    for (const type of ["core", "cli", "browser"]) {
      const output = await captureProbe(execute, { command: "docker", args: ["image", "inspect", "--format", "{{json .RootFS.Layers}}", `ghcr.io/oll4com/spaceapp-${type}:${existingConfig.version}`] });
      try { for (const layer of JSON.parse(output)) cachedLayers.add(layer); } catch {}
    }
  }
  const settings = profileRuntimeSettings(config.profile);
  const images = [
    ["core", `ghcr.io/oll4com/spaceapp-core:${config.version}`],
    ["cli", `ghcr.io/oll4com/spaceapp-cli:${config.version}`],
    ["postgres", "pgvector/pgvector:0.8.3-pg17-trixie"],
    ...(settings.browserEnabled ? [["browser", `ghcr.io/oll4com/spaceapp-browser:${config.version}`]] : []),
    ...(settings.temporalEnabled ? [["temporal", "temporalio/auto-setup:1.29.1"]] : []),
    ...(config.companionsEnabled ? [["companion", "ghcr.io/soju06/codex-lb:1.22.0"], ["companion", "ghcr.io/oll4com/headroom-codex-lb:code"]] : [])
  ];
  let missingImageBytes = 0;
  const missingImages = [];
  let sharedLayersEstimated = false;
  for (const [type, image] of images) {
    const cached = await captureProbe(execute, { command: "docker", args: ["image", "inspect", "--format", "{{.Id}}", image] });
    if (!/^sha256:[a-f0-9]{64}$/.test(cached ?? "")) {
      missingImages.push(image);
      let reserve = imageReserve[type] ?? GiB;
      if (engine && existingConfig && cachedLayers.size && typeof fetch === "function") {
        try {
          const metadata = await registryLayers(image, /arm|aarch64/.test(engine.Architecture ?? "") ? "arm64" : "amd64", fetch);
          if (metadata) { reserve = estimateMissingLayers(metadata.layers, metadata.diffIds, cachedLayers); sharedLayersEstimated = true; }
        } catch { /* Offline/private registry: retain the full conservative reserve. */ }
      }
      missingImageBytes += reserve;
    }
  }
  let databaseBytes = 0, databaseSizeKnown = true;
  if (operation === "upgrade") {
    const size = await captureProbe(execute, composeCommand("databaseSize", root, existingConfig ?? config));
    databaseSizeKnown = /^\d+$/.test(size ?? "");
    if (databaseSizeKnown) databaseBytes = Number(size);
  }
  const plan = calculateStoragePlan({ operation, profile: config.profile, missingImageBytes, databaseBytes,
    configBytes: await configurationBytes(root), databaseSizeKnown });
  let dockerFreeDiskBytes = null;
  if (existingConfig) {
    const free = await captureProbe(execute, composeCommand("storageFree", root, existingConfig));
    if (/^\d+$/.test(free ?? "")) dockerFreeDiskBytes = Number(free);
  }
  // Linux can measure the Docker filesystem directly even on a fresh install.
  if (engine?.DockerRootDir && process.platform === "linux") {
    const { inspectSystemResources } = await import("./index.mjs");
    try { dockerFreeDiskBytes = (await inspectSystemResources(engine.DockerRootDir)).freeDiskBytes; } catch {}
  }
  return { ...plan, missingImages, sharedLayersEstimated, dockerFreeDiskBytes,
    resources: { ...resources,
      freeDiskBytes: dockerFreeDiskBytes === null ? resources.freeDiskBytes : Math.min(resources.freeDiskBytes, dockerFreeDiskBytes),
      engineCpuCount: engine?.NCPU,
      engineMemoryBytes: engine?.MemTotal
    } };
}

export function storageChecks(plan, resources) {
  const checks = [{ name: "Free disk", ok: resources.freeDiskBytes >= plan.requiredDiskBytes,
    detail: `${gib(resources.freeDiskBytes)} GiB available; ${gib(plan.requiredDiskBytes)} GiB required additionally for ${plan.operation} (images ${gib(plan.missingImageBytes)}, checkpoint ${gib(plan.checkpointBytes)}, reserve 0.5)` }];
  if (plan.dockerFreeDiskBytes !== null) checks.push({ name: "Docker storage", ok: plan.dockerFreeDiskBytes >= plan.requiredDiskBytes,
    detail: `${gib(plan.dockerFreeDiskBytes)} GiB available; ${gib(plan.requiredDiskBytes)} GiB required additionally` });
  else checks.push({ name: "Docker storage", ok: true, detail: "Separate engine disk capacity unavailable; host estimate used. Docker ENOSPC will stop the operation before cutover." });
  return checks;
}

function gib(bytes) { return (bytes / GiB).toFixed(2); }
