#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  // Configuration for the root `npm run lint` script.
  "eslint.config.mjs",
  "package-lock.json",
  "package.json",
  "tsconfig.base.json"
]);

const publicDocs = new Set([
  "docs/development-stack.md",
  // Linked from the README (review F4: the link was stripped because the file was not exported).
  "docs/architecture.md",
  "docs/clean-room-testing.md",
  "docs/cli-providers.md",
  // Linked from CONTRIBUTING; the policy file drives npm run test:architecture.
  "docs/configuration-reference.md",
  "docs/quality/domain-boundaries.json",
  "docs/decisions/ADR-010-public-distribution.md",
  "docs/getting-started.md",
  "docs/legal/cli-distribution-policy.json",
  "docs/operations.md",
  "docs/installer-release-runbook.md",
  "docs/public-release.md",
  "docs/security-model.md"
]);

// Files this public repository maintains itself. A sync from the private
// source never replaces them, even where the source has a different file at the
// same path (its docs/security-model.md is the internal model; the public one
// carries the installer and host-root guidance). The release workflow exports
// this repository itself and keeps them.
export const publicRepositoryMaintainedFiles = new Set(["docs/security-model.md"]);

const publicScripts = new Set([
  "scripts/dev-stack.mjs",
  "scripts/dev-stack/state.mjs",
  "scripts/dev-stack/processes.mjs",
  "scripts/dev-stack/resources.mjs",
  "scripts/dev-stack/supervisor.mjs",
  "scripts/dev-stack/opencode-wrapper.mjs",
  "scripts/dev-stack/opencode-runtime.mjs",
  "scripts/dev-stack/pty-capability.mjs",
  "scripts/dev-stack/capability-proof.mjs",
  "scripts/dev-stack/terminal-proof.mjs",
  "scripts/dev-stack/acceptance.mjs",
  "scripts/dev-stack/browser-proof.mjs",
  "scripts/dev-stack/lifecycle-proof.mjs",
  "scripts/tests/dev-stack.test.mjs",
  // Loaded by apps/api/src/cli-render-proof-fixture.ts (proof rooms); missing, that path failed (review F18).
  "scripts/cli-render-fixture.mjs",
  // Maintained here; listed so the CI re-export of this repository keeps them.
  "scripts/public-test-exclusions.json",
  "scripts/verify-export-provenance.mjs",
  "scripts/tests/verify-export-provenance.test.mjs",
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
  "scripts/tests/public-credential-install.test.mjs",
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
  "scripts/tests/trivy-report-summary.test.mjs",
  // Contributor path documented in CONTRIBUTING: npm run check
  // (test:architecture), npm run smoke:offline and npm run test:contributor.
  "scripts/domain-boundaries.mjs",
  "scripts/tests/domain-boundaries.test.mjs",
  "scripts/tests/composition-root-size.test.mjs",
  "scripts/quality-known-limitations.mjs",
  "scripts/tests/quality-known-limitations.test.mjs",
  "scripts/contributor-smoke.mjs",
  "scripts/fixtures/offline-cli.mjs",
  "scripts/tests/contributor-smoke.test.mjs"
]);

// Root package.json scripts may name only files in the public tree: exported
// source files plus these files that the public repository maintains itself.
const publicRepositoryScripts = new Set([
  "scripts/public-export.mjs",
  "scripts/tests/public-suite.test.mjs"
]);
const publicRepositoryWorkspaces = new Set(["run-spaceapp"]);
// The public tree carries only the reviewed public tests, so its npm test is
// the public suite that CI runs.
const publicScriptOverrides = new Map([["test", "npm run test:public"]]);

const byteStablePublicFiles = new Set([
  "scripts/public-export.mjs",
  "scripts/tests/public-export.test.mjs"
]);

// Every application and package test is public, except those that cannot pass outside the private
// environment (review F15, measured on the exported tree 2026-10-14): each entry names its reason.
const privateOnlyTests = new Map(Object.entries(JSON.parse(
  readFileSync(new URL("./public-test-exclusions.json", import.meta.url), "utf8")
)));

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
  // Web app manifest icons (source f5f90a9fff): the Space rocket mark only, PNG chunks IHDR/IDAT/IEND, reviewed 2026-10-16.
  ["apps/web/public/brand/apple-touch-icon.png", "3bd68378e1b58b393d479970abcde878ec0f50608fe037cb222770fc6837857b"],
  ["apps/web/public/brand/space-icon-192.png", "2cf31549af07f8116b7a13a6ae91b353646dd6dde4fa7d3d18751fc91f78f79d"],
  ["apps/web/public/brand/space-icon-512.png", "bfae3d0b7eee9659b0f697696189a563dfb8c8356e1d7682b69f2e4301f846d2"],
  // Liquid Glass theme wallpapers (source b7d9434873): planet and rocket artwork, a single VP8 chunk, reviewed 2026-10-16.
  ["apps/web/public/brand/liquid-glass-planet-dark.webp", "3db606410cf74d7177e546059f5fab85a91aaaa622e2f04f60ecc67a0704e5a9"],
  ["apps/web/public/brand/liquid-glass-planet-light.webp", "984d7b5eaad5e68db15f7628db538defe90de8e3210078e0c50d61a0148bf1b8"],
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
  ],
  ["apps/web/public/demo/media/discover-space.jpg", "faf2f2fd4919992b577ee59a27f82a7c9a64affcd17e34cd323c216f192485ad"],
  ["apps/web/public/demo/media/discover-space.mp4", "97427f066761fdf1e197beddfd963f3bba3116180c519eacfa2f7e6867046496"],
  ["apps/web/public/demo/media/hello-there.wav", "4b5d6cdf5fa86b6dcc6ecb793654afa5ac7352b44eb2d12046d094fa627eb87b"],
  ["apps/web/public/demo/media/space-loop-1.mp3", "11c6987efd0d525dab3a17f90c7e47b45414f4127eddcbfe780393eb0c32ee48"],
  ["apps/web/public/demo/media/space-loop-2.mp3", "2ba2a8380b001886dd0d0ab22907d9141a43d3cf9bc52414564d7036f6cdf3aa"],
  ["apps/web/public/demo/media/space-loop-3.mp3", "fa7e84e49c6a552e4e5e09539c42f1412b7acc1a83233a83c4d6ecc6211f2f4a"],
  // Space Gateway CodeAware grammars: byte-identical to the WebAssembly files in the
  // MIT-licensed npm packages tree-sitter-<lang> (versions in THIRD_PARTY_NOTICES.md).
  ["packages/gateway/grammars/tree-sitter-c.wasm", "c852c2a85ebf2beb636aa3b0ef7f7e70458684d74f6741b20dcb296885bed9f9"],
  ["packages/gateway/grammars/tree-sitter-cpp.wasm", "174eb0deb75b2ec7881bcacda9f995648d8e683956e5c2267e69ab6dc503fcbf"],
  ["packages/gateway/grammars/tree-sitter-go.wasm", "9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7"],
  ["packages/gateway/grammars/tree-sitter-java.wasm", "4fdeac4ca6ca089f06c6f7e562abcac1733cd465728cc7031ebb73c2019122c4"],
  ["packages/gateway/grammars/tree-sitter-javascript.wasm", "5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240"],
  ["packages/gateway/grammars/tree-sitter-python.wasm", "16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47"],
  ["packages/gateway/grammars/tree-sitter-rust.wasm", "f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57"],
  ["packages/gateway/grammars/tree-sitter-typescript.wasm", "778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d"]
]);

function joined(...parts) {
  return parts.join("");
}

// Operator-specific markers (hosts, paths, addresses, names) live in the private
// source tree and reach this public script only through PUBLIC_EXPORT_PRIVATE_RULES.
const privateRules = process.env.PUBLIC_EXPORT_PRIVATE_RULES
  ? JSON.parse(readFileSync(process.env.PUBLIC_EXPORT_PRIVATE_RULES, "utf8"))
  : { replacements: [], rules: [] };

const textReplacements = [
  ...privateRules.replacements.map(({ pattern, flags, to }) => [new RegExp(pattern, flags), to]),
  // Any Proxmox VM identifier is private infra and must not leak into the
  // public installer; generic rule covers current and future ids.
  [new RegExp("\\bVM\\d{2,4}\\b", "g"), "public-host"]
];

const contentRules = [
  ...privateRules.rules.map(({ rule, pattern, flags }) => ({ rule, pattern: new RegExp(pattern, flags) })),
  {
    rule: "private-vm-identifier",
    pattern: new RegExp(joined("\\b(?:V", "M|C", "T)\\d{2,4}\\b"))
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
  if (path === "apps/api/src/antigravity-usage-services.ts" || path === "packages/gateway/src/providers/antigravity/oauth.ts") {
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

const scriptFileReference = /(?:^|[\s=])((?:\.\/)?(?:scripts|deploy|docs|demos|starter-memory)\/[^\s"'&|;<>()]+)/g;
const workspaceFlag = /(?:^|\s)(?:-w|--workspace)(?:=|\s+)(\S+)/g;
const rootScriptStep = /^npm (?:run(?:-script)? ([\w:.-]+)|(test|start))(?:\s|$)/;

function scriptSteps(command) {
  return command.split("&&").map((step) => step.trim()).filter(Boolean);
}

function referencedFiles(step) {
  return [...step.matchAll(scriptFileReference)].map((match) => match[1].replace(/^\.\//, ""));
}

function referencedWorkspaces(step) {
  return [...step.matchAll(workspaceFlag)].map((match) => match[1]);
}

// A root-script step (`npm run x`, `npm test`) without -w names another root script.
function referencedRootScript(step) {
  if (referencedWorkspaces(step).length) return null;
  const match = step.match(rootScriptStep);
  return match ? match[1] ?? match[2] : null;
}

/** Problems that would make a public package.json script fail before it runs. */
export function publicScriptProblems(scripts, { hasFile, hasWorkspace }) {
  const problems = [];
  for (const [name, command] of Object.entries(scripts)) {
    for (const step of scriptSteps(command)) {
      for (const path of referencedFiles(step)) {
        if (!hasFile(path)) problems.push(`${name}: missing file ${path}`);
      }
      for (const workspace of referencedWorkspaces(step)) {
        if (!hasWorkspace(workspace)) problems.push(`${name}: missing workspace ${workspace}`);
      }
      const script = referencedRootScript(step);
      if (script && !(script in scripts)) problems.push(`${name}: missing script ${script}`);
    }
  }
  return problems;
}

/**
 * Rewrites the root package.json for the public tree. It applies the public
 * overrides, keeps only `node --test` files that the public tree has, drops a
 * script that needs any other missing file and removes `npm run <dropped>`
 * steps from the remaining chains. It throws when a remaining script still
 * names a missing file, script or workspace, so a public contributor never
 * meets a command that cannot start.
 */
export function publicRootPackage(text, { hasFile, hasWorkspace }) {
  const manifest = JSON.parse(text);
  const scripts = { ...(manifest.scripts ?? {}) };
  for (const [name, command] of publicScriptOverrides) {
    if (name in scripts) scripts[name] = command;
  }
  const dropped = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, command] of Object.entries(scripts)) {
      const steps = [];
      let unavailable = false;
      for (const step of scriptSteps(command)) {
        const nodeTest = step.match(/^node --test\s+(.+)$/);
        if (nodeTest) {
          const args = nodeTest[1].split(/\s+/);
          const files = args.filter((arg) => !arg.startsWith("-"));
          const kept = files.filter((file) => hasFile(file.replace(/^\.\//, "")));
          if (kept.length) steps.push(`node --test ${[...args.filter((arg) => arg.startsWith("-")), ...kept].join(" ")}`);
          continue;
        }
        const script = referencedRootScript(step);
        if (script && !(script in scripts)) continue;
        if (referencedFiles(step).some((path) => !hasFile(path))) {
          unavailable = true;
          break;
        }
        steps.push(step);
      }
      const next = unavailable || steps.length === 0 ? null : steps.join(" && ");
      if (next === command) continue;
      changed = true;
      if (next === null) {
        delete scripts[name];
        dropped.push(name);
      } else {
        scripts[name] = next;
      }
    }
  }
  const problems = publicScriptProblems(scripts, { hasFile, hasWorkspace });
  if (problems.length) {
    throw new Error(`Public package.json scripts reference what the public tree lacks:\n- ${problems.join("\n- ")}`);
  }
  manifest.scripts = scripts;
  return { text: `${JSON.stringify(manifest, null, 2)}\n`, dropped: dropped.sort() };
}

// Markdown links and images: [text](target) / ![alt](target "title").
const markdownLink = /(!?)\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const htmlLink = /\b(?:href|src)="([^"]+)"/g;

// Repository path a relative link points at, or null for URLs and in-page anchors.
function linkedPath(document, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("//")) return null;
  const path = target.split("#")[0].split("?")[0];
  if (!path) return null;
  const resolved = path.startsWith("/") ? path.slice(1) : posix.join(posix.dirname(document), path);
  return posix.normalize(resolved).replace(/\/$/, "");
}

/** Relative links in a Markdown document whose target the public tree lacks. */
export function documentLinkProblems(document, text, hasFile) {
  const problems = [];
  const check = (target) => {
    const path = linkedPath(document, target);
    if (path !== null && !hasFile(path)) problems.push(`${document} links to missing file: ${target}`);
  };
  for (const match of text.matchAll(markdownLink)) check(match[3]);
  for (const match of text.matchAll(htmlLink)) check(match[1]);
  return problems;
}

/**
 * Turns every Markdown link whose target the public tree lacks into its plain
 * link text (an image becomes its alt text); URLs and anchors stay links.
 */
export function unlinkMissingTargets(document, text, hasFile) {
  return text.replace(markdownLink, (whole, image, label, target) => {
    const path = linkedPath(document, target);
    return path === null || hasFile(path) ? whole : label;
  });
}

/**
 * The contributor guide must only send people to commands and files that the
 * public tree has: `npm` commands in its code blocks and its relative links.
 */
export function contributorGuideProblems(guide, scripts, hasFile) {
  const problems = [];
  for (const block of guide.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    for (const line of block[1].split("\n")) {
      const command = line.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "");
      const script = referencedRootScript(command);
      if (script && !(script in scripts)) problems.push(`command needs missing script: ${line.trim()}`);
    }
  }
  return [...problems, ...documentLinkProblems("CONTRIBUTING.md", guide, hasFile)];
}

export function isPublicExportPath(path) {
  const normalized = path.replaceAll("\\", "/");
  // Client binary releases are distributed separately, never inside the server installer.
  if (/^apps\/(desktop|mobile)\//.test(normalized) || normalized.startsWith("apps/web/public/downloads/")) return false;
  // HyperFrames' vendored fonts, sound effects and textures carry mixed licences (OFL for some fonts
  // only, Pixabay, none stated); they stay private until the operator clears them. The skill starts off.
  if (/^agent-skills\/space-hyperframes\/.+\.(?:woff2|mp3|png)$/.test(normalized)) return false;
  if (privateOnlyTests.has(normalized)) return false;
  // Tests named *-postgres* start a disposable PostgreSQL container (--pull=never) that public CI does not have.
  if (/\/(?:tests|__tests__)\/[^/]*-postgres[^/]*$/.test(normalized)) return false;
  if (normalized.includes("/tests/")) {
    return publicScripts.has(normalized) || /^(apps|packages)\//.test(normalized);
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
    // The quality evidence ships with the code it describes, so a review reads both at one commit.
    normalized.startsWith("docs/quality/") ||
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
  trackedMetadata = new Map(),
  // Files the public repository owns (tracked there, never exported). Unknown
  // when null: README/CONTRIBUTING links may then only use the public policy.
  publicRepositoryFiles = null
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
    const keptPublicFiles = publicRepositoryFiles === null ? new Set() : publicRepositoryMaintainedFiles;
    const exportPaths = new Set([...trackedPaths].filter((path) => isPublicExportPath(path) && !keptPublicFiles.has(path)));
    const hasFile = (path) => exportPaths.has(path) || publicRepositoryScripts.has(path);
    const workspaces = new Set(publicRepositoryWorkspaces);
    for (const path of exportPaths) {
      if (!/^(?:apps|packages)\/[^/]+\/package\.json$/.test(path)) continue;
      const name = JSON.parse(await readFile(resolve(source, ...path.split("/")), "utf8")).name;
      if (typeof name === "string") workspaces.add(name);
    }
    const packageContext = { hasFile, hasWorkspace: (name) => workspaces.has(name) };
    // A document link resolves when the public tree has the file (or, for a
    // directory link, any file below it): exported or owned by the public repo.
    const publicTreeFiles = [...exportPaths, ...publicRepositoryScripts, ...publicRepositoryMaintainedFiles,
      ...(publicRepositoryFiles ?? [...publicDocs, ...rootFiles])];
    const publicTreeSet = new Set(publicTreeFiles);
    const linkTargetExists = (path) => publicTreeSet.has(path) ||
      publicTreeFiles.some((file) => file.startsWith(`${path}/`));
    let exportedScripts = null;
    for (const path of [...trackedPaths].sort()) {
      if (!exportPaths.has(path)) continue;
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
          let sanitized = applyPublicOverlay(normalized, sanitizePublicText(original.toString("utf8")));
          if (normalized === "package.json") {
            sanitized = publicRootPackage(sanitized, packageContext).text;
            exportedScripts = JSON.parse(sanitized).scripts;
          }
          // Internal documents stay private; README and exported docs keep their link text only.
          if (normalized === "README.md" || (normalized.startsWith("docs/") && normalized.endsWith(".md"))) {
            sanitized = unlinkMissingTargets(normalized, sanitized, linkTargetExists);
          }
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

    const documentProblems = [];
    if (exportPaths.has("README.md")) {
      documentProblems.push(...documentLinkProblems("README.md",
        await readFile(join(staging, "README.md"), "utf8"), linkTargetExists));
    }
    if (exportPaths.has("CONTRIBUTING.md")) {
      documentProblems.push(...contributorGuideProblems(
        await readFile(join(staging, "CONTRIBUTING.md"), "utf8"), exportedScripts ?? {}, linkTargetExists));
    }
    if (documentProblems.length) {
      throw new Error(`Public README.md/CONTRIBUTING.md point at what the public tree lacks:\n- ${documentProblems.join("\n- ")}`);
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

/**
 * Files this public checkout owns: tracked here and not shipped by the previous
 * export (its PUBLIC_EXPORT_MANIFEST.json). Same rule as the setup sync's
 * stale-path removal, so a link never counts on a file the sync deletes.
 */
export async function publicRepositoryOwnedFiles(root) {
  const tracked = git(["ls-files", "-z"], root).split("\0").filter(Boolean);
  let previous = new Set();
  try {
    const manifest = JSON.parse(await readFile(join(root, "PUBLIC_EXPORT_MANIFEST.json"), "utf8"));
    previous = new Set((manifest.files ?? []).map((file) => file.path));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return new Set(tracked.filter((path) => !previous.has(path)));
}

export async function runCli(argv) {
  const options = parseArgs(argv);
  const sourceRoot = options.source ?? repoRoot;
  if (resolve(sourceRoot) !== repoRoot && !privateRules.rules.length) {
    throw new Error("Exporting a private tree needs PUBLIC_EXPORT_PRIVATE_RULES (the private sanitizer rules).");
  }
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
      trackedMetadata: tree.metadata,
      publicRepositoryFiles: resolve(sourceRoot) === repoRoot ? null : await publicRepositoryOwnedFiles(repoRoot)
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
