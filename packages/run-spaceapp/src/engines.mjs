// Container-engine facts shared by the launcher: engine selection, version
// parsing, `info` output normalization, cgroup delegation and Podman machine
// sizing. Everything here is pure or takes its inputs explicitly so the unit
// tests can cover both engines without a live daemon.

export const CONTAINER_ENGINES = Object.freeze(["docker", "podman"]);
export const DEFAULT_ENGINE = "docker";
// Podman support targets rootless Podman with the Docker Compose v2 binary as
// the compose provider (`podman compose` delegates to it). 4.9.3 is the floor
// because it is what Ubuntu 24.04 ships and what CI proves; 5.x is the
// recommended line (better rootless networking and Compose translation).
export const PODMAN_MIN_VERSION = Object.freeze([4, 9, 0]);
export const PODMAN_RECOMMENDED_VERSION = Object.freeze([5, 0, 0]);
export const PODMAN_COMPOSE_PROVIDER = "Docker Compose v2 (docker-compose) as the `podman compose` provider";

export function resolveInstallEngine(requestedEngine, existingEngine = DEFAULT_ENGINE) {
  if (requestedEngine === undefined) {
    return existingEngine;
  }
  if (CONTAINER_ENGINES.includes(requestedEngine)) {
    return requestedEngine;
  }
  throw new Error("Install engine must be docker or podman.");
}

export function engineLabel(engine) {
  return engine === "podman" ? "Podman" : "Docker";
}

export function versionTupleOf(version) {
  if (typeof version !== "string") {
    return null;
  }
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersionTuples(a, b) {
  if (!a || !b) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

// Parses `docker --version` ("Docker version 27.3.1, build 7d4bcd8") and
// `podman --version` ("podman version 5.2.2") output.
export function parseEngineVersion(engine, output) {
  if (typeof output !== "string") {
    return null;
  }
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) {
    return null;
  }
  return {
    version: `${match[1]}.${match[2]}.${match[3]}`,
    tuple: [Number(match[1]), Number(match[2]), Number(match[3])]
  };
}

export function podmanVersionAssessment(tuple) {
  if (!tuple) {
    return { ok: false, detail: "could not be determined" };
  }
  if (compareVersionTuples(tuple, PODMAN_MIN_VERSION) < 0) {
    return {
      ok: false,
      detail: `Podman ${tuple.join(".")} is older than the supported minimum ${PODMAN_MIN_VERSION.join(".")}`
    };
  }
  if (compareVersionTuples(tuple, PODMAN_RECOMMENDED_VERSION) < 0) {
    return {
      ok: true,
      detail: `Podman ${tuple.join(".")} (supported; ${PODMAN_RECOMMENDED_VERSION.join(".")}+ recommended)`
    };
  }
  return { ok: true, detail: `Podman ${tuple.join(".")}` };
}

// Normalizes `docker info --format {{json .}}` and
// `podman info --format {{json .}}` into one shape. Unknown fields stay null
// instead of being guessed.
export function normalizeEngineInfo(engine, info) {
  if (!info || typeof info !== "object") {
    return null;
  }
  if (engine === "podman") {
    const host = info.host ?? {};
    const security = host.security ?? {};
    return {
      engine,
      version: info.version?.Version ?? info.version?.version ?? null,
      architecture: host.arch ?? null,
      cpuCount: Number.isFinite(host.cpus) ? host.cpus : null,
      memoryBytes: Number.isFinite(host.memTotal) ? host.memTotal : null,
      rootDir: info.store?.graphRoot ?? null,
      rootless: typeof security.rootless === "boolean" ? security.rootless : null,
      cgroupVersion: typeof host.cgroupVersion === "string"
        ? host.cgroupVersion.replace(/^v/i, "")
        : null,
      cgroupManager: host.cgroupManager ?? null
    };
  }
  const securityOptions = Array.isArray(info.SecurityOptions) ? info.SecurityOptions : [];
  return {
    engine,
    version: info.Version ?? null,
    architecture: info.Architecture ?? null,
    cpuCount: Number.isFinite(info.NCPU) ? info.NCPU : null,
    memoryBytes: Number.isFinite(info.MemTotal) ? info.MemTotal : null,
    rootDir: info.DockerRootDir ?? null,
    rootless: securityOptions.some((option) => /rootless/i.test(String(option))) || null,
    cgroupVersion: info.CgroupVersion != null ? String(info.CgroupVersion) : null,
    cgroupManager: info.CgroupDriver ?? null
  };
}

export function parseCgroupControllers(text) {
  if (typeof text !== "string") {
    return null;
  }
  return new Set(text.split(/\s+/).filter(Boolean));
}

// cgroup v2 only enforces cpu/memory limits for a rootless user when the
// controllers are delegated into the user's slice. `known` is false when the
// slice file could not be read; callers must not treat unknown as delegated.
export function assessCgroupDelegation({ rootControllers, userControllers }) {
  // An empty controllers file (seen in sandboxes and partial mounts) carries
  // no information; only a non-empty listing is authoritative.
  const rootSet = rootControllers && rootControllers.size > 0 ? rootControllers : null;
  const userSet = userControllers && userControllers.size > 0 ? userControllers : null;
  const missing = [];
  let known = false;
  if (userSet) {
    known = true;
    if (!userSet.has("cpu")) missing.push("cpu");
    if (!userSet.has("memory")) missing.push("memory");
  } else if (rootSet) {
    // If the root hierarchy itself lacks a controller it cannot be delegated.
    if (!rootSet.has("cpu")) missing.push("cpu");
    if (!rootSet.has("memory")) missing.push("memory");
    known = missing.length > 0;
  }
  return {
    known,
    cpuDelegated: userSet ? userSet.has("cpu") : (known ? false : null),
    memoryDelegated: userSet ? userSet.has("memory") : (known ? false : null),
    missing
  };
}

export function parseHumanBytes(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB|B)?$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "B").toLowerCase();
  const factors = {
    b: 1,
    kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4
  };
  return Math.round(amount * factors[unit]);
}

// Parses `podman machine list --format {{json .}}` output.
export function parsePodmanMachines(output) {
  if (typeof output !== "string" || !output.trim()) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.filter((entry) => entry && typeof entry === "object").map((entry) => ({
    name: entry.Name ?? entry.name ?? null,
    cpus: Number.isFinite(entry.CPUs) ? entry.CPUs : (Number.isFinite(entry.cpus) ? entry.cpus : null),
    memoryBytes: parseHumanBytes(entry.Memory ?? entry.memory),
    diskBytes: parseHumanBytes(entry.DiskSize ?? entry.diskSize),
    running: entry.Running === true || entry.running === true,
    isDefault: entry.Default === true || entry.default === true
  }));
}

export function selectPodmanMachine(machines) {
  if (!Array.isArray(machines) || machines.length === 0) {
    return null;
  }
  return machines.find((machine) => machine.running) ??
    machines.find((machine) => machine.isDefault) ??
    machines[0];
}

export function podmanMachineChecks(machine, requirements) {
  if (!machine) {
    return [{
      name: "Podman machine",
      ok: false,
      detail: "no Podman machine exists; run `podman machine init` and `podman machine start`"
    }];
  }
  if (!machine.running) {
    return [{
      name: "Podman machine",
      ok: false,
      detail: `machine "${machine.name}" is not running; run \`podman machine start\``
    }];
  }
  const gib = (bytes) => Math.floor((bytes / 1024 ** 3) * 10) / 10;
  return [
    {
      name: "Podman machine CPU",
      ok: machine.cpus !== null && machine.cpus >= requirements.cpuCount,
      detail: `${machine.cpus ?? "unknown"} allocated; ${requirements.cpuCount} required`
    },
    {
      name: "Podman machine memory",
      ok: machine.memoryBytes !== null && machine.memoryBytes >= requirements.memoryBytes,
      detail: `${machine.memoryBytes ? gib(machine.memoryBytes) : "unknown"} GiB allocated; ${gib(requirements.memoryBytes)} GiB required`
    },
    {
      name: "Podman machine disk",
      ok: machine.diskBytes !== null && machine.diskBytes >= requirements.freshDiskBytes,
      detail: `${machine.diskBytes ? gib(machine.diskBytes) : "unknown"} GiB allocated; ${gib(requirements.freshDiskBytes)} GiB required`
    }
  ];
}

export function podmanMachineResizeGuidance(machine, requirements) {
  const memoryMiB = Math.ceil(requirements.memoryBytes / 1024 ** 2);
  const diskGiB = Math.ceil(requirements.freshDiskBytes / 1024 ** 3);
  const name = machine?.name ?? "podman-machine-default";
  return [
    `Resize the Podman machine to at least ${requirements.cpuCount} CPUs, ${memoryMiB} MiB memory and ${diskGiB} GiB disk, then retry:`,
    "  podman machine stop",
    `  podman machine set --cpus ${requirements.cpuCount} --memory ${memoryMiB} --disk-size ${diskGiB} ${name}`,
    "  podman machine start"
  ];
}

export function podmanInstallInstructions(platform, distroId = "") {
  const composeNote =
    `SpaceApp runs Compose through ${PODMAN_COMPOSE_PROVIDER}: after installing Podman, make sure \`podman compose version\` succeeds (install Docker Compose v2 as the provider if it does not). podman-compose is not supported: it cannot express every feature of the SpaceApp template (profiles, health-gated depends_on with required: false, file secrets).`;
  if (platform === "darwin") {
    return [
      "Podman is not installed and SpaceApp does not install it automatically. Install it with Homebrew:",
      "  brew install podman",
      "  podman machine init",
      "  podman machine start",
      composeNote
    ];
  }
  if (platform === "win32") {
    return [
      "Podman is not supported on native Windows by this launcher. Use Docker Desktop, or run SpaceApp inside a Linux distribution under WSL2 and select Podman there."
    ];
  }
  const id = String(distroId || "").toLowerCase();
  let installLine = "  Install Podman with your distribution's package manager (package name: podman).";
  if (id === "fedora") installLine = "  sudo dnf install -y podman";
  else if (id === "rhel" || id === "centos") installLine = "  sudo dnf install -y podman";
  else if (id === "ubuntu" || id === "debian") installLine = "  sudo apt-get update && sudo apt-get install -y podman";
  else if (id === "opensuse" || id === "opensuse-leap" || id === "opensuse-tumbleweed" || id === "sles") installLine = "  sudo zypper install -y podman";
  else if (id === "arch" || id === "archlinux") installLine = "  sudo pacman -S --needed podman";
  return [
    "Podman is not installed and SpaceApp does not install it automatically. Install it yourself:",
    installLine,
    "For rootless use, also start the user socket so containers keep running after logout:",
    "  systemctl --user enable --now podman.socket",
    composeNote
  ];
}

// The data-safety refusal used when an install names a different engine than
// the one that created the existing installation. Docker and Podman keep
// separate image/volume stores, so an in-place switch would strand the data.
export function engineSwitchRefusal(existingEngine, requestedEngine) {
  return (
    `This installation was created with ${engineLabel(existingEngine)}, but --engine ${requestedEngine} was requested. ` +
    `${engineLabel(existingEngine)} volumes are not visible to ${engineLabel(requestedEngine)}, so switching engines in place would strand your data. ` +
    "To migrate instead: run `spaceapp backup` with the current engine, run `spaceapp uninstall --purge-data`, " +
    `reinstall with --engine ${requestedEngine}, then run \`spaceapp restore\`.`
  );
}

export function hostRootPodmanRefusal() {
  return (
    "--access host-root is refused with the Podman engine: host-root mounts the whole host filesystem into the agent containers, " +
    "which defeats the isolation that rootless Podman is chosen for, and rootless user-namespace mapping cannot grant the host-root access it promises. " +
    "Use --access isolated and register the directories SpaceApp may work in with `spaceapp workspace add <path>`."
  );
}
