export interface DesktopReleaseInfo {
  version: string;
  name?: string;
  builtAt?: string;
  download7zUrl: string | null;
  downloadZipUrl: string | null;
  installerUrl: string | null;
  appImageUrl: string | null;
  debUrl: string | null;
}

const SEMVER_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NUMERIC_IDENTIFIER = /^\d+$/;
const DOWNLOAD_PREFIX = "/api/desktop/download/";

function parseVersion(value: string) {
  const match = SEMVER_PATTERN.exec(value.trim());
  if (!match) return null;
  const core = [match[1], match[2], match[3]].map(Number);
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => NUMERIC_IDENTIFIER.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return { core, prerelease };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = NUMERIC_IDENTIFIER.test(left);
  const rightNumeric = NUMERIC_IDENTIFIER.test(right);
  // No leading zeros, so a longer digit string is a larger number; equal lengths compare lexically.
  if (leftNumeric && rightNumeric && left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * SemVer 2.0 precedence, including prerelease identifiers. Returns null when
 * either side is not a valid version so callers can fail closed.
 */
export function compareDesktopVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return (a.core[index] ?? 0) < (b.core[index] ?? 0) ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) return Math.sign(b.prerelease.length - a.prerelease.length);
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const order = compareIdentifiers(leftPart, rightPart);
    if (order !== 0) return order;
  }
  return 0;
}

export function isDesktopVersionNewer(remoteVersion?: string, localVersion?: string): boolean {
  if (!remoteVersion || !localVersion) return false;
  return (compareDesktopVersions(remoteVersion, localVersion) ?? 0) > 0;
}

function downloadUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(DOWNLOAD_PREFIX)) return null;
  const filename = value.slice(DOWNLOAD_PREFIX.length);
  return filename && !filename.includes("/") ? value : null;
}

/** Accepts only a well-formed /api/desktop/latest payload; anything else is no release. */
export function parseDesktopRelease(value: unknown): DesktopReleaseInfo | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.version !== "string" || compareDesktopVersions(record.version, record.version) === null) return null;
  return {
    version: record.version,
    name: typeof record.name === "string" ? record.name : undefined,
    builtAt: typeof record.builtAt === "string" ? record.builtAt : undefined,
    download7zUrl: downloadUrl(record.download7zUrl),
    downloadZipUrl: downloadUrl(record.downloadZipUrl),
    installerUrl: downloadUrl(record.installerUrl),
    appImageUrl: downloadUrl(record.appImageUrl),
    debUrl: downloadUrl(record.debUrl)
  };
}

/** The artifact the server verified for this platform, or null when none is available. */
export function desktopReleaseDownloadUrl(release: DesktopReleaseInfo | null, platform?: string): string | null {
  if (!release) return null;
  if (platform === "win32") return release.installerUrl ?? release.downloadZipUrl ?? release.download7zUrl;
  if (platform === "linux") return release.appImageUrl ?? release.debUrl;
  return null;
}

/**
 * Linux apps before 0.1.25 update through a server script that cannot work there (0.1.23 needs a direct network path
 * the VPN-only server does not offer and quits after 3 s; 0.1.24 refuses it unsigned): the page downloads the package
 * through the app instead. An unknown version counts as old.
 */
export function desktopUpdateIsDownloadOnly(platform?: string, version?: string): boolean {
  return platform === "linux" && (compareDesktopVersions(version ?? "", "0.1.25") ?? -1) < 0;
}
