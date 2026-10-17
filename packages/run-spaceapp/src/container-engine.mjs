import { Writable } from "node:stream";

export function containerEngine(value = "docker") {
  if (value !== "docker" && value !== "podman") {
    throw new Error("Container engine must be docker or podman.");
  }
  return value;
}

export function engineInstallArgs(args, answers = {}) {
  const remaining = [];
  let requested = answers.engine;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--engine") {
      if (!args[index + 1] || args[index + 1].startsWith("--")) {
        throw new Error("--engine requires docker or podman.");
      }
      requested = args[++index];
    } else if (argument.startsWith("--engine=")) {
      requested = argument.slice("--engine=".length);
    } else {
      remaining.push(argument);
    }
  }
  return { args: remaining, requested: requested === undefined ? undefined : containerEngine(requested) };
}

export function assertEngineUnchanged(stored, requested) {
  if (stored && requested && containerEngine(stored.engine) !== requested) {
    throw new Error("Switching container engines on an existing installation is refused: Docker and Podman do not share volumes. Keep the saved engine; use a separate installation root for a fresh installation. Existing data has not been migrated.");
  }
}

async function capture(execute, spec) {
  let output = "";
  const stdout = new Writable({ write(chunk, _encoding, done) {
    if (output.length < 1024 * 1024) output += chunk.toString();
    done();
  } });
  try {
    const code = await execute({ ...spec, timeoutMs: 15000 }, { stdout, stderr: null, stdin: null });
    return code === 0 ? output.trim() : null;
  } catch {
    return null;
  }
}

export async function inspectContainerEngine(execute, selected, { platform = process.platform } = {}) {
  const name = containerEngine(selected);
  const raw = await capture(execute, { command: name, args: ["info", "--format", "{{json .}}"] });
  let info;
  try { info = JSON.parse(raw); } catch { info = null; }
  if (!info || typeof info !== "object") {
    return { name, available: false, error: name === "podman"
      ? "Podman is unavailable. On macOS start a Podman machine; on Linux run Podman as your normal user."
      : "Docker Engine is unavailable." };
  }
  if (name === "docker") {
    return { name, available: true, version: info.ServerVersion ?? null,
      rootless: info.SecurityOptions?.some((item) => item.includes("rootless")) ?? false,
      cgroupVersion: info.CgroupVersion ?? null,
      cpuCount: info.NCPU ?? null, memoryBytes: info.MemTotal ?? null };
  }
  const controllers = info.host?.cgroupControllers ?? [];
  const facts = { name, available: true, version: info.version?.Version ?? null,
    rootless: info.host?.security?.rootless === true,
    cgroupVersion: info.host?.cgroupVersion ?? null,
    cpuLimits: controllers.includes("cpu"), memoryLimits: controllers.includes("memory"),
    cpuCount: info.host?.cpus ?? null, memoryBytes: info.host?.memTotal ?? null };
  const compose = await capture(execute, { command: "podman", args: ["compose", "version", "--short"] });
  facts.composeVersion = /(?:^|\s)v?(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/.exec(compose ?? "")?.[1] ?? null;
  if (platform === "darwin") {
    const listing = await capture(execute, { command: "podman", args: ["machine", "list", "--format", "json"] });
    let listed;
    try { listed = JSON.parse(listing); } catch { listed = []; }
    const active = Array.isArray(listed) ? listed.filter((item) => item.Running === true) : [];
    const selectedMachine = active.find((item) => item.Default === true) ?? (active.length === 1 ? active[0] : null);
    const machineName = selectedMachine?.Name;
    const machine = typeof machineName === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(machineName)
      ? await capture(execute, { command: "podman", args: ["machine", "inspect", machineName] }) : null;
    let machines;
    try { machines = JSON.parse(machine); } catch { machines = []; }
    const running = Array.isArray(machines) ? machines.find((item) => item.State === "running") : null;
    facts.machine = running ? { name: machineName, state: running.State, cpus: running.Resources?.CPUs ?? null,
      memoryMiB: running.Resources?.Memory ?? null, diskGiB: running.Resources?.DiskSize ?? null } : null;
  }
  return facts;
}

export function podmanChecks(facts, { platform = process.platform, profile = "small" } = {}) {
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(facts.version ?? "");
  const compose = /^(\d+)\.(\d+)\.(\d+)/.exec(facts.composeVersion ?? "");
  const checks = [
    { name: "Podman engine", ok: facts.available === true && Number(version?.[1]) >= 5,
      detail: facts.available ? `version ${facts.version ?? "unknown"}; Podman >=5 required` : facts.error },
    { name: "Podman rootless", ok: facts.rootless === true, detail: facts.rootless ? "rootless" : "rootful or unknown; use a rootless Podman connection" },
    { name: "Podman Compose provider", ok: Boolean(compose && (Number(compose[1]) > 2 || Number(compose[1]) === 2 && Number(compose[2]) >= 24)),
      detail: `Docker Compose >=2.24 required as the podman compose provider; detected ${facts.composeVersion ?? "unavailable"}. Set PODMAN_COMPOSE_PROVIDER to its executable.` },
    { name: "Podman cgroup v2", ok: ["v2", "2"].includes(facts.cgroupVersion), detail: `cgroup ${facts.cgroupVersion ?? "unknown"}` },
    { name: "Podman CPU limit delegation", ok: facts.cpuLimits === true, detail: facts.cpuLimits ? "cpu controller available" : "cpu controller unavailable; CPU limits cannot be applied" },
    { name: "Podman memory limit delegation", ok: facts.memoryLimits === true, detail: facts.memoryLimits ? "memory controller available" : "memory controller unavailable; memory limits cannot be applied" }
  ];
  if (platform === "darwin") {
    // VM disk capacity must also accommodate its operating system; it is not
    // interchangeable with the fresh free-space requirement on the host.
    const required = { small: [4, 7 * 1024, 20], medium: [4, 11 * 1024, 24], large: [8, 15 * 1024, 32], light: [4, 7 * 1024, 20], standard: [4, 7 * 1024, 24] }[profile];
    const machine = facts.machine;
    checks.push({ name: "Podman machine resources", ok: Boolean(machine && required && machine.cpus >= required[0] && machine.memoryMiB >= required[1] && machine.diskGiB >= required[2]),
      detail: machine && required ? `${machine.cpus} CPUs, ${machine.memoryMiB} MiB RAM, ${machine.diskGiB} GiB disk; need ${required.join(" / ")}. Stop the machine and use podman machine set --cpus ${required[0]} --memory ${required[1]} --disk-size ${required[2]} ${machine.name}, then start it.` : "Start a Podman machine and select its default connection before installation; the active machine must be unambiguous." });
  }
  return checks;
}

export async function podmanIsPresent(execute, facts) {
  if (facts?.available) return true;
  // A stopped macOS machine must not cause an automatic Docker installation.
  // Validate actual version output, not merely a successful command exit.
  const version = await capture(execute, { command: "podman", args: ["--version"] });
  return /^podman(?:-remote)? version \d+\.\d+\.\d+(?:[-+\s]|$)/.test(version ?? "");
}

export async function selectContainerEngine({ requested, stored, platform, execute, offer }) {
  assertEngineUnchanged(stored, requested);
  if (requested !== undefined || stored) return containerEngine(requested ?? stored.engine);
  if (platform === "win32") return "docker";
  try {
    if (await execute({ command: "docker", args: ["info"], timeoutMs: 15000 }, { stdin: null, stdout: null, stderr: null }) === 0) return "docker";
  } catch { /* Fall back only when Podman actually responds with engine metadata. */ }
  const facts = await inspectContainerEngine(execute, "podman", { platform });
  if (await podmanIsPresent(execute, facts) && (!offer || await offer())) return "podman";
  return "docker";
}

export function engineExecutor(execute, selected, { platform = process.platform } = {}) {
  const name = containerEngine(selected);
  if (name === "docker") return execute;
  let socketReady = false;
  return async (spec, io) => {
    if (!["docker", "podman"].includes(spec.command)) return execute(spec, io);
    if (spec.args?.[0] === "compose" && platform === "linux" && !socketReady) {
      const code = await execute({ command: "systemctl", args: ["--user", "start", "podman.socket"], timeoutMs: 15000 }, io);
      if (code !== 0) {
        io?.stderr?.write("Cannot start the rootless Podman API socket. Run systemctl --user start podman.socket as your normal user.\n");
        return code;
      }
      socketReady = true;
    }
    return execute({ ...spec, command: "podman" }, io);
  };
}
