import { Writable } from "node:stream";
import { stat } from "node:fs/promises";

export function containerEngine(value = "docker") {
  if (!["docker", "podman"].includes(value)) throw new Error("Container engine must be docker or podman.");
  return value;
}

async function probe(execute, command, args) {
  let output = "";
  const stdout = new Writable({ write(chunk, _encoding, done) {
    if (output.length < 1024 * 1024) output += chunk.toString();
    done();
  } });
  try { return { code: await execute({ command, args, timeoutMs: 15000 }, { stdout, stderr: null }), output: output.trim() }; }
  catch { return { code: 127, output: "" }; }
}

export async function selectContainerEngine({ existing, requested, execute, platform, nonInteractive, offerPodman }) {
  if (requested !== undefined) containerEngine(requested);
  if (existing) {
    const saved = containerEngine(existing.engine);
    if (requested && requested !== saved) throw new Error(`This installation uses ${saved}. Switching engines is refused: its volumes are not visible to ${requested}. Use a separate SPACEAPP_HOME; engine migration is not supported.`);
    return saved;
  }
  if (requested) return requested;
  if (platform === "win32") return "docker";
  if ((await probe(execute, "docker", ["info", "--format", "{{.ServerVersion}}"])).code === 0) return "docker";
  if (await offerPodmanAlternative({ execute, nonInteractive, offerPodman })) return "podman";
  return "docker";
}

export async function offerPodmanAlternative({ execute, nonInteractive, offerPodman }) {
  const result = await probe(execute, "podman", ["--version"]);
  return result.code === 0 && /^podman version \d+\./i.test(result.output) && (nonInteractive || await offerPodman());
}

// One adapter covers lifecycle, checkpoint, storage and provider commands. No
// shell strings or dynamic executable names reach the static spawn dispatcher.
export function executeWithContainerEngine(execute, engine, { workspaceConfig = async () => null } = {}) {
  containerEngine(engine);
  const adapted = async (spec, io) => {
    if (adapted.engine === "podman" && ["docker", "podman"].includes(spec.command)) {
      if (spec.args[0] === "compose" && (spec.args.includes("up") || spec.args.includes("run"))) {
        for (const workspace of (await workspaceConfig())?.workspaces ?? []) {
          let exists = false;
          try { exists = (await stat(workspace.hostPath)).isDirectory(); }
          catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
          if (!exists) throw new Error(`Registered workspace must be an existing directory: ${workspace.hostPath}. Restore it or remove its workspace registration before starting containers.`);
        }
      }
      return execute({ ...spec, command: "podman" }, io);
    }
    return execute(spec, io);
  };
  adapted.engine = engine;
  return adapted;
}

export function podmanFacts(info, composeOutput) {
  const host = info?.host ?? {}, security = host.security ?? {};
  const match = /Docker Compose version v?(\d+)\.(\d+)\.(\d+)/i.exec(composeOutput ?? "");
  const providerVersion = match ? match.slice(1).map(Number) : null;
  const providerSupported = providerVersion && (providerVersion[0] > 2 || providerVersion[0] === 2 && (providerVersion[1] > 24 || providerVersion[1] === 24 && providerVersion[2] >= 4));
  return {
    engine: "podman", version: String(info?.version?.Version ?? "unknown"),
    rootless: security.rootless === true, cgroupVersion: String(host.cgroupVersion ?? "unknown"),
    cpuLimitDelegated: host.cgroupControllers?.includes("cpu") === true,
    memoryLimitDelegated: host.cgroupControllers?.includes("memory") === true,
    composeProvider: match ? "Docker Compose" : "unsupported", composeVersion: match?.slice(1).join(".") ?? "unknown",
    composeSupported: Boolean(providerSupported), cpuCount: host.cpus ?? null, memoryBytes: host.memTotal ?? null,
    diskAvailableBytes: Number.isFinite(info?.store?.graphRootAllocated) && Number.isFinite(info?.store?.graphRootUsed)
      ? Math.max(0, info.store.graphRootAllocated - info.store.graphRootUsed) : null
  };
}

export async function inspectPodman(execute) {
  const result = await probe(execute, "podman", ["info", "--format", "json"]);
  const compose = await probe(execute, "podman", ["compose", "version"]);
  let info;
  try { if (result.code === 0) info = JSON.parse(result.output); } catch { /* Report an unavailable engine. */ }
  return podmanFacts(info, compose.code === 0 ? compose.output : "");
}

export function podmanChecks(facts, platform) {
  return [
    { name: "Podman engine", ok: ["linux", "darwin"].includes(platform) && Number(facts.version.split(".")[0]) >= 5, detail: `version ${facts.version}; Podman >=5 on Linux or macOS required` },
    { name: "Podman rootless", ok: facts.rootless, detail: facts.rootless ? "rootless" : "rootful or unavailable; select a rootless connection" },
    { name: "Podman cgroups", ok: facts.cgroupVersion === "v2" && facts.cpuLimitDelegated && facts.memoryLimitDelegated, detail: `${facts.cgroupVersion}; CPU limits ${facts.cpuLimitDelegated ? "delegated" : "unavailable"}; memory limits ${facts.memoryLimitDelegated ? "delegated" : "unavailable"}` },
    { name: "Podman Compose", ok: facts.composeSupported, detail: `${facts.composeProvider} ${facts.composeVersion}; Docker Compose >=2.24.4 is required as PODMAN_COMPOSE_PROVIDER` }
  ];
}

export async function ensurePodmanAvailable({ execute, platform, stdout, stderr }) {
  const facts = await inspectPodman(execute), checks = podmanChecks(facts, platform);
  for (const check of checks) (check.ok ? stdout : stderr).write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}\n`);
  if (checks.some(check => !check.ok)) stderr.write("Install Podman >=5 and Docker Compose >=2.24.4, configure PODMAN_COMPOSE_PROVIDER, and start your rootless engine. See https://podman.io/docs/installation . On macOS: podman machine start; use podman machine set --rootful=false after stopping a rootful machine.\n");
  return { code: checks.every(check => check.ok) ? 0 : 1 };
}
