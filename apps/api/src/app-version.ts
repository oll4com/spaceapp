import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const GITHUB_DEFAULT_REPO = "oll4com/spaceapp";
const GITHUB_LATEST_CACHE_TTL_MS = 5 * 60 * 1000;

export interface AppVersionStatus {
  appRelease: string;
  currentCommit: string | null;
  shortCommit: string | null;
  currentBranch: string | null;
  dirty: boolean;
  athensTag: string | null;
  githubLatest: string | null;
  githubTagUrl: string | null;
  updateAvailable: boolean;
  behindCount: number;
  checkedAt: string | null;
}

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  build: string | null;
}

function normalizeVersion(value: string | undefined): string {
  const candidate = value?.trim();
  if (!candidate) return "v0.1.0";
  return candidate.startsWith("v") ? candidate : `v${candidate}`;
}

export function parseSemver(value: string): SemverParts | null {
  const match = SEMVER_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    major: Number.parseInt(match[1] ?? "0", 10),
    minor: Number.parseInt(match[2] ?? "0", 10),
    patch: Number.parseInt(match[3] ?? "0", 10),
    prerelease: match[4] ?? null,
    build: match[5] ?? null
  };
}

/**
 * Compare two semver strings. Returns <0 when `left` is older than `right`,
 * 0 when equal, >0 when `left` is newer. Prerelease versions sort before
 * their release counterpart.
 */
export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a && !b) return left.localeCompare(right);
  if (!a) return -1;
  if (!b) return 1;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

export function semverOffsetRecent(current: string, latest: string): number {
  if (compareSemver(current, latest) >= 0) return 0;
  const a = parseSemver(current);
  const b = parseSemver(latest);
  if (!a || !b) return 1;
  return Math.max(b.major - a.major, Math.max(b.minor - a.minor, b.patch - a.patch));
}

interface CachedLatest {
  value: string | null;
  checkedAt: string;
}

async function runGit(args: string[], cwd: string): Promise<string | null> {
  const gitConfig = ["-c", `safe.directory=${cwd}`];
  try {
    const result = await execFileAsync("git", [...gitConfig, ...args], { cwd });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export function resolveGitRoot(env: NodeJS.ProcessEnv): string {
  return env.SPACE_GIT_ROOT ?? env.SPACE_REPO_ROOT ?? process.cwd();
}

async function resolveAthensTag(cwd: string): Promise<string | null> {
  return runGit(["describe", "--tags", "--abbrev=0"], cwd);
}

async function fetchLatestGithubRelease(repo: string): Promise<string | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "space-app-version-check" },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const tagName = (body as { tag_name?: unknown })?.tag_name;
    if (typeof tagName !== "string" || !tagName.trim()) return null;
    return normalizeVersion(tagName);
  } catch {
    return null;
  }
}

export function createAppVersionReader(options: {
  appVersionEnv?: string;
  githubRepo?: string;
  gitRoot?: string;
  now?: () => Date;
}) {
  let cached: CachedLatest | null = null;
  const repo = options.githubRepo ?? GITHUB_DEFAULT_REPO;
  const gitRoot = options.gitRoot ?? resolveGitRoot(process.env);
  const now = options.now ?? (() => new Date());

  async function getLatestCached(): Promise<string | null> {
    if (cached && now().getTime() - Date.parse(cached.checkedAt) < GITHUB_LATEST_CACHE_TTL_MS) {
      return cached.value;
    }
    const value = await fetchLatestGithubRelease(repo);
    cached = { value, checkedAt: now().toISOString() };
    return value;
  }

  return {
    async status(): Promise<AppVersionStatus> {
      const [commit, branch, dirtyMaybe, athensTag, githubLatest] = await Promise.all([
        runGit(["rev-parse", "HEAD"], gitRoot),
        runGit(["branch", "--show-current"], gitRoot),
        runGit(["status", "--porcelain=v1", "--untracked-files=no"], gitRoot),
        resolveAthensTag(gitRoot),
        getLatestCached()
      ]);
      const appRelease = normalizeVersion(options.appVersionEnv);
      const dirty = dirtyMaybe != null && dirtyMaybe.length > 0;
      const checkedAt = cached?.checkedAt ?? now().toISOString();
      const updateAvailable = githubLatest != null && compareSemver(appRelease, githubLatest) < 0;
      return {
        appRelease,
        currentCommit: commit,
        shortCommit: commit?.slice(0, 9) ?? null,
        currentBranch: branch,
        dirty,
        athensTag,
        githubLatest,
        githubTagUrl: githubLatest ? `https://github.com/${repo}/releases/tag/${githubLatest}` : null,
        updateAvailable,
        behindCount: githubLatest ? semverOffsetRecent(appRelease, githubLatest) : 0,
        checkedAt
      };
    }
  };
}

export type AppVersionReader = ReturnType<typeof createAppVersionReader>;
