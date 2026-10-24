import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Container engine support (#63): the launcher runs the same Compose stack on Docker (the default) or on
 * rootless Podman. This module holds the engine facts the launcher needs — selection, version rules, the
 * `podman info` / `podman machine inspect` shapes, cgroup v2 delegation, and install guidance — as pure,
 * testable helpers. Dispatch stays static in cli.mjs (spawnTrustedCommand), exactly like Docker.
 */
export const CONTAINER_ENGINES = Object.freeze(["docker", "podman"]);
export const DEFAULT_ENGINE = "docker";

/**
 * Supported Podman floor and Compose provider. The launcher drives `podman compose`, which delegates to an
 * external provider; the supported provider is Docker Compose v2 (the standalone `docker-compose` binary or
 * the Docker CLI plugin), because the template relies on Compose v2 semantics (profiles, file-based secrets,
 * `depends_on` conditions with `required: false`, `--wait`). podman-compose (the Python tool) is not a
 * supported provider: it lacks several of those semantics.
 */
export const PODMAN_MIN_VERSION = "5.0.0";
export const PODMAN_COMPOSE_PROVIDER = "Docker Compose v2, reached through `podman compose`";

/** The engine a configuration runs on; configurations written before engine selection have no field. */
export function engineOf(config) {
  return config?.engine === "podman" ? "podman" : DEFAULT_ENGINE;
}

/** A requested engine wins over the stored one; an unknown value is a hard error, never a silent fallback. */
export function resolveInstallEngine(requested, existing = DEFAULT_ENGINE) {
  if (requested === undefined || requested === null) {
    return existing;
  }
  if (!CONTAINER_ENGINES.includes(requested)) {
    throw new Error(`Container engine must be docker or podman, not "${requested}".`);
  }
  return requested;
}

/** "podman version 5.2.2", "5.2.2", "version 5.2.2 (build ...)" -> "5.2.2"; anything else -> null. */
export function parseEngineVersion(output) {
  if (typeof output !== "string") {
    return null;
  }
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) {
    return null;
  }
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

export function versionAtLeast(version, minimum) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? ""));
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const actual = parse(version);
  const floor = parse(minimum);
  if (!actual || !floor) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== floor[index]) {
      return actual[index] > floor[index];
    }
  }
  return true;
}

/**
 * The facts doctor and the support bundle report, from `podman info --format {{json .}}` (Podman 5 shape).
 * Returns null when the payload is not a Podman info document.
 */
export function podmanInfoFacts(info) {
  if (!info || typeof info !== "object" || !info.host || typeof info.host !== "object") {
    return null;
  }
  const version = info.version?.Version ?? info.version?.version ?? null;
  return {
    version: typeof version === "string" ? parseEngineVersion(version) ?? version : null,
    rootless: typeof info.host.security?.rootless === "boolean" ? info.host.security.rootless : null,
    cgroupVersion: typeof info.host.cgroupVersion === "string" ? info.host.cgroupVersion : null,
    graphRoot: typeof info.store?.graphRoot === "string" ? info.store.graphRoot : null,
    cpuCount: Number.isFinite(info.host.cpus) ? info.host.cpus : null,
    memoryBytes: Number.isFinite(info.host.memTotal) ? info.host.memTotal : null,
    architecture: typeof info.host.arch === "string" ? info.host.arch : null
  };
}

/**
 * The sizing facts of a Podman machine, from `podman machine inspect` (a JSON array; Memory is MiB and
 * DiskSize is GiB in the machine definition). Returns null when there is no machine to inspect.
 */
export function podmanMachineFacts(inspect) {
  const machine = Array.isArray(inspect) ? inspect[0] : inspect;
  if (!machine || typeof machine !== "object") {
    return null;
  }
  const memoryMiB = Number(machine.Memory);
  const diskGiB = Number(machine.DiskSize);
  return {
    name: typeof machine.Name === "string" ? machine.Name : null,
    cpus: Number.isFinite(Number(machine.CPUs)) ? Number(machine.CPUs) : null,
    memoryBytes: Number.isFinite(memoryMiB) ? memoryMiB * 1024 ** 2 : null,
    diskBytes: Number.isFinite(diskGiB) ? diskGiB * 1024 ** 3 : null,
    running: machine.Running === true || machine.State === "running"
  };
}

/**
 * Whether a Podman machine can hold a profile, and how to fix it when it cannot. The memory/disk figures a
 * profile needs are its install requirements (PROFILE_REQUIREMENTS in index.mjs supplies them).
 */
export function podmanMachineCheck(facts, requirements) {
  if (!facts) {
    return {
      ok: false,
      details: ["No Podman machine exists. Create and start one: podman machine init && podman machine start"],
      guidance: "podman machine init && podman machine start"
    };
  }
  const details = [];
  const { cpuCount, memoryBytes, freshDiskBytes } = requirements;
  const gib = (bytes) => Math.floor((bytes / 1024 ** 3) * 10) / 10;
  if (facts.cpus !== null && facts.cpus < cpuCount) {
    details.push(`CPUs: ${facts.cpus} allocated; ${cpuCount} required`);
  }
  if (facts.memoryBytes !== null && facts.memoryBytes < memoryBytes) {
    details.push(`Memory: ${gib(facts.memoryBytes)} GiB allocated; ${gib(memoryBytes)} GiB required`);
  }
  if (facts.diskBytes !== null && facts.diskBytes < freshDiskBytes) {
    details.push(`Disk: ${gib(facts.diskBytes)} GiB allocated; ${gib(freshDiskBytes)} GiB required`);
  }
  if (details.length === 0) {
    return {
      ok: true,
      details: [`${facts.cpus ?? "?"} CPUs, ${facts.memoryBytes ? gib(facts.memoryBytes) : "?"} GiB memory, ${facts.diskBytes ? gib(facts.diskBytes) : "?"} GiB disk`],
      guidance: null
    };
  }
  const memoryMiB = Math.ceil(memoryBytes / 1024 ** 2);
  const diskGiB = Math.ceil(freshDiskBytes / 1024 ** 3);
  const guidance =
    "Resize the machine (it must be stopped; the disk can only grow): " +
    `podman machine stop && podman machine set --cpus ${cpuCount} --memory ${memoryMiB} --disk-size ${diskGiB} && podman machine start`;
  return { ok: false, details, guidance };
}

/**
 * cgroup v2 controller delegation for the current user's cgroup — the fact that decides whether rootless
 * Podman can enforce the template's mem_limit/cpus. On cgroup v2 the controllers a cgroup may enable for its
 * children are listed in its own cgroup.controllers file; systemd delegates cpu/memory only when the user
 * slice is configured for it. Reads are injectable for tests.
 */
export async function probeCgroupDelegation({
  platform = process.platform,
  read = (path) => readFile(path, "utf8"),
  selfCgroupPath = "/proc/self/cgroup",
  cgroupRoot = "/sys/fs/cgroup"
} = {}) {
  if (platform !== "linux") {
    return { version: null, delegated: [], cpuMemoryDelegated: null };
  }
  try {
    const entries = String(await read(selfCgroupPath)).split(/\r?\n/).filter(Boolean);
    const unified = entries.find((line) => line.startsWith("0::"));
    if (!unified) {
      return { version: 1, delegated: [], cpuMemoryDelegated: null };
    }
    const ownPath = unified.slice("0::".length) || "/";
    const controllers = String(await read(join(cgroupRoot, ownPath, "cgroup.controllers"))).trim();
    const delegated = controllers ? controllers.split(/\s+/) : [];
    return {
      version: 2,
      delegated,
      cpuMemoryDelegated: delegated.includes("cpu") && delegated.includes("memory")
    };
  } catch {
    return { version: null, delegated: [], cpuMemoryDelegated: null };
  }
}

/** The refusal text for an in-place engine switch: volumes are engine-private, so the data would vanish. */
export function engineSwitchRefusal(existingEngine, requestedEngine) {
  const other = requestedEngine === "podman" ? "podman" : existingEngine;
  return (
    `Switching container engines on an existing installation is refused: ${existingEngine} volumes are not ` +
    `visible to ${other}, so the existing SpaceApp data would be stranded. To migrate engines instead: ` +
    `1) run "spaceapp backup" on the current (${existingEngine}) engine, 2) run "spaceapp uninstall --purge-data", ` +
    `3) run "spaceapp install --engine ${requestedEngine}", 4) run "spaceapp restore". ` +
    "The backup/restore path is the supported migration and keeps your data."
  );
}

/** Podman is never installed by the launcher (out of scope); these are the instructions it prints instead. */
export function podmanInstallInstructions(platform) {
  if (platform === "darwin") {
    return [
      "Install Podman and create its machine (the launcher does not install Podman itself):",
      "  brew install podman",
      "  podman machine init && podman machine start",
      `Then install the Compose provider (${PODMAN_COMPOSE_PROVIDER}): brew install docker-compose`,
      "and make Compose visible to Podman as described in the run-spaceapp README."
    ].join("\n");
  }
  if (platform === "win32") {
    return "The Podman engine is not supported on Windows. Use the Docker engine (Docker Desktop).";
  }
  return [
    "Install Podman with your distribution (the launcher does not install Podman itself):",
    "  Fedora/RHEL:   sudo dnf install podman",
    "  Debian/Ubuntu: sudo apt-get install podman",
    "  openSUSE:      sudo zypper install podman",
    `SpaceApp needs Podman >= ${PODMAN_MIN_VERSION} on cgroup v2, plus its Compose provider (${PODMAN_COMPOSE_PROVIDER}):`,
    "  install Docker Compose v2 (the standalone docker-compose binary, or the Docker CLI with its compose plugin)",
    "  so that `podman compose version` succeeds. podman-compose is not a supported provider.",
    "Rootless Podman also needs the user socket for the Compose provider: systemctl --user enable --now podman.socket"
  ].join("\n");
}
