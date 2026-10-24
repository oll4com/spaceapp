import process from "node:process";
import { Writable } from "node:stream";
import { UNIVERSAL_COMMAND } from "./package-info.mjs";

// Supported container engines. Docker stays the default; Podman is opt-in.
export const ENGINE_IDS = Object.freeze(["docker", "podman"]);
export const DEFAULT_ENGINE = "docker";
export const MIN_PODMAN_VERSION = "5.0.0";

// Versions appear inside longer CLI output (e.g. "Docker version 24.0.7, build ...",
// "podman version 5.2.1", "Docker Compose version v2.24.0", "podman-compose version 1.0.6").
const EMBEDDED_VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

export function resolveEngine(config) {
  const engine = config?.engine ?? DEFAULT_ENGINE;
  if (!ENGINE_IDS.includes(engine)) {
    throw new Error(`Unsupported container engine "${engine}".`);
  }
  return engine;
}

export function engineCli(engine) {
  return engine === "podman" ? "podman" : "docker";
}

export function describeEngine(engine) {
  return engine === "podman" || engine === "podman-compose" ? "Podman" : "Docker";
}

function versionTuple(version) {
  if (typeof version !== "string") {
    return null;
  }
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a, b) {
  const aTuple = versionTuple(a);
  const bTuple = versionTuple(b);
  if (!aTuple || !bTuple) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (aTuple[index] !== bTuple[index]) {
      return aTuple[index] < bTuple[index] ? -1 : 1;
    }
  }
  return 0;
}

function meetsMinVersion(version, minimum) {
  if (typeof version !== "string") {
    return false;
  }
  const comparison = compareVersions(version, minimum);
  return comparison !== null && comparison >= 0;
}

function parseVersion(output) {
  const match = EMBEDDED_VERSION_PATTERN.exec(String(output ?? ""));
  return match ? match[0] : null;
}

function normalizeCgroupVersion(value) {
  if (value === "v1" || value === "1") {
    return "v1";
  }
  if (value === "v2" || value === "2") {
    return "v2";
  }
  return null;
}

function captureStream() {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    }
  });
  return { stream, value: () => value };
}

// Runs one probe against the injected `execute` and collects stdout/stderr.
async function probe(execute, spec) {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await execute(spec, {
    stdin: null,
    stdout: stdout.stream,
    stderr: stderr.stream
  });
  return { code, stdout: stdout.value(), stderr: stderr.value() };
}

// Probes the engine and returns a facts object. `execute(spec, io)` follows the
// launcher convention: it returns the exit code and writes output to io.stdout / io.stderr.
export async function detectEngine(engine, { execute }) {
  const resolved = resolveEngine({ engine });
  const cli = engineCli(resolved);

  const cliProbe = await probe(execute, { command: cli, args: ["--version"] });
  const cliOk = cliProbe.code === 0;
  const cliVersion = cliOk ? parseVersion(cliProbe.stdout) : null;

  let composeOk = false;
  let composeVersion = null;
  let composeProvider = null;
  if (resolved === "podman") {
    const podmanCompose = await probe(execute, {
      command: "podman",
      args: ["compose", "version"]
    });
    if (podmanCompose.code === 0) {
      composeOk = true;
      composeVersion = parseVersion(podmanCompose.stdout);
      composeProvider = "plugin";
    } else {
      const fallback = await probe(execute, {
        command: "podman-compose",
        args: ["--version"]
      });
      if (fallback.code === 0) {
        composeOk = true;
        composeVersion = parseVersion(fallback.stdout);
        composeProvider = "podman-compose";
      }
    }
  } else {
    const dockerCompose = await probe(execute, {
      command: "docker",
      args: ["compose", "version"]
    });
    if (dockerCompose.code === 0) {
      composeOk = true;
      composeVersion = parseVersion(dockerCompose.stdout);
      composeProvider = "plugin";
    }
  }

  const infoSpec = resolved === "podman"
    ? { command: "podman", args: ["info", "--format", "json"] }
    : { command: "docker", args: ["info", "--format", "{{json .}}"] };
  const infoProbe = await probe(execute, infoSpec);
  const daemonOk = infoProbe.code === 0;

  let info = null;
  if (daemonOk) {
    try {
      info = JSON.parse(infoProbe.stdout);
    } catch {
      info = null;
    }
  }

  const facts = {
    engine: resolved,
    cli: { ok: cliOk, version: cliVersion },
    compose: { ok: composeOk, version: composeVersion, provider: composeProvider },
    daemon: { ok: daemonOk },
    rootless: null,
    cgroupVersion: null,
    cpuCount: null,
    memoryBytes: null,
    arch: null,
    storageRoot: null,
    versionOk: false
  };

  if (resolved === "podman") {
    facts.rootless = info?.host?.security?.rootless ?? null;
    facts.cgroupVersion = normalizeCgroupVersion(info?.host?.cgroupVersion);
    facts.cpuCount = info?.host?.cpus ?? null;
    facts.memoryBytes = info?.host?.memTotal ?? null;
    facts.arch = info?.host?.arch ?? null;
    facts.storageRoot = info?.store?.graphRoot ?? null;
    facts.versionOk = meetsMinVersion(cliVersion, MIN_PODMAN_VERSION);
  } else {
    facts.cgroupVersion = normalizeCgroupVersion(info?.CgroupVersion);
    facts.cpuCount = info?.NCPU ?? null;
    facts.memoryBytes = info?.MemTotal ?? null;
    facts.arch = info?.Architecture ?? null;
    facts.storageRoot = info?.DockerRootDir ?? null;
    facts.versionOk = cliOk;
  }

  return facts;
}

// Install help. Docker keeps its existing behavior; Podman is instructions-only
// (never auto-installed).
export function engineInstallHelp(engine, platform = process.platform, distro) {
  const resolved = resolveEngine({ engine });
  if (resolved === "docker") {
    if (platform === "win32") {
      return `Run "${UNIVERSAL_COMMAND} install" to install and start signed Docker Desktop with WSL2 automatically.`;
    }
    if (platform === "darwin") {
      return `Run "${UNIVERSAL_COMMAND} install" to install and start signed Docker Desktop automatically.`;
    }
    return `Run "${UNIVERSAL_COMMAND} install" to install and start Docker Engine and Compose automatically on supported Linux distributions.`;
  }
  const note = "Podman 5 or newer is required; rootless mode is the default when running as a non-root user.";
  if (platform === "darwin") {
    return `Install Podman for macOS: brew install podman && podman machine init && podman machine start. ${note}`;
  }
  if (platform === "win32") {
    return `Podman is not supported on Windows; use Docker Desktop with WSL2 instead. ${note}`;
  }
  const id = String(distro?.ID ?? "").toLowerCase();
  const idFamily = new Set([
    id,
    ...String(distro?.ID_LIKE ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  ]);
  if (id === "fedora" || id === "rhel" || id === "centos") {
    return `Install Podman: sudo dnf install -y podman podman-compose. ${note}`;
  }
  if (id === "ubuntu" || id === "debian") {
    return `Install Podman: sudo apt install -y podman (also install the podman-compose package if "podman compose" is unavailable). ${note}`;
  }
  if (
    idFamily.has("opensuse") ||
    idFamily.has("suse") ||
    id === "opensuse-leap" ||
    id === "opensuse-tumbleweed"
  ) {
    return `Install Podman: sudo zypper install -y podman. ${note}`;
  }
  return `Install Podman 5 or newer for your distribution (Fedora/RHEL: sudo dnf install -y podman podman-compose; Ubuntu/Debian: sudo apt install -y podman; openSUSE: sudo zypper install -y podman). ${note}`;
}

// One-line-per-fact summary for doctor and support-bundle output.
export function engineFactsSummary(facts) {
  const lines = [
    `engine: ${facts.engine}`,
    `version: ${facts.cli?.version ?? "unknown"}`
  ];
  if (facts.engine === "podman") {
    if (facts.rootless === true) {
      lines.push("rootless: yes");
    } else if (facts.rootless === false) {
      lines.push("rootless: no (rootful)");
    } else {
      lines.push("rootless: unknown");
    }
    if (facts.cgroupVersion === "v2") {
      lines.push("cgroup: v2");
      lines.push("limits: CPU/memory limits can be enforced (cgroup v2)");
    } else if (facts.cgroupVersion === "v1") {
      lines.push("cgroup: v1");
      lines.push("limits: CPU/memory limits cannot be enforced (cgroup v1)");
    } else {
      lines.push("cgroup: unknown");
    }
  }
  return lines;
}
