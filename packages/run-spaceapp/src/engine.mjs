import { readFile, stat } from "node:fs/promises";
import { captureProbe } from "./storage.mjs";
import { PROFILE_REQUIREMENTS } from "./index.mjs";

export function containerEngine(config) {
  return config?.engine ?? "docker";
}

export function selectedEngine({ flag, answer, saved, available }) {
  for (const choice of [flag, answer, saved]) {
    if (choice !== undefined && !["docker", "podman"].includes(choice)) throw new Error("Engine must be docker or podman.");
  }
  return flag ?? answer ?? saved ?? (available ? available.docker || !available.podman ? "docker" : "podman" : undefined);
}

export async function detectEngines(execute) {
  const available = async (command, args) => {
    try { return await execute({ command, args }, { stdin: null, stdout: null, stderr: null }) === 0; }
    catch { return false; }
  };
  return {
    docker: await available("docker", ["info"]),
    podman: await available("podman", ["info", "--format", "json"])
  };
}

export function podmanInstallHelp(platform, osRelease = "") {
  if (platform === "darwin") return "Install Podman 5+ and docker-compose 2.20+ (brew install podman docker-compose), then run podman machine init and podman machine start.";
  if (platform !== "linux") return "Rootless Podman is supported on Linux and macOS only.";
  if (/^ID="?(?:fedora|rhel|centos)"?$/m.test(osRelease)) return "Install Podman 5+ and docker-compose 2.20+ with dnf install podman docker-compose-plugin.";
  if (/^ID="?(?:opensuse|sles)"?$/m.test(osRelease)) return "Install Podman 5+ and docker-compose 2.20+ with zypper install podman docker-compose.";
  if (/^ID="?(?:ubuntu|debian)"?$/m.test(osRelease)) return "Install Podman 5+ and docker-compose 2.20+ with apt install podman docker-compose-v2 (or the Docker Compose v2 plugin).";
  return "Install Podman 5+ and docker-compose 2.20+ using your distribution's package manager.";
}

export function delegatedControllers(controllers) {
  const set = new Set(String(controllers).trim().split(/\s+/));
  return { cpu: set.has("cpu"), memory: set.has("memory") };
}

export function composeProviderSupported(output) {
  const match = /Docker Compose version v?(\d+)\.(\d+)(?:\.(\d+))?/i.exec(output ?? "");
  return Boolean(match && Number(match[1]) === 2 && Number(match[2]) >= 20);
}

export async function podmanFacts({ execute, platform = process.platform, uid = process.getuid?.(), read = readFile }) {
  const raw = await captureProbe(execute, { command: "podman", args: ["info", "--format", "json"] });
  let info;
  try { info = JSON.parse(raw); } catch {
    const release = platform === "linux" ? await read("/etc/os-release", "utf8").catch(() => "") : "";
    throw new Error(`${podmanInstallHelp(platform, release)} Podman info is unavailable.`);
  }
  const rootless = info.host?.security?.rootless === true;
  const version = info.version?.Version ?? info.version?.version ?? "unknown";
  const cgroupVersion = String(info.host?.cgroupVersion ?? "unknown");
  const socket = info.host?.remoteSocket?.path ?? null;
  let delegated = { cpu: null, memory: null };
  if (platform === "linux" && Number.isInteger(uid)) {
    const path = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`;
    const controllers = await read(path, "utf8").catch(() => "");
    delegated = delegatedControllers(controllers);
  }
  return { version, rootless, cgroupVersion, socket, delegated };
}

export function podmanMachineResize(machine, profile) {
  const needs = PROFILE_REQUIREMENTS[profile];
  const actual = Array.isArray(machine) ? machine[0] : machine;
  if (!needs || !actual) throw new Error("Unable to inspect the Podman machine.");
  const cpu = Math.max(needs.cpuCount, Number(actual.CPUs ?? actual.cpus));
  const memory = Math.max(Math.ceil(needs.memoryBytes / 1024 ** 2), Number(actual.Memory ?? actual.memory));
  const disk = Math.max(Math.ceil(needs.freshDiskBytes / 1024 ** 3), Number(actual.DiskSize ?? actual.diskSize));
  if ([cpu, memory, disk].some((value) => !Number.isFinite(value))) throw new Error("Podman machine inspect omitted CPU, memory, or disk size.");
  return cpu > Number(actual.CPUs ?? actual.cpus) || memory > Number(actual.Memory ?? actual.memory) || disk > Number(actual.DiskSize ?? actual.diskSize)
    ? `podman machine stop && podman machine set --cpus ${cpu} --memory ${memory} --disk-size ${disk} && podman machine start`
    : null;
}

export async function checkPodman({ execute, platform, profile, read = readFile, uid = process.getuid?.(), inspectSocket = stat }) {
  if (!["linux", "darwin"].includes(platform)) throw new Error("Podman is supported only on Linux and macOS.");
  const facts = await podmanFacts({ execute, platform, uid, read });
  if (!/^([5-9]|[1-9]\d+)\./.test(facts.version)) throw new Error(`Podman 5 or newer is required (found ${facts.version}).`);
  if (!facts.rootless) throw new Error("SpaceApp requires rootless Podman. Run podman as your regular user.");
  if (facts.cgroupVersion !== "v2") throw new Error(`Podman requires cgroup v2 for SpaceApp limits (found ${facts.cgroupVersion}).`);
  if (platform === "linux" && (!facts.delegated.cpu || !facts.delegated.memory)) {
    throw new Error(`Podman CPU and memory cgroup controllers must be delegated to the user service (cpu=${facts.delegated.cpu}, memory=${facts.delegated.memory}). Check user@$(id -u).service delegation.`);
  }
  if (!facts.socket) throw new Error("Rootless Podman API socket is missing. Run: systemctl --user enable --now podman.socket");
  if (platform === "linux") {
    const socketPath = facts.socket.replace(/^unix:\/\//, "");
    const socket = await inspectSocket(socketPath).catch(() => null);
    if (!socket?.isSocket?.()) throw new Error("Rootless Podman API socket is not listening. Run: systemctl --user enable --now podman.socket");
  }
  const provider = await captureProbe(execute, { command: "podman", args: ["compose", "version"], env: { PODMAN_COMPOSE_PROVIDER: "docker-compose" } });
  if (!composeProviderSupported(provider)) throw new Error("Podman compose needs docker-compose 2.20+ for depends_on.required. Install it and set PODMAN_COMPOSE_PROVIDER=docker-compose.");
  if (platform === "darwin") {
    const raw = await captureProbe(execute, { command: "podman", args: ["machine", "inspect", "--format", "json"] });
    let machine;
    try { machine = JSON.parse(raw); } catch { throw new Error("Run podman machine init && podman machine start before installing SpaceApp."); }
    const resize = podmanMachineResize(machine, profile);
    if (resize) throw new Error(`Podman machine is too small for ${profile}. Resize it with: ${resize}`);
  }
  return facts;
}
