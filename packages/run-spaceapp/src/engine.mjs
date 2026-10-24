/**
 * Container engine abstraction for SpaceApp launcher.
 *
 * The launcher historically assumed Docker. This module keeps the
 * abstraction thin and explicit: supported engines are enumerated,
 * engine-aware commands are constructed, and runtime probes are
 * factored so callers (doctor, prerequisites, install) can stay
 * engine-agnostic.
 */

export const SUPPORTED_ENGINES = Object.freeze(["docker", "podman"]);

export function isSupportedEngine(value) {
  return SUPPORTED_ENGINES.includes(value);
}

export function normalizeEngine(value) {
  const engine = value?.toString().trim().toLowerCase();
  if (!isSupportedEngine(engine)) {
    throw new Error(`Unsupported SpaceApp container engine "${value}". Choose docker or podman.`);
  }
  return engine;
}

export function composeBinary(engine) {
  return normalizeEngine(engine);
}

export function engineProbeSpecs(engine) {
  const binary = composeBinary(engine);
  return [
    { name: `${binary} CLI`, command: binary, args: ["--version"] },
    { name: `${binary} Compose`, command: binary, args: ["compose", "version"] },
    { name: `${binary} Engine`, command: binary, args: ["info"] }
  ];
}

export function engineVersionFlags(engine) {
  const binary = composeBinary(engine);
  return {
    command: binary,
    args: ["--version"]
  };
}

export function engineComposeVersionFlags(engine) {
  const binary = composeBinary(engine);
  return {
    command: binary,
    args: ["compose", "version"]
  };
}

export function engineInfoFlags(engine) {
  const binary = composeBinary(engine);
  return {
    command: binary,
    args: ["info"]
  };
}

const VERSION_LINE = /^(?:Docker|podman) version\s+(\d+\.\d+\.\d+).*$/im;

export function parseEngineVersion(output = "") {
  const match = output.match(VERSION_LINE);
  return match ? match[1] : null;
}

const MIN_PODMAN_VERSION = "4.9.0";

function compareVersions(a, b) {
  const parse = (v) => v.split(".").map(Number);
  const aa = parse(a);
  const bb = parse(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    const diff = (aa[i] || 0) - (bb[i] || 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

export function isPodmanVersionSupported(version) {
  return typeof version === "string" && compareVersions(version, MIN_PODMAN_VERSION) >= 0;
}

export function minimumPodmanVersion() {
  return MIN_PODMAN_VERSION;
}

/**
 * Validate the installed Podman version is at least the documented minimum.
 * Returns false when the CLI is unavailable or the version cannot be parsed.
 */
export async function validatePodmanVersion(execute) {
  const spec = engineVersionFlags("podman");
  let output = "";
  const { Writable } = await import("node:stream");
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    }
  });
  const code = await execute(spec, { stdout, stderr: null });
  if (code !== 0) return false;
  return isPodmanVersionSupported(parseEngineVersion(output));
}

/**
 * Detect the first engine that is available on PATH and responsive.
 * Docker is preferred when both are present to preserve existing behaviour.
 */
export async function detectAvailableEngine(execute, options = {}) {
  for (const engine of SUPPORTED_ENGINES) {
    const specs = engineProbeSpecs(engine);
    const available = (
      await execute(specs[0], { stdout: null, stderr: null }) === 0 &&
      await execute(specs[1], { stdout: null, stderr: null }) === 0 &&
      await execute(specs[2], { stdout: null, stderr: null }) === 0
    );
    if (available) return engine;
  }
  return null;
}

export function defaultEngine() {
  return "docker";
}

/**
 * Inspect a Podman machine (macOS/Windows VM). Returns null when the CLI or
 * machine is unavailable. An empty name inspects the default machine.
 */
export async function inspectPodmanMachine(execute, name = "") {
  const args = ["machine", "inspect", "--format", "{{json .}}"];
  if (name) args.push(name);
  const output = await captureProbe(execute, { command: "podman", args });
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

/**
 * List Podman machines. Returns an empty array when the CLI is unavailable.
 */
export async function listPodmanMachines(execute) {
  const output = await captureProbe(execute, { command: "podman", args: ["machine", "list", "--format", "json"] });
  if (!output) return [];
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Extract CPU, memory and disk limits from a Podman machine inspect object.
 * Returns null for missing or unexpected structures.
 */
export function podmanMachineResourceInfo(machine) {
  if (!machine || typeof machine !== "object") return null;
  const resources = machine.Resources && typeof machine.Resources === "object" ? machine.Resources : {};
  const cpus = Number(resources.CPUs ?? machine.CPUs ?? machine.cpus);
  const memoryBytes = parseByteSize(resources.Memory ?? machine.Memory ?? machine.memory);
  const diskSize = resources.DiskSize ?? machine.DiskSize ?? machine.diskSize ?? machine.ImageVolumeSize ?? machine.imageVolumeSize;
  const diskBytes = parseByteSize(diskSize);
  if (!Number.isFinite(cpus) || cpus <= 0) return null;
  return {
    cpuCount: cpus,
    memoryBytes: Number.isFinite(memoryBytes) && memoryBytes > 0 ? memoryBytes : 0,
    diskBytes: Number.isFinite(diskBytes) && diskBytes > 0 ? diskBytes : 0
  };
}

function parseByteSize(value) {
  // Podman machine inspect returns memory/disk sizes as plain numbers in MiB.
  if (typeof value === "number") return Math.floor(value * 1024 ** 2);
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  const match = /^([\d.]+)\s*([kmgtp]?i?b?)?$/.exec(trimmed);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const unit = match[2] || "b";
  const multipliers = {
    b: 1,
    k: 1024, kb: 1000, kib: 1024,
    m: 1024 ** 2, mb: 1000 ** 2, mib: 1024 ** 2,
    g: 1024 ** 3, gb: 1000 ** 3, gib: 1024 ** 3,
    t: 1024 ** 4, tb: 1000 ** 4, tib: 1024 ** 4
  };
  return Math.floor(number * (multipliers[unit] ?? 1));
}

async function captureProbe(execute, spec) {
  let output = "";
  const { Writable } = await import("node:stream");
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      if (output.length < 1024 * 1024) output += chunk.toString();
      done();
    }
  });
  try {
    const code = await execute(spec, { stdout, stderr: null });
    return code === 0 ? output.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Human-readable resize guidance for a Podman machine.
 */
export function podmanMachineResizeGuidance(name) {
  const target = name ? ` ${name}` : "";
  return [
    `Resize the Podman machine with: podman machine set${target} --cpus 4 --memory 8192 --disk 65536`,
    "Stop the machine first if the command reports it is running: podman machine stop" + target,
    "Units are MiB for --memory and --disk. Start the machine afterwards: podman machine start" + target
  ].join("\n");
}
