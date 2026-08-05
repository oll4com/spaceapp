import { randomUUID } from "node:crypto";

export const INSTALL_PING_ENDPOINT = "https://spaceapp.dev/install-ping.php";
export const INSTALL_PING_TIMEOUT_MS = 5_000;
export const TELEMETRY_DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export function isTelemetryEnabled(env = process.env) {
  const value = String(env.SPACEAPP_TELEMETRY ?? "").trim().toLowerCase();
  if (value === "") {
    return true;
  }
  return !TELEMETRY_DISABLED_VALUES.has(value);
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

export async function reportFirstInstallPing(
  {
    existingConfig,
    env = process.env,
    platform,
    arch,
    launcherVersion,
    runtimeVersion
  },
  options = {}
) {
  if (existingConfig) {
    return null;
  }
  if (!isTelemetryEnabled(env)) {
    return null;
  }
  const payload = buildInstallPing({ platform, arch, launcherVersion, runtimeVersion });
  const sent = await sendInstallPing(payload, options);
  return sent ? payload : null;
}
