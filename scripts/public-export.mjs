#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep
} from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

const rootFiles = new Set([
  ".dockerignore",
  ".gitignore",
  ".nvmrc",
  ".trivyignore",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "Dockerfile",
  "LICENSE",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "THIRD_PARTY_NOTICES.md",
  "package-lock.json",
  "package.json",
  "tsconfig.base.json"
]);

const publicDocs = new Set([
  "docs/clean-room-testing.md",
  "docs/cli-providers.md",
  "docs/decisions/ADR-010-public-distribution.md",
  "docs/getting-started.md",
  "docs/legal/cli-distribution-policy.json",
  "docs/operations.md",
  "docs/installer-release-runbook.md",
  "docs/public-release.md",
  "docs/security-model.md"
]);

const publicScripts = new Set([
  "scripts/publish-npm-candidate.mjs",
  "scripts/tests/publish-npm-candidate.test.mjs",
  "scripts/release-evidence.mjs",
  "scripts/publish-prepared.mjs",
  "scripts/tests/release-evidence.test.mjs",
  "scripts/build-demo-projects.mjs",
  "scripts/tests/opencode-first-run.test.mjs",
  "scripts/container-image-size-budget.mjs",
  "scripts/fix-build-permissions.mjs",
  "scripts/portable-backup.mjs",
  "scripts/portable-restore.mjs",
  "scripts/public-export.mjs",
  "scripts/public-release-readiness.mjs",
  "scripts/release-version.mjs",
  "scripts/release-artifact-preflight.mjs",
  "scripts/reset-owner-password.mjs",
  "scripts/rotate-owner-setup-token.mjs",
  "scripts/space-hygiene-check.mjs",
  "scripts/trivy-report-summary.mjs",
  "scripts/verify-published-containers.mjs",
  "scripts/tests/container-image-size-budget.test.mjs",
  "scripts/tests/mcp-hono-compatibility.test.mjs",
  "scripts/tests/portable-backup-restore.test.mjs",
  "scripts/tests/published-container-verification.test.mjs",
  "scripts/tests/public-compose-config.test.mjs",
  "scripts/tests/public-docker-distribution.test.mjs",
  "scripts/tests/public-export.test.mjs",
  "scripts/tests/public-package-metadata.test.mjs",
  "scripts/tests/public-release-readiness.test.mjs",
  "scripts/tests/public-suite.test.mjs",
  "scripts/tests/public-workflows.test.mjs",
  "scripts/tests/release-artifact-preflight.test.mjs",
  "scripts/tests/release-version.test.mjs",
  "scripts/tests/reset-owner-password.test.mjs",
  "scripts/tests/rotate-owner-setup-token.test.mjs",
  "scripts/tests/trivy-report-summary.test.mjs"
]);

const byteStablePublicFiles = new Set([
  "scripts/public-export.mjs",
  "scripts/tests/public-export.test.mjs"
]);

const publicAppTests = new Set([
  "apps/api/tests/cli-runtime-descriptors.test.ts",
  "apps/api/tests/constant-time-token.test.ts",
  "apps/api/tests/owner-setup-bootstrap.test.ts",
  "apps/api/tests/route-rate-limits.test.ts",
  "apps/api/tests/setup.test.ts",
  "apps/api/tests/storage-warning.test.ts",
  "apps/web/tests/clipboard-html.test.ts",
  "apps/web/tests/owner-setup.test.tsx"
]);

const publicPackageTests = new Set([
  "packages/runtime/tests/public-defaults.test.ts"
]);

const publicBinaryFiles = new Map([
  ["apps/web/public/brand/spaceapp-bg-ascii-orbital-optimized.gif", "42e0be38c08a14c7affca0cdb77583a2d015156a0ca741bef093ddf79078ebcc"],
  ["apps/web/public/brand/spaceapp-bg-ascii-orbital.gif", "2fcddf4f10b823cb579fc9971551b322380269d097654b4a90fba8a51ba7a254"],
  ["apps/web/public/brand/spaceapp-bg-ascii-v1.jpg", "b2bbbdcc8c374358e05b0c463f25d614d4fe05effa77f905fce4ca97d1444bca"],
  ["apps/web/public/brand/spaceapp-bg-ascii-v1.png", "cfe185b32afcbca1700ef3704fd6ba802410c8ad19fb88fd11ee2d44f9f0d06c"],
  ["apps/web/public/brand/spaceapp-bg-ascii-v2.gif", "2fcddf4f10b823cb579fc9971551b322380269d097654b4a90fba8a51ba7a254"],
  ["apps/web/public/brand/spaceapp-bg-ascii-v2.jpg", "027a06230ad6b18a66c07ac981267547d0fac21ed24f86a19aef93aef324a367"],
  ["apps/web/public/brand/spaceapp-bg-ascii-v2.png", "e1d1239925ae8a08da95b3f0b0e50cb46bd5eb55e4f6395c348f34aaabce8fb3"],
  ["apps/web/public/brand/spaceapp-bg-ascii-v3.jpg", "89e618a534eabbe01e6037ce7f532c93b624df786e776a64445f6aa29a522b1b"],
  ["apps/web/public/brand/spaceapp-bg-ascii-v3.png", "822b24344c7c9ebf3cb0908218cd90adff13c99bcdaec07523bdd198d5a202f8"],
  [
    "apps/web/src/assets/hermes-agent.png",
    "f56dc7e9cd3320d7fad604d081af6a98c9bcb245311276e08563b62b1925cb1d"
  ],
  [
    "apps/web/public/brand/spaceapp-open-source-banner.webp",
    "ebe97ac74d4f287e5592b104f9ef54de1759716eba287bcbd20d21a293107de2"
  ],
  [
    "apps/web/src/assets/autohand-icon.png",
    "79fea595f2d60a7ba1b6a451ce5b2be51c98e1792c453e7e3a23b3b8b0b4ece0"
  ],
  [
    "apps/web/public/brand/space-logo-2048.png",
    "4d12a609edfd99f8ab1c3edec7440326fa86c10353b6c61dbb16120698f2bd27"
  ],
  [
    "apps/web/public/brand/space-logo.gif",
    "cbf2cd68586adcf8e86d3b65038152aa85b8f117e147a1092d1f978ab7d3c6c1"
  ],
  [
    "apps/web/public/brand/spaceapp-orbital.gif",
    "ff2cf6ed6737d64d6f29b84f31e037cf2ead54409dc803ae7cf98f96daf8db85"
  ],
  [
    "apps/web/public/brand/spaceapp-orbital.ico",
    "b80f3267f200710534281958b04916ccfa847b1bee20ef8f1e278c235df2328e"
  ],
  [
    "apps/web/public/brand/spaceapp-orbital.png",
    "a50b49f40e9f011771fcbe815c4753b8fafdf109f54dbb9d7a7706a6a478c806"
  ]
]);

function joined(...parts) {
  return parts.join("");
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const textReplacements = [
  [joined("https://space.", "oll4.com:4911"), "http://127.0.0.1:4911"],
  [joined("https://space.", "oll4.com"), "http://127.0.0.1:4911"],
  [joined("space.", "oll4.com"), "spaceapp.example"],
  [joined("/srv/", "space"), "/opt/spaceapp"],
  [joined("/home/", "proxmoxusr"), "/var/lib/spaceapp-user"],
  [joined("/etc/", "docs"), "/opt/spaceapp/docs"],
  [joined("10.", "100.0."), "192.0.2."],
  [joined("olla", ".gr"), "example.invalid"],
  [joined("oll4", ".com"), "example.invalid"],
  [joined("coder-", "codex-", "rooms"), "spaceapp-rooms"],
  [joined("VM", "100"), "public-host"],
  [joined("YUN", "WU"), "LEGACY"],
  [joined("Yun", "wu"), "Legacy"],
  [joined("yun", "wu"), "legacy"],
  [joined("proxmox", "usr"), "spaceapp-user"],
  [joined("pirniramon7@", "gmail.com"), "operator@example.invalid"],
  [joined("pirni", "ramon"), "operator"],
  [joined("162.55.", "99.104"), "192.0.2.10"]
].map(([from, to]) => [new RegExp(escaped(from), "g"), to]);
// The private source repo shorthand must not become the public repo name
// (which appends "app"), so replace it with a negative lookahead rule.
textReplacements.push([
  new RegExp(`${escaped(joined("oll4com/", "space"))}(?!app)`, "g"),
  "spaceapp.example/spaceapp"
]);
// Any Proxmox VM identifier is private infra and must not leak into the
// public installer; generic rule covers current and future ids.
textReplacements.push([new RegExp("\\bVM\\d{2,4}\\b", "g"), "public-host"]);

const contentRules = [
  {
    rule: "private-home-path",
    pattern: new RegExp(escaped(joined("/home/", "proxmoxusr")), "i")
  },
  {
    rule: "private-runtime-path",
    pattern: new RegExp(escaped(joined("/srv/", "space")), "i")
  },
  {
    rule: "private-hostname",
    pattern: new RegExp(escaped(joined("space.", "oll4.com")), "i")
  },
  {
    rule: "private-network-ip",
    pattern: new RegExp(escaped(joined("10.", "100.")))
  },
  {
    rule: "private-business-domain",
    pattern: new RegExp(escaped(joined("olla", ".gr")), "i")
  },
  {
    rule: "private-provider-label",
    pattern: new RegExp(joined("yun", "wu"), "i")
  },
  {
    rule: "private-memory-path",
    pattern: new RegExp(escaped(joined("/etc/docs/", "gemini")), "i")
  },
  {
    rule: "private-vm-identifier",
    pattern: new RegExp(joined("\\b(?:V", "M|C", "T)\\d{2,4}\\b"))
  },
  {
    rule: "private-repository",
    pattern: new RegExp(
      `${joined("coder-", "codex-", "rooms")}|${joined("oll4com/", "space")}(?!app)`,
      "i"
    )
  },
  {
    rule: "github-token",
    pattern: new RegExp(joined("gh", "[pousr]_[A-Za-z0-9]{30,}"))
  },
  {
    rule: "openai-key",
    pattern: new RegExp(
      joined("(?:sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}", "|sk-[A-Za-z0-9]{40,})")
    )
  },
  {
    rule: "google-api-key",
    pattern: new RegExp(joined("AI", "za[0-9A-Za-z_-]{35}"))
  },
  {
    rule: "google-oauth-client-id",
    pattern: new RegExp(joined("[0-9]{6,}-[A-Za-z0-9_-]{10,}\\.apps\\.", "googleusercontent\\.com"))
  },
  {
    rule: "google-oauth-client-secret",
    pattern: new RegExp(joined("GO", "CSPX-[A-Za-z0-9_-]{20,}"))
  },
  {
    rule: "aws-access-key",
    pattern: new RegExp(joined("AK", "IA[0-9A-Z]{16}"))
  },
  {
    rule: "private-key",
    pattern: new RegExp(joined("-----BEGIN ", "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----"))
  },
  {
    rule: "private-operator-email",
    pattern: new RegExp(joined("pirniramon7@", "gmail\\.com"), "i")
  },
  {
    rule: "private-operator-handle",
    pattern: new RegExp(joined("\\bpirni", "ramon\\b"), "i")
  },
  {
    rule: "private-proxmox-ip",
    pattern: new RegExp(joined("162\\.55\\.", "99\\.104"))
  }
];

export function sanitizePublicText(input) {
  let output = input;
  for (const [pattern, replacement] of textReplacements) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function applyPublicOverlay(path, text) {
  if (path === "apps/api/src/antigravity-usage-services.ts") {
    // Provider OAuth values must be owner-supplied; never export embedded clients.
    return text.replace(/(export const (ANTIGRAVITY_CLIENT_(?:ID|SECRET))\s*=\s*)["'][^"'\r\n]*["'](\s*;)/g,
      (_, declaration, name, suffix) => `${declaration}process.env.${name} ?? ""${suffix}`);
  }

  if (path === ".gitignore" && !text.includes("run-spaceapp-*.tgz")) return `${text}\nrun-spaceapp-*.tgz\n`;
  if (path === "apps/api/tests/setup.test.ts") {
    return text.replace('expect(login.cookies[0]?.name).toBe("space_session")', 'expect(login.cookies.find(cookie => cookie.name === "space_session")?.value).toBeTruthy()');
  }
  if (path === "apps/api/src/app.ts") {
    const start = text.indexOf('    if (!user && !request.cookies["space_logged_out"]');
    if (start !== -1) {
      const end = text.indexOf('    if (user && store.getControlActor)', start);
      if (end === -1) throw new Error('Review changed auth bootstrap before public export');
      return text.slice(0, start) + text.slice(end);
    }
  }
  if (["apps/api/src/cli-runtime-descriptors.ts", "apps/api/tests/cli-runtime-descriptors.test.ts"].includes(path)) {
    // First-run native discovery selects an available free model; never pin a retired default.
    const dynamic = text.replace(/defaultModelId: "(?:opencode\/)?big-pickle"/g, 'defaultModelId: null');
    return dynamic.replace('{ id: "cli:opencode", authMode: "MANAGED"', '{ id: "cli:opencode", authMode: "NONE"').replace(/(key: "opencode",[\s\S]*?)authMode: "MANAGED"/, '$1authMode: "NONE"')
      .replace('OpenCode CLI direct operator parity wrapper, /etc cwd, MCP access, and credential smoke are verified.', 'OpenCode is available without credentials. A working free model is checked on first launch.');
  }
  return text;
}

export function isPublicExportPath(path) {
  const normalized = path.replaceAll("\\", "/");
  // Client binary releases are distributed separately, never inside the server installer.
  if (/^apps\/(desktop|mobile)\//.test(normalized) || normalized.startsWith("apps/web/public/downloads/")) return false;
  if (normalized.includes("/tests/")) {
    return publicScripts.has(normalized) ||
      normalized.startsWith("packages/run-spaceapp/tests/") ||
      publicAppTests.has(normalized) ||
      publicPackageTests.has(normalized);
  }
  return rootFiles.has(normalized) ||
    normalized.startsWith(".github/") ||
    normalized === "release/acceptance.json" ||
    normalized.startsWith("apps/") ||
    normalized.startsWith("packages/") ||
    normalized.startsWith("starter-memory/") ||
    normalized.startsWith("demos/") ||
    normalized.startsWith("deploy/docker/") ||
    normalized.startsWith("agent-skills/") ||
    publicDocs.has(normalized) ||
    publicScripts.has(normalized);
}

function isText(buffer) {
  return !buffer.subarray(0, 8192).includes(0);
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function gitObjectHash(buffer, expectedObjectId) {
  const algorithm = expectedObjectId.length === 64 ? "sha256" : "sha1";
  return createHash(algorithm)
    .update(Buffer.from(`blob ${buffer.length}\0`))
    .update(buffer)
    .digest("hex");
}

function normalizeTrackedPath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    posix.normalize(path) !== path ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Tracked path escaped the source tree: ${String(path)}`);
  }
  return path;
}

function isContainedPath(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export async function createPublicExport({
  sourceRoot,
  outputRoot,
  trackedPaths,
  sourceCommit,
  trackedMetadata = new Map()
}) {
  const source = resolve(sourceRoot);
  const output = resolve(outputRoot);
  if (isContainedPath(source, output)) {
    throw new Error("Public export output must be outside the source tree.");
  }
  try {
    await stat(output);
    throw new Error(`Public export output already exists: ${output}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const outputParent = dirname(output);
  await mkdir(outputParent, { recursive: true });
  const staging = await mkdtemp(join(outputParent, `.${basename(output)}-tmp-`));

  try {
    const sourceRealPath = await realpath(source);
    const collisionKeys = new Map();
    const files = [];
    let transformations = 0;
    for (const path of [...trackedPaths].sort()) {
      if (!isPublicExportPath(path)) continue;
      const normalized = normalizeTrackedPath(path);
      const collisionKey = normalized.normalize("NFC").toLocaleLowerCase("en-US");
      const collision = collisionKeys.get(collisionKey);
      if (collision && collision !== normalized) {
        throw new Error(`Public export path collision: ${collision} and ${normalized}`);
      }
      collisionKeys.set(collisionKey, normalized);

      const sourcePath = resolve(source, ...normalized.split("/"));
      const sourceRealFile = await realpath(sourcePath);
      if (!isContainedPath(sourceRealPath, sourceRealFile)) {
        throw new Error(`Tracked path escaped the source tree: ${path}`);
      }
      const sourceStat = await lstat(sourcePath);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error(`Public export accepts regular files only: ${path}`);
      }
      const metadata = trackedMetadata.get(normalized);
      if (metadata?.mode && !/^100(?:644|755)$/.test(metadata.mode)) {
        throw new Error(`Public export accepts regular Git files only: ${path}`);
      }
      const original = await readFile(sourcePath);
      if (metadata?.objectId && gitObjectHash(original, metadata.objectId) !== metadata.objectId) {
        throw new Error(`Tracked file does not match ${sourceCommit}: ${path}`);
      }

      let exported = original;
      if (isText(original)) {
        if (normalized !== "LICENSE" && !byteStablePublicFiles.has(normalized)) {
          const sanitized = applyPublicOverlay(normalized, sanitizePublicText(original.toString("utf8")));
          exported = Buffer.from(sanitized, "utf8");
          if (!exported.equals(original)) transformations += 1;
        }
      } else {
        const expectedHash = publicBinaryFiles.get(normalized);
        if (!expectedHash) {
          throw new Error(`Public export rejected unreviewed binary file: ${path}`);
        }
        if (hashBuffer(original) !== expectedHash) {
          throw new Error(`Public export binary hash changed without review: ${path}`);
        }
      }

      const targetPath = join(staging, ...normalized.split("/"));
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, exported);
      const mode = metadata?.mode === "100755" ? 0o755 : sourceStat.mode & 0o111 ? 0o755 : 0o644;
      await chmod(targetPath, mode);
      files.push({
        path: normalized,
        sourceObjectId: metadata?.objectId ?? null,
        sha256: hashBuffer(exported),
        size: exported.length
      });
    }

    const manifest = {
      format: "spaceapp-public-export",
      schemaVersion: 2,
      sourceCommit,
      fileCount: files.length,
      transformations,
      files
    };
    await writeFile(
      join(staging, "PUBLIC_EXPORT_MANIFEST.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o644 }
    );
    const audit = await auditPublicTree(staging);
    if (audit.findings.length > 0) {
      throw new Error(formatAuditFailure(audit.findings));
    }
    await rename(staging, output);
    return {
      outputRoot: output,
      manifest,
      audit: { ...audit, root: output }
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function walk(root, current = root) {
  const paths = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      paths.push({ path, kind: "symlink" });
    } else if (entry.isDirectory()) {
      paths.push(...await walk(root, path));
    } else if (entry.isFile()) {
      paths.push({ path, kind: "file" });
    }
  }
  return paths;
}

export async function auditPublicTree(root) {
  const absoluteRoot = resolve(root);
  const findings = [];
  for (const item of await walk(absoluteRoot)) {
    const path = relative(absoluteRoot, item.path).split(sep).join("/");
    if (item.kind === "symlink") {
      findings.push({ rule: "symlink", path });
      continue;
    }
    if (
      path === ".git" ||
      path.startsWith(".git/") ||
      /(^|\/)\.env(?:\.|$)/.test(path) ||
      /(^|\/)(?:node_modules|dist|coverage|secrets|backups|var)(?:\/|$)/.test(path) ||
      /\.(?:pem|key|log|sqlite3?|db)$/i.test(path)
    ) {
      findings.push({ rule: "forbidden-path", path });
      continue;
    }
    const buffer = await readFile(item.path);
    if (!isText(buffer)) {
      const expectedHash = publicBinaryFiles.get(path);
      if (!expectedHash) {
        findings.push({ rule: "unreviewed-binary", path });
      } else if (hashBuffer(buffer) !== expectedHash) {
        findings.push({ rule: "binary-hash-mismatch", path });
      }
      continue;
    }
    const content = buffer.toString("utf8");
    for (const { rule, pattern } of contentRules) {
      const match = pattern.exec(content);
      if (!match) continue;
      findings.push({
        rule,
        path,
        line: content.slice(0, match.index).split("\n").length
      });
    }
  }
  return {
    root: absoluteRoot,
    findings: findings.sort((left, right) =>
      left.path.localeCompare(right.path) ||
      contentRules.findIndex(({ rule }) => rule === left.rule) -
        contentRules.findIndex(({ rule }) => rule === right.rule)
    )
  };
}

function formatAuditFailure(findings) {
  return [
    `Public export audit failed with ${findings.length} finding(s):`,
    ...findings.slice(0, 50).map(
      ({ rule, path, line }) => `- ${rule}: ${path}${line ? `:${line}` : ""}`
    )
  ].join("\n");
}

function git(args, sourceRoot = repoRoot) {
  return execFileSync("git", ["-C", sourceRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function trackedTree(sourceCommit, sourceRoot = repoRoot) {
  const value = execFileSync("git", ["-C", sourceRoot, "ls-tree", "-r", "-z", sourceCommit], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const entries = value.split("\0").filter(Boolean).map((entry) => {
    const match = entry.match(/^([0-9]{6}) blob ([0-9a-f]{40,64})\t([\s\S]+)$/);
    if (!match) throw new Error(`Unsupported Git tree entry: ${entry.slice(0, 120)}`);
    return {
      path: match[3],
      mode: match[1],
      objectId: match[2]
    };
  });
  return {
    paths: entries.map((entry) => entry.path),
    metadata: new Map(entries.map((entry) => [entry.path, entry]))
  };
}

function parseArgs(argv) {
  const options = {
    output: null,
    verify: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output" && argv[index + 1]) {
      options.output = argv[index + 1];
      index += 1;
    } else if (argument === "--source" && argv[index + 1]) {
      options.source = resolve(argv[++index]);
    } else if (argument === "--verify") {
      options.verify = true;
    } else {
      throw new Error("Usage: public-export.mjs (--verify | --output <new-directory>)");
    }
  }
  if (options.verify === Boolean(options.output)) {
    throw new Error("Choose exactly one of --verify or --output.");
  }
  return options;
}

export async function runCli(argv) {
  const options = parseArgs(argv);
  const sourceRoot = options.source ?? repoRoot;
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"], sourceRoot);
  if (status) {
    throw new Error("Public export requires a clean source worktree.");
  }
  const sourceCommit = git(["rev-parse", "HEAD"], sourceRoot);
  const tree = trackedTree(sourceCommit, sourceRoot);
  let temporaryRoot = null;
  const outputRoot = options.verify
    ? join(temporaryRoot = await mkdtemp(join(tmpdir(), "spaceapp-public-export-")), "tree")
    : resolve(options.output);
  try {
    const result = await createPublicExport({
      sourceRoot,
      outputRoot,
      trackedPaths: tree.paths,
      sourceCommit,
      trackedMetadata: tree.metadata
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      sourceCommit,
      fileCount: result.manifest.fileCount,
      transformations: result.manifest.transformations,
      output: options.verify ? null : result.outputRoot
    })}\n`);
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  await runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Public export failed."}\n`);
    process.exitCode = 1;
  });
}
