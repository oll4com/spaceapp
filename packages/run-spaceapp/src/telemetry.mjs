import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { release } from "node:os";

export const INSTALL_PING_ENDPOINT = "https://spaceapp.dev/install-ping.php";
export const INSTALL_PING_TIMEOUT_MS = 5_000;
export const TELEMETRY_DISABLED_VALUES = new Set(["0", "false", "no", "off"]);
export const TELEMETRY_ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

// Explicit SPACEAPP_TELEMETRY choice: true, false, or null when unset/unknown.
export function telemetryEnvPreference(env = process.env) {
  const value = String(env.SPACEAPP_TELEMETRY ?? "").trim().toLowerCase();
  if (TELEMETRY_DISABLED_VALUES.has(value)) return false;
  if (TELEMETRY_ENABLED_VALUES.has(value)) return true;
  return null;
}

// The owner's answer in the install wizard is the consent; an explicit
// SPACEAPP_TELEMETRY value overrides it in either direction.
export function isInstallPingAllowed({ consent, env = process.env }) {
  const preference = telemetryEnvPreference(env);
  if (preference !== null) return preference;
  return consent === true;
}

export function normalizeOs(platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return String(platform || "other");
}

export function buildInstallPing({
  platform,
  arch,
  launcherVersion,
  runtimeVersion,
  now = new Date()
}) {
  return {
    app: "spaceapp",
    uid: randomUUID(),
    os: normalizeOs(platform),
    arch: String(arch || "unknown"),
    version: String(launcherVersion || "unknown"),
    runtime: String(runtimeVersion || "unknown"),
    install_date: now.toISOString().slice(0, 10)
  };
}

export async function sendInstallPing(
  payload,
  {
    request = globalThis.fetch,
    endpoint = INSTALL_PING_ENDPOINT,
    timeoutMs = INSTALL_PING_TIMEOUT_MS
  } = {}
) {
  if (typeof request !== "function") {
    return false;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `spaceapp-launcher/${payload.version}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`install ping rejected with HTTP ${response.status}`);
    }
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

/** OS version for the install funnel: the distribution on Linux, the product version on macOS and Windows. */
export function describeOsVersion(platform, {
  osRelease = release(),
  readOsRelease = () => readFileSync("/etc/os-release", "utf8")
} = {}) {
  let value = `${normalizeOs(platform)} ${osRelease}`;
  const [major, minor] = String(osRelease).split(".").map(Number);
  if (platform === "linux") {
    try {
      const text = readOsRelease();
      const field = (key) => new RegExp(`^${key}="?([^"\\n]*)"?$`, "m").exec(text)?.[1] ?? "";
      value = `${field("ID")} ${field("VERSION_ID")}`.trim() || value;
    } catch {
      // No os-release: keep the kernel release.
    }
  } else if (platform === "darwin" && major >= 20) {
    value = `macOS ${major - 9}.${minor || 0}`; // Darwin 20 is macOS 11
  } else if (platform === "win32") {
    value = `Windows ${Number(String(osRelease).split(".")[2]) >= 22000 ? 11 : 10} (${osRelease})`;
  }
  return value.replace(/[^A-Za-z0-9 ._()+-]/g, "").slice(0, 48) || undefined;
}

const positiveInteger = (value) => Number.isInteger(value) && value > 0 ? value : undefined;

/** System facts sent with install_started: OS version, CPUs, RAM in GiB, profile and access mode. */
export function installFunnelFacts({ platform, resources, profile, accessMode }, options) {
  return {
    os_version: describeOsVersion(platform, options),
    cpus: positiveInteger(resources?.cpuCount),
    ram_gb: positiveInteger(Math.round((resources?.totalMemoryBytes ?? 0) / 2 ** 30)),
    profile,
    access: accessMode
  };
}

/**
 * Install funnel of a fresh installation whose owner said Yes: install_started, then install_completed or
 * install_failed with the step and the duration. Every event carries the same random install id, which the runtime
 * also receives (SPACE_INSTALL_ID); nothing else identifies the machine or the owner. report() never throws.
 */
export function createInstallFunnel({
  installId,
  platform,
  arch,
  launcherVersion,
  runtimeVersion,
  facts = {},
  request,
  timeoutMs = INSTALL_PING_TIMEOUT_MS,
  now = Date.now
}) {
  const startedAt = now();
  return async function report(event, fields = {}) {
    const payload = {
      ...buildInstallPing({ platform, arch, launcherVersion, runtimeVersion }),
      event,
      install_id: installId,
      ...(event === "install_started" ? facts : { duration_s: Math.max(0, Math.round((now() - startedAt) / 1000)) }),
      ...fields
    };
    try {
      return await sendInstallPing(payload, { request, timeoutMs });
    } catch {
      return false;
    }
  };
}
