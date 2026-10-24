import { PROFILE_REQUIREMENTS } from "./index.mjs";
import { captureProbe } from "./storage.mjs";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const PODMAN_VERSION_PATTERN = /^podman version \d+\.\d+\.\d+(?:$|[-+\s])/i;
export const PODMAN_COMPOSE_ENV = Object.freeze({ PODMAN_COMPOSE_PROVIDER: "docker-compose" });

function validateEngine(engine) {
  if (engine !== "docker" && engine !== "podman") throw new Error("Container engine must be docker or podman.");
}

async function probeWithExit(execute, spec) {
  let code = 1;
  const output = await captureProbe(async (command, io) => {
    try { code = await execute(command, io); }
    catch (error) { code = error.code === "ENOENT" ? 127 : 1; }
    return code;
  }, spec);
  return { code, output };
}

// An installed Docker CLI still owns the default even when its daemon is stopped.
// A missing CLI or podman-docker compatibility shim offers native Podman instead.
export async function detectContainerEngine({ execute, requestedEngine, platform = process.platform }) {
  if (requestedEngine !== undefined) {
    validateEngine(requestedEngine);
    if (requestedEngine === "podman" && platform === "win32") throw new Error("Podman is supported on Linux and macOS only.");
    return { engine: requestedEngine, detected: false, reason: "requested" };
  }
  const docker = await probeWithExit(execute, { command: "docker", args: ["--version"] });
  const podmanShim = docker.code === 0 && PODMAN_VERSION_PATTERN.test(docker.output ?? "");
  if (docker.code !== 127 && !podmanShim) return { engine: "docker", detected: docker.code === 0, reason: "docker-present" };
  if (platform !== "win32") {
    const podmanVersion = await captureProbe(execute, { command: "podman", args: ["--version"] });
    if (PODMAN_VERSION_PATTERN.test(podmanVersion ?? "")) {
      return { engine: "podman", detected: true, reason: "podman-available" };
    }
  }
  return { engine: "docker", detected: docker.code === 0, reason: docker.code === 127 ? "docker-default" : "docker-present" };
}

function jsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function version(value) {
  const match = typeof value === "string" && /(?:^|\s|v)(\d+\.\d+\.\d+)(?:$|[-+\s,])/.exec(value);
  return match ? match[1] : null;
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nullableBoolean(value) { return typeof value === "boolean" ? value : null; }
function status(value) { return value === null ? "unknown" : value ? "delegated" : "not delegated"; }
function cgroupVersion(value) { return value === "v2" || value === "2" ? "v2" : value === "v1" || value === "1" ? "v1" : null; }

export function podmanInstallHelp(platform = process.platform) {
  const common = "SpaceApp requires Podman >= 5 and the docker-compose v2 provider >= 2.20 on PATH; podman-compose is not supported. SpaceApp does not install Podman.";
  if (platform === "darwin") return `${common} Install Podman, create a rootless machine with podman machine init, then run podman machine start.`;
  if (platform === "win32") return "Podman is supported on Linux and macOS only. Use Docker on Windows.";
  return `${common} Install Podman from your distribution, use a rootless login with cgroup v2, and enable the user socket with systemctl --user enable --now podman.socket.`;
}

function machineResizeHelp(profile, name) {
  const requirements = PROFILE_REQUIREMENTS[profile];
  const memoryMiB = { small: 3072, medium: 5120, large: 7168, light: 3072, standard: 3072 }[profile];
  // Names are validated before they can reach output or a command argument.
  return `For a QEMU machine, run podman machine stop ${name}, then podman machine set --cpus ${requirements.cpuCount} --memory ${memoryMiB} --disk-size ${Math.max(20, Math.ceil(requirements.freshDiskBytes / GiB) + 5)} ${name}, then podman machine start ${name}. Other VM providers may require creating a larger machine; back up and restore data before replacing an existing machine.`;
}

async function inspectMachine(execute) {
  const info = jsonObject(await captureProbe(execute, { command: "podman", args: ["machine", "info", "--format", "json"] }));
  const name = info?.Host?.DefaultMachine || info?.Host?.CurrentMachine;
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) return null;
  let inspections;
  try { inspections = JSON.parse(await captureProbe(execute, { command: "podman", args: ["machine", "inspect", name] })); } catch { return null; }
  const machine = Array.isArray(inspections) ? inspections.find((entry) => entry.Name === name) : null;
  if (!machine) return null;
  return {
    name,
    running: machine.State === "running",
    rootless: machine.Rootful === false,
    cpuCount: positiveNumber(machine.Resources?.CPUs),
    memoryBytes: positiveNumber(machine.Resources?.Memory) === null ? null : machine.Resources.Memory * MiB,
    diskBytes: positiveNumber(machine.Resources?.DiskSize) === null ? null : machine.Resources.DiskSize * GiB
  };
}

// Return only an explicit allowlist of diagnostic facts: engine info contains
// host paths, registry credentials and connection details unsuitable for bundles.
export async function inspectEngine({ engine = "docker", execute, platform = process.platform, profile, requiredDiskBytes }) {
  validateEngine(engine);
  if (profile !== undefined && !PROFILE_REQUIREMENTS[profile]) throw new Error("Unknown installation profile.");
  if (requiredDiskBytes !== undefined && (!Number.isFinite(requiredDiskBytes) || requiredDiskBytes < 0)) throw new Error("Required disk space must be a non-negative number.");
  const podman = engine === "podman";
  const [versionText, infoText, composeText] = await Promise.all([
    captureProbe(execute, { command: podman ? "podman" : "docker", args: ["--version"] }),
    captureProbe(execute, { command: podman ? "podman" : "docker", args: ["info", "--format", podman ? "json" : "{{json .}}"] }),
    captureProbe(execute, { command: podman ? "podman" : "docker", args: ["compose", "version", "--short"], ...(podman ? { env: PODMAN_COMPOSE_ENV } : {}) })
  ]);
  const info = jsonObject(infoText);
  const host = info?.host;
  const controllers = Array.isArray(host?.cgroupControllers) ? host.cgroupControllers : null;
  const allocated = positiveNumber(info?.store?.graphRootAllocated);
  const used = typeof info?.store?.graphRootUsed === "number" && info.store.graphRootUsed >= 0 ? info.store.graphRootUsed : null;
  const facts = {
    engine,
    version: version(podman ? info?.version?.Version : info?.ServerVersion) ?? version(versionText),
    composeProvider: podman ? "docker-compose" : "docker compose",
    composeVersion: version(composeText),
    rootless: podman ? nullableBoolean(host?.security?.rootless) : Array.isArray(info?.SecurityOptions) ? info.SecurityOptions.some((option) => /^name=rootless(?:,|$)/.test(option)) : null,
    cgroupVersion: cgroupVersion(podman ? host?.cgroupVersion : info?.CgroupVersion),
    cpuLimitsDelegated: podman ? controllers === null ? null : controllers.includes("cpu") : nullableBoolean(info?.CpuCfsQuota),
    memoryLimitsDelegated: podman ? controllers === null ? null : controllers.includes("memory") : nullableBoolean(info?.MemoryLimit),
    cpuCount: positiveNumber(podman ? host?.cpus : info?.NCPU),
    memoryBytes: positiveNumber(podman ? host?.memTotal : info?.MemTotal),
    freeDiskBytes: allocated !== null && used !== null && allocated >= used ? allocated - used : null
  };
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  if (podman) {
    const [major] = (facts.version ?? "").split(".").map(Number);
    const [composeMajor, composeMinor] = (facts.composeVersion ?? "").split(".").map(Number);
    add("Podman version", major >= 5, `${facts.version ?? "unavailable"}; Podman >= 5 required`);
    add("Podman Compose", composeMajor === 2 && composeMinor >= 20, `docker-compose ${facts.composeVersion ?? "unavailable"}; docker-compose v2 >= 2.20 required on PATH`);
    const engineAvailable = host && typeof host === "object" && !Array.isArray(host) && Object.keys(host).length > 0 && platform !== "win32";
    add("Podman Engine", Boolean(engineAvailable), engineAvailable ? "available" : podmanInstallHelp(platform));
    const apiReady = await captureProbe(execute, { command: "podman", args: ["compose", "ls", "--format", "json"], env: PODMAN_COMPOSE_ENV }) !== null;
    add("Podman Compose API", apiReady, apiReady ? "API socket reachable" : platform === "darwin"
      ? "Podman API socket unavailable. Run podman machine start and select its rootless connection."
      : "Podman API socket unavailable. Run systemctl --user enable --now podman.socket before installing or starting SpaceApp.");
    add("Rootless containers", facts.rootless === true, facts.rootless === true ? "rootless" : facts.rootless === false ? "rootful; use Podman as your normal user and a rootless machine connection" : "unknown; rootless Podman is required");
    add("Cgroup version", facts.cgroupVersion === "v2", `${facts.cgroupVersion ?? "unknown"}; cgroup v2 required`);
    add("CPU limit delegation", facts.cpuLimitsDelegated === true, `${status(facts.cpuLimitsDelegated)}${facts.cpuLimitsDelegated ? "" : "; the cpu controller must be delegated to your user before SpaceApp can apply cpus limits"}`);
    add("Memory limit delegation", facts.memoryLimitsDelegated === true, `${status(facts.memoryLimitsDelegated)}${facts.memoryLimitsDelegated ? "" : "; the memory controller must be delegated to your user before SpaceApp can apply mem_limit"}`);
    if (facts.cpuLimitsDelegated !== true || facts.memoryLimitsDelegated !== true) {
      checks.at(-1).detail += ". Ask your administrator to enable Delegate=cpu cpuset memory pids for user@.service, then log out and back in.";
    }
    if (platform === "darwin") {
      const machine = await inspectMachine(execute);
      facts.machine = machine;
      add("Podman machine", machine?.running === true && machine?.rootless === true, machine ? `${machine.name}: ${machine.running ? "running" : "stopped"}, ${machine.rootless ? "rootless" : "rootful"}` : "No active machine found. Run podman machine init and podman machine start, then select its rootless connection.");
      if (profile && machine) {
        const requirements = PROFILE_REQUIREMENTS[profile];
        const memoryBytes = { small: 3, medium: 5, large: 7, light: 3, standard: 3 }[profile] * GiB;
        const minimumDiskBytes = requiredDiskBytes ?? requirements.freshDiskBytes;
        const availableDisk = facts.freeDiskBytes;
        const resize = machineResizeHelp(profile, machine.name);
        add("Podman machine CPU", machine.cpuCount !== null && machine.cpuCount >= requirements.cpuCount, `${machine.cpuCount ?? "unknown"} allocated; ${requirements.cpuCount} required for ${profile}. ${resize}`);
        add("Podman machine memory", machine.memoryBytes !== null && machine.memoryBytes >= memoryBytes, `${machine.memoryBytes === null ? "unknown" : (machine.memoryBytes / GiB).toFixed(1)} GiB allocated; ${memoryBytes / GiB} GiB required for ${profile}. ${resize}`);
        add("Podman machine disk", availableDisk !== null && availableDisk >= minimumDiskBytes, `${availableDisk === null ? "unknown" : (availableDisk / GiB).toFixed(1)} GiB free; ${(minimumDiskBytes / GiB).toFixed(1)} GiB required for ${profile}. ${resize}`);
      }
    }
  } else {
    add("Container engine", true, `Docker ${facts.version ?? "version unknown"}`);
    add("Container mode", true, facts.rootless === null ? "unknown" : facts.rootless ? "rootless" : "rootful");
    add("Cgroup version", true, facts.cgroupVersion ?? "unknown");
    add("CPU limit delegation", facts.cpuLimitsDelegated !== false, status(facts.cpuLimitsDelegated));
    add("Memory limit delegation", facts.memoryLimitsDelegated !== false, status(facts.memoryLimitsDelegated));
  }
  return { engine, facts, checks, errors: checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`) };
}
