import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { Writable } from "node:stream";

/** Normalize an omitted engine to Docker and reject names outside the supported pair. */
export function containerEngine(value = "docker") {
  if (value !== "docker" && value !== "podman") throw new Error("Container engine must be docker or podman.");
  return value;
}

/** Reject engine migrations, unsupported Podman hosts and host-root access before installation writes. */
export function assertEngineSelection(engine, existing, accessMode, platform) {
  containerEngine(engine);
  if (existing && containerEngine(existing.engine) !== engine) {
    throw new Error("Changing container engines would disconnect existing SpaceApp data. Keep the saved engine or use a separate SPACEAPP_HOME for a fresh installation; in-place migration is not supported.");
  }
  if (engine === "podman" && platform !== "linux" && platform !== "darwin") {
    throw new Error("Podman is supported on Linux and macOS only.");
  }
  if (engine === "podman" && accessMode === "host-root") {
    throw new Error("Podman requires isolated access; host-root is not supported.");
  }
}

/** Probe a command without interactive input or output; a failure or thrown error means unavailable. */
async function available(execute, command, args) {
  try { return await execute({ command, args, timeoutMs: 15000 }, { stdin: null, stdout: null, stderr: null }) === 0; }
  catch { return false; }
}

/** Check executable candidates on the supplied PATH without launching them. */
async function commandOnPath(command, env) {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory && await access(join(directory, command), constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}

/** Honor explicit and saved choices first; otherwise prefer a working Docker engine, then identified Podman. */
export async function selectContainerEngine({ requested, existing, execute, platform, env = process.env, hasPodman = commandOnPath }) {
  if (requested !== undefined) return containerEngine(requested);
  if (existing) return containerEngine(existing.engine);
  if (platform === "win32" || !await hasPodman("podman", env) || await available(execute, "docker", ["info"])) return "docker";
  const podmanVersion = await capture(execute, "podman", ["--version"]);
  if (/^podman version \d+\.\d+(?:\.\d+)?(?:\s|$)/i.test(podmanVersion ?? "")) return "podman";
  // Keep the existing Docker prerequisite installer when neither engine is available.
  return "docker";
}

/** Bind all runtime actions, including nested checkpoint/repair/credential operations, to this installation. */
export function engineExecutor(execute, engine, platform = process.platform, env = process.env) {
  containerEngine(engine);
  const run = (spec, io) => {
    if (spec.command === "docker") spec = { ...spec, command: engine };
    // Serialize keep-id namespace creation through the compatibility API. A parallel
    // large-profile startup on Podman 5.8 returned an incomplete UID mapping.
    if (engine === "podman" && spec.command === "podman" && spec.args?.[0] === "compose") {
      spec = { ...spec, args: ["compose", "--parallel", "1", ...spec.args.slice(1)] };
    }
    return execute(spec, io);
  };
  run.engine = engine;
  run.platform = platform;
  run.engineEnvironment = env;
  return run;
}

/** Capture bounded diagnostic output; failed or timed-out probes return null instead of leaking stderr. */
async function capture(execute, command, args) {
  let text = "";
  const stdout = new Writable({ write(chunk, _encoding, done) { if (text.length < 1024 * 1024) text += chunk.toString(); done(); } });
  try {
    return await execute({ command, args, timeoutMs: 15000 }, { stdin: null, stdout, stderr: null }) === 0 ? text.trim() : null;
  } catch { return null; }
}

/** Decode optional probe output, returning null for unavailable or malformed JSON. */
function json(text) { try { return JSON.parse(text); } catch { return null; } }
/** Compare the leading major/minor version components; missing or malformed versions fail closed. */
function versionAtLeast(version, major, minor = 0) {
  const match = /^(?:v)?(\d+)\.(\d+)(?:\.|$)/.exec(version ?? "");
  return Boolean(match && (Number(match[1]) > major || Number(match[1]) === major && Number(match[2]) >= minor));
}

/** Resolve the machine behind Podman's selected connection, including custom machine names. */
export async function selectedPodmanMachine(execute) {
  const env = execute.engineEnvironment ?? process.env;
  const connections = json(await capture(execute, "podman", ["system", "connection", "list", "--format", "json"]));
  const machines = json(await capture(execute, "podman", ["machine", "list", "--format", "json"]));
  if (!Array.isArray(connections) || !Array.isArray(machines)) return null;
  const connection = connections.find((c) => env.CONTAINER_HOST ? c.URI === env.CONTAINER_HOST
    : env.CONTAINER_CONNECTION ? c.Name === env.CONTAINER_CONNECTION : c.Default);
  if (!connection?.IsMachine) return null;
  let port;
  try { port = Number(new URL(connection.URI).port); } catch { return null; }
  const selected = machines.find((m) => Number(m.Port) === port && [m.Name, `${m.Name}-root`].includes(connection.Name));
  if (!selected?.Running || typeof selected.Name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(selected.Name)) return null;
  const inspected = json(await capture(execute, "podman", ["machine", "inspect", selected.Name]));
  const machine = inspected?.find?.((m) => m.Name === selected.Name);
  return machine ? { name: machine.Name, state: machine.State, cpuCount: machine.Resources?.CPUs,
    memoryMiB: machine.Resources?.Memory, diskGiB: machine.Resources?.DiskSize, rootful: machine.Rootful } : null;
}

/** Only allowlisted capability fields enter a support bundle; never the raw info/environment/connection payload. */
export async function inspectContainerEngine(execute, engine, platform = process.platform) {
  containerEngine(engine);
  const info = json(await capture(execute, engine, ["info", "--format", "json"])) ?? {};
  const compose = await capture(execute, engine, ["compose", "version", "--short"]);
  if (engine === "docker") return {
    name: engine, version: info.ServerVersion ?? null, composeVersion: compose,
    rootless: Array.isArray(info.SecurityOptions) ? info.SecurityOptions.some((x) => x.includes("rootless")) : null,
    cgroupVersion: info.CgroupVersion ?? null, cpuCount: info.NCPU ?? null, memoryBytes: info.MemTotal ?? null
  };
  const machine = platform === "darwin" ? await selectedPodmanMachine(execute) : null;
  return {
    name: engine, version: info.version?.Version ?? null, composeVersion: compose,
    rootless: info.host?.security?.rootless ?? null, selinux: info.host?.security?.selinuxEnabled ?? null,
    cgroupVersion: info.host?.cgroupVersion ?? null,
    cgroupControllers: Array.isArray(info.host?.cgroupControllers) ? info.host.cgroupControllers.filter((x) => ["cpu", "cpuset", "memory", "pids", "io"].includes(x)) : [],
    cpuCount: info.host?.cpus ?? null, memoryBytes: info.host?.memTotal ?? null, machine
  };
}

/** Build operator-facing checks for the supported provider, rootless mode, capacity and delegated cgroups. */
export function podmanChecks(info, platform = process.platform) {
  const checks = [
    { name: "Podman", ok: versionAtLeast(info.version, 5), detail: info.version ?? "not running or inaccessible; start Podman first" },
    { name: "Podman Compose provider", ok: versionAtLeast(info.composeVersion, 5, 6), detail: `${info.composeVersion ?? "unavailable"}; Docker Compose >=5.6.0 is the supported provider (set PODMAN_COMPOSE_PROVIDER to its executable)` },
    { name: "Podman rootless", ok: info.rootless === true, detail: info.rootless === true ? "rootless" : "rootful or unknown; run as your normal user with a rootless connection" },
    { name: "Podman capacity", ok: Number.isFinite(info.cpuCount) && info.cpuCount > 0 && Number.isFinite(info.memoryBytes) && info.memoryBytes > 0,
      detail: `${info.cpuCount ?? "unknown"} CPUs, ${info.memoryBytes ?? "unknown"} bytes RAM; the profile allocation is checked separately` },
    { name: "Podman cgroups", ok: info.cgroupVersion === "v2" && ["cpu", "memory"].every((x) => info.cgroupControllers?.includes(x)),
      detail: `${info.cgroupVersion ?? "unknown"}; delegated controllers: ${(info.cgroupControllers ?? []).join(", ") || "none"}. CPU and memory delegation are required.` }
  ];
  if (platform === "darwin") checks.push({ name: "Podman machine", ok: info.machine?.state === "running" && info.machine.rootful === false,
    detail: info.machine ? `${info.machine.name}: ${info.machine.cpuCount} CPUs, ${info.machine.memoryMiB} MiB RAM, ${info.machine.diskGiB} GiB disk. To resize, stop it and use podman machine set --cpus N --memory MiB --disk-size GiB, then start it.` : "Start a rootless Podman machine, then retry. No machine is created or resized automatically." });
  return checks;
}

/** Report prerequisite checks to the appropriate stream and return their aggregate exit status without installation. */
export async function ensurePodmanAvailable({ execute, platform, stdout, stderr }) {
  const info = await inspectContainerEngine(execute, "podman", platform);
  const checks = podmanChecks(info, platform);
  for (const check of checks) (check.ok ? stdout : stderr).write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}\n`);
  return { code: checks.every((check) => check.ok) ? 0 : 1, reexecuted: false, info };
}

/** Adapt our fixed Compose template, keeping Docker's generated bytes unchanged. */
export function renderEngineCompose(template, engine) {
  if (containerEngine(engine) === "docker") return template;
  // Compose's file secrets are read-only binds, but its Docker provider cannot label those binds for SELinux.
  // Use equivalent read-only, shared-label binds for the four launcher-owned files. Never relabel the whole home.
  return template.replace(/^ {2}([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:|^\S|$(?![\s\S]))/gm, (block, service) => {
    // Only service blocks have an image; top-level named volume/secret declarations do not.
    if (!/^ {4}image:/m.test(block)) return block;
    const secretMounts = [];
    block = block.replace(/^ {4}secrets:\n((?: {6}- [a-z-]+\n)+)/m, (_match, refs) => {
      for (const name of refs.matchAll(/- ([a-z-]+)/g)) {
        if (!["setup-token", "session-secret", "database-url", "postgres-password"].includes(name[1])) throw new Error("Unknown runtime secret.");
        secretMounts.push(`      - ./secrets/${name[1]}:/run/secrets/${name[1]}:ro,z`);
      }
      return "";
    });
    if (secretMounts.length) {
      if (/^ {4}volumes:\n/m.test(block)) block = block.replace(/^ {4}volumes:\n/m, `    volumes:\n${secretMounts.join("\n")}\n`);
      else block += `    volumes:\n${secretMounts.join("\n")}\n`;
    }
    if (["spaceapp-core", "spaceapp-cli", "spaceapp-browser", "codex-sessions-init"].includes(service)) {
      block = block.replace(/^( {4}image:.*\n)/m, '$1    userns_mode: "keep-id:uid=10001,gid=10001"\n');
      // Existing images initialize owned volumes as namespace root, then drop to uid10001.
      if (!/^ {4}user:/m.test(block)) block = block.replace(/^( {4}image:.*\n)/m, '$1    user: "0:0"\n');
    }
    return block.replace(/^( {6}- \.\/[^\n]+)$/gm, (line) => line.endsWith(",z") ? line : `${line}${/:ro$/.test(line) ? ",z" : ":z"}`);
  });
}


/** Compose's compatibility unpause may omit paused Podman containers; resume the exact IDs we paused. */
export async function withPodmanWritersPaused(execute, project, io, backup) {
  const rows = json(await capture(execute, "podman", ["ps", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "status=running", "--format", "json"]));
  if (!Array.isArray(rows)) throw new Error("Cannot determine the running Podman writers; backup was not started.");
  const ids = rows.filter((row) => {
    const service = row.Labels?.["com.docker.compose.service"];
    return ["spaceapp-core", "spaceapp-cli", "spaceapp-browser", "temporal"].includes(service) || service?.startsWith("spaceapp-cli-");
  }).map((row) => row.Id ?? row.ID);
  if (ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id ?? ""))) throw new Error("Podman returned an invalid writer ID.");
  if (!ids.length) return backup();
  let code = 0, resumeCode = 0;
  const pausedIds = [];
  try {
    for (const id of ids) {
      code = await execute({ command: "podman", args: ["pause", id] }, io);
      if (code !== 0) break;
      pausedIds.push(id);
    }
    if (code === 0) code = await backup();
  } finally {
    // Resolve each ID separately: one removed writer must not strand the others.
    for (const id of pausedIds) {
      const current = await execute({ command: "podman", args: ["unpause", id] }, io).catch(() => 1);
      if (current !== 0) resumeCode = current;
    }
    if (resumeCode !== 0) io.stderr.write("Podman could not resume all backup writers. Check their status before continuing.\n");
  }
  return code !== 0 ? code : resumeCode;
}
