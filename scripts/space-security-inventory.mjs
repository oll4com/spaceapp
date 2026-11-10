#!/usr/bin/env node
// Security Copilot inventory collector (plan clipboard:8ce8_URHW9Dk step 3). Runs inside the Security Copilot pane's CLI as the
// agent user, which reaches every Proxmox host over the paths the operator's agents already use: an SSH alias, `local`, `pve`
// (the full shell on the Proxmox host), `qm:<vmid>` (QEMU guest agent) or `pct:<ctid>` (container). The probe is a fixed, read
// only script (with --refresh it also refreshes the package lists: apt-get update / dnf makecache). Everything a guest prints is
// kept only when it matches a strict shape, so a compromised guest cannot pass text to the agent through package names.
//   space-security-inventory.mjs discover            → JSON list of hosts and how to reach them
//   space-security-inventory.mjs collect <alias> [--refresh] [--family=WINDOWS|MACOS] → JSON inventory (securityInventorySchema)
//   space-security-inventory.mjs scan-images <alias> <sha256:id>... → Trivy's fixable vulnerabilities per image, strict fields only
// The alias `public-installer` is the public installer oll4com/spaceapp: npm's latest run-spaceapp, its lockfile and its GHCR images.
import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { scannerDir, trivyPaths } from "./space-security-scanner-setup.mjs";

/** The fixed probe the collector runs on every host (read only; "refresh" also refreshes the package lists). */
export const PROBE_FILE = new URL("./space-security-probe.sh", import.meta.url);

const NAME = /^[A-Za-z0-9@][A-Za-z0-9@+._:~/-]{0,199}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9+._:~-]{0,119}$/;
const PATH = /^\/[A-Za-z0-9._/+-]{0,199}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,79}$/;
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const ADVISORY = /^[A-Z][A-Z0-9]{1,15}-[A-Za-z0-9:._-]{1,60}$/;
const IMAGE_MAX_BYTES = 6 * 1024 ** 3;
const SEVERITY = { Critical: "CRITICAL", Important: "HIGH", Moderate: "MEDIUM", Low: "LOW" };
const OS_FAMILY = { debian: "DEBIAN", ubuntu: "UBUNTU", almalinux: "ALMALINUX", openwrt: "OPENWRT" };

function sections(text) {
  const out = {};
  let current = null;
  for (const line of text.split("\n")) {
    const header = /^## ([a-z-]+)$/.exec(line);
    if (header) { current = header[1]; out[current] = []; continue; }
    if (current && line.trim()) out[current].push(line);
  }
  return out;
}

/** `kernel-4.18.0-553.177.1.el8_10.x86_64` → name and version-release (the arch dropped). */
export function splitNevra(nevra) {
  const noArch = nevra.replace(/\.(x86_64|noarch|i686|aarch64|src)$/, "");
  const release = noArch.lastIndexOf("-");
  const version = noArch.lastIndexOf("-", release - 1);
  if (release < 0 || version < 0) return null;
  return { name: noArch.slice(0, version), version: noArch.slice(version + 1) };
}

/** Turns the probe's output into an inventory; returns it with the count of lines dropped for not matching a strict shape. */
export function parseProbe(text, host) {
  const s = sections(text);
  let dropped = 0;
  const keep = (ok) => { if (!ok) dropped += 1; return ok; };
  const os = Object.fromEntries((s.os ?? []).map((line) => line.split("=")).filter((pair) => pair.length === 2));
  const pve = typeof os.pve === "string" && VERSION.test(os.pve) ? os.pve : null;
  const family = pve ? "PROXMOX" : OS_FAMILY[os.id] ?? "UNKNOWN";
  const packages = [];
  for (const line of s.dpkg ?? []) {
    const [name, version, source, sourceVersion] = line.split("\t");
    if (!keep(NAME.test(name ?? "") && VERSION.test(version ?? ""))) continue;
    packages.push({ name, version, ...(NAME.test(source ?? "") ? { source } : {}), ...(VERSION.test(sourceVersion ?? "") ? { sourceVersion } : {}) });
  }
  for (const line of s.rpm ?? []) {
    const [name, version, source] = line.split("\t");
    if (!keep(NAME.test(name ?? "") && VERSION.test((version ?? "").replace(/^0:/, "")))) continue;
    packages.push({ name, version: version.replace(/^0:/, ""), ...(NAME.test(source ?? "") ? { source } : {}) });
  }
  for (const line of s.opkg ?? []) {
    const [name, version] = line.split(" - ");
    if (keep(NAME.test(name ?? "") && VERSION.test(version ?? ""))) packages.push({ name, version });
  }
  const pending = new Map();
  for (const line of s["apt-security"] ?? []) {
    const match = /^([^/\s]+)\/\S+\s+(\S+)/.exec(line);
    if (!keep(Boolean(match) && NAME.test(match[1]) && VERSION.test(match[2]))) continue;
    pending.set(match[1], { package: match[1], version: match[2], cves: [], severity: "UNKNOWN" });
  }
  for (const line of s["dnf-security"] ?? []) {
    const [advisory, kind, nevra] = line.trim().split(/\s+/);
    const split = splitNevra(nevra ?? "");
    if (!keep(/^[A-Z][A-Z0-9]{1,15}-[A-Za-z0-9:._-]{1,60}$/.test(advisory ?? "") && split && NAME.test(split.name) && VERSION.test(split.version))) continue;
    const key = `${split.name}\n${advisory}`;
    pending.set(key, { package: split.name, version: split.version, advisory, cves: [], severity: SEVERITY[(kind ?? "").split("/")[0]] ?? "UNKNOWN" });
  }
  for (const line of s["dnf-cves"] ?? []) {
    const [cve, , nevra] = line.trim().split(/\s+/);
    const split = splitNevra(nevra ?? "");
    if (!/^CVE-\d{4}-\d{4,8}$/.test(cve ?? "") || !split) continue;
    for (const entry of pending.values()) if (entry.package === split.name && entry.version === split.version && !entry.cves.includes(cve) && entry.cves.length < 100) entry.cves.push(cve);
  }
  const products = [];
  for (const line of s.php ?? []) {
    const [path, version] = line.split(" ");
    if (keep(PATH.test(path ?? "") && /^\d+\.\d+\.\d+$/.test(version ?? ""))) products.push({ product: "php", version, path });
  }
  for (const line of s.node ?? []) {
    const [path, version] = line.split(" ");
    if (keep(PATH.test(path ?? "") && /^v\d+\.\d+\.\d+$/.test(version ?? ""))) products.push({ product: "node", version: version.slice(1), path });
  }
  for (const line of s.chrome ?? []) {
    const match = /(\d+\.\d+\.\d+\.\d+)/.exec(line);
    if (keep(Boolean(match))) products.push({ product: "chrome", version: match[1] });
  }
  if (pve) products.push({ product: "proxmox_ve", version: pve });
  // Images of the running containers; no "listed" line means Docker could not be listed (not: no images).
  const docker = s.docker ?? [];
  const images = docker.includes("listed") ? docker.filter((line) => line !== "listed").map((line) => line.split(" ")).filter(([ref, id]) =>
    keep(IMAGE_REF.test(ref ?? "") && IMAGE_ID.test(id ?? ""))).map(([ref, id]) => ({ ref, id })).slice(0, 200) : null;
  const listening = new Set();
  for (const line of s.listening ?? []) {
    const match = /^(.*):(\d{1,5})$/.exec(line.trim());
    if (!match || /^(127\.|\[::1\]|::1)/.test(match[1])) continue;
    const port = Number(match[2]);
    if (port >= 1 && port <= 65535) listening.add(port);
  }
  return {
    inventory: {
      alias: host.alias, label: LABEL.test(host.label) ? host.label : host.alias.replace(/[^A-Za-z0-9 ._()-]/g, "-"), reach: host.reach,
      os: { family, version: /^[A-Za-z0-9._-]{0,40}$/.test(os.version ?? "") ? os.version ?? "" : "", kernel: /^[A-Za-z0-9+._-]{0,80}$/.test(os.kernel ?? "") ? os.kernel ?? "" : "" },
      packages, products, libraries: [], pendingSecurity: [...pending.values()], listening: [...listening].sort((a, b) => a - b).slice(0, 500),
      rebootRequired: (s.reboot ?? []).includes("yes"), ...(images ? { images } : {})
    },
    dropped
  };
}

/** npm packages of a package-lock.json (v2/v3 `packages` map), deduplicated by name and version. */
export function lockfileLibraries(lock, from) {
  const out = [];
  for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
    const at = path.lastIndexOf("node_modules/");
    if (at < 0 || !entry || typeof entry.version !== "string" || entry.link) continue;
    const name = path.slice(at + "node_modules/".length);
    if (NAME.test(name) && VERSION.test(entry.version)) out.push({ ecosystem: "npm", name, version: entry.version, from });
  }
  return out;
}

/** SpaceApp's own libraries on public-host: stable's and dev's lockfiles, each CLI's lockfile and the Python venvs. */
async function spaceLibraries() {
  const libraries = [];
  const seen = new Set();
  const add = (list) => { for (const item of list) { const key = `${item.ecosystem}\n${item.name}\n${item.version}`; if (!seen.has(key)) { seen.add(key); libraries.push(item); } } };
  const lockfiles = ["/opt/spaceapp/package-lock.json", "/opt/spaceapp-dev/package-lock.json"];
  for (const cli of await readdir("/opt/spaceapp/var/cli-versions").catch(() => [])) {
    const current = await readlink(`/opt/spaceapp/var/cli-versions/${cli}/current`).catch(() => null);
    if (current && /^[A-Za-z0-9._-]+$/.test(current)) lockfiles.push(`/opt/spaceapp/var/cli-versions/${cli}/${current}/package-lock.json`);
  }
  for (const file of lockfiles) {
    const lock = await readFile(file, "utf8").then(JSON.parse).catch(() => null);
    if (lock) add(lockfileLibraries(lock, file));
  }
  for (const venv of ["/opt/spaceapp/var/models/venv", "/opt/spaceapp/var/models/video/venv"]) {
    for (const lib of await readdir(join(venv, "lib")).catch(() => [])) {
      for (const entry of await readdir(join(venv, "lib", lib, "site-packages")).catch(() => [])) {
        const match = /^([A-Za-z0-9_.-]+)-([A-Za-z0-9.+_-]+)\.dist-info$/.exec(entry);
        if (match && NAME.test(match[1]) && VERSION.test(match[2])) add([{ ecosystem: "PyPI", name: match[1], version: match[2], from: venv }]);
      }
    }
  }
  return libraries.slice(0, 20_000);
}

/**
 * Runs a fixed command. A failure reports only a fixed reason (exit code, signal, timeout): stderr can come from the host, and a
 * compromised guest must not reach the agent through an error message (security review 2026-10-24).
 */
export function failureMessage(file, error) {
  const name = file.split("/").pop();
  const reason = error.killed ? "timed out" : typeof error.code === "number" ? `exit ${error.code}${name === "ssh" && error.code === 255 ? " (connection or login refused)" : ""}`
    : error.signal ? `signal ${error.signal}` : "could not start";
  return `${name} ${reason}`;
}
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: options.timeoutMs ?? 150_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (!error || stdout) resolve(stdout); else reject(new Error(failureMessage(file, error)));
    });
    if (options.input !== undefined) { child.stdin.end(options.input); }
  });
}

/** Runs a fixed command and answers its exit code and stdout (a nonzero exit is an answer here, e.g. a missing registry key). */
function runCode(file, args, timeoutMs = 150_000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error && typeof error.code !== "number") reject(new Error(failureMessage(file, error))); else resolve({ code: error ? error.code : 0, out: stdout });
    });
  });
}
/** POSIX single quotes: the qm wrapper reaches pve over SSH, whose shell parses the command line once more. */
export const shellQuote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`;
/** One command in a QEMU guest through its guest agent; answers the guest's exit code and stdout. */
export async function guestExec(vmid, argv, timeoutSeconds = 120) {
  const { out } = await runCode("qm", ["guest", "exec", vmid, "--timeout", String(timeoutSeconds), "--", ...argv.map(shellQuote)], (timeoutSeconds + 30) * 1000);
  const answer = JSON.parse(out);
  return { code: Number(answer.exitcode ?? 1), out: String(answer["out-data"] ?? "") };
}

const PVE_SHELL = ["-n", "ssh", "-i", "/root/.ssh/id_rsa", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "spaceapp-user@192.0.2.1"];
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/** Runs the probe on the host and returns its raw output. */
export async function probe(alias, refresh) {
  const arg = refresh ? "refresh" : "plain";
  const PROBE = await readFile(PROBE_FILE, "utf8");
  if (alias === "local") return run("sh", ["-s", arg], { input: PROBE });
  if (alias === "pve") return run("sudo", [...PVE_SHELL, "sh", "-s", arg], { input: PROBE });
  const qm = /^qm:(\d{2,6})$/.exec(alias);
  if (qm) return (await guestExec(qm[1], ["sh", "-c", PROBE, "probe", arg], 120)).out;
  const pct = /^pct:(\d{2,6})$/.exec(alias);
  if (pct) {
    const dir = await mkdtemp(join(tmpdir(), "space-security-probe-"));
    try {
      const file = join(dir, "probe.sh");
      await writeFile(file, PROBE.replace('[ "$1" = refresh ]', `[ "${arg}" = refresh ]`), { mode: 0o600 });
      return await run(join(homedir(), "scripts", "codex_pve_ct_run.sh"), ["--timeout", "120", "--file", file, pct[1]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,62}$/.test(alias)) throw new Error(`Not a host alias: ${alias}`);
  return run("ssh", [...SSH_OPTIONS, alias, "sh", "-s", arg], { input: PROBE });
}

/** Trivy's JSON report → the strict vulnerability shape (no titles or descriptions: an image's content is the host's text). */
export function parseTrivyReport(report) {
  const out = new Map();
  for (const result of report?.Results ?? []) {
    for (const vuln of result?.Vulnerabilities ?? []) {
      const entry = { id: vuln?.VulnerabilityID, pkg: vuln?.PkgName, installed: vuln?.InstalledVersion, fixed: String(vuln?.FixedVersion ?? "").split(/,\s*/)[0],
        severity: ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(vuln?.Severity) ? vuln.Severity : "UNKNOWN" };
      if (ADVISORY.test(entry.id ?? "") && NAME.test(entry.pkg ?? "") && VERSION.test(entry.installed ?? "") && VERSION.test(entry.fixed)) {
        out.set(`${entry.id}\n${entry.pkg}\n${entry.installed}`, entry);
      }
    }
  }
  return [...out.values()].slice(0, 3000);
}

/** Streams `docker save <id>` from a LOCAL or SSH host into a file, at most IMAGE_MAX_BYTES (read only on the host). */
async function exportImage(alias, id, file) {
  const remote = `S=; [ "$(id -u)" = 0 ] || S="sudo -n"; exec $S docker save ${id}`;
  const child = alias === "local" ? spawn("sudo", ["-n", "docker", "save", id], { stdio: ["ignore", "pipe", "ignore"] })
    : spawn("ssh", [...SSH_OPTIONS, alias, remote], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise((resolve) => { child.on("close", (code, signal) => resolve({ code, signal })); child.on("error", () => resolve({ code: null, signal: null })); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
  let bytes = 0;
  child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes > IMAGE_MAX_BYTES) child.kill("SIGKILL"); });
  await pipeline(child.stdout, createWriteStream(file, { mode: 0o600 })).catch(() => undefined);
  const { code, signal } = await exited;
  clearTimeout(timer);
  if (bytes > IMAGE_MAX_BYTES) throw new Error("image larger than 6 GiB");
  if (code !== 0) throw new Error(`docker save ${signal ? `signal ${signal}` : code === null ? "could not start" : `exit ${code}${alias !== "local" && code === 255 ? " (connection or login refused)" : ""}`}`);
}

/** Exports each image and scans it with the pinned Trivy: fixable vulnerabilities only, the scan's own text never kept. */
export async function scanImages(alias, ids, paths = trivyPaths()) {
  if (alias !== "local" && !/^[A-Za-z][A-Za-z0-9_.-]{0,62}$/.test(alias)) throw new Error("Image scans reach LOCAL and SSH hosts only.");
  // The public installer's images are read from GHCR by digest (Trivy pulls them anonymously); nothing is exported from a host.
  const published = alias === PUBLIC_INSTALLER ? new Map((await publicRelease()).images.map((image) => [image.id, image.ref])) : null;
  if (!existsSync(paths.binary)) throw new Error("Trivy is not installed: node /opt/spaceapp/scripts/space-security-scanner-setup.mjs --install");
  // Under /opt/spaceapp/var, not /tmp: an exported image can be gigabytes.
  await mkdir(join(scannerDir(), "work"), { recursive: true });
  const dir = await mkdtemp(join(scannerDir(), "work", "scan-"));
  const images = [], failed = [];
  try {
    for (const id of ids) {
      if (!IMAGE_ID.test(id)) throw new Error(`Not an image id: ${String(id).slice(0, 80)}`);
      const file = join(dir, "image.tar");
      try {
        const ref = published?.get(id);
        if (published && !ref) throw new Error("not an image of the latest release");
        if (!published) await exportImage(alias, id, file);
        const source = published ? ["--image-src", "remote", "--platform", "linux/amd64", `${ref.split(":").slice(0, -1).join(":")}@${id}`] : ["--input", file];
        const report = JSON.parse(await run(paths.binary, ["image", ...source, "--scanners", "vuln", "--ignore-unfixed", "--format", "json", "--quiet",
          "--cache-dir", paths.cache, "--cache-backend", "memory", "--skip-java-db-update", "--timeout", "15m"], { timeoutMs: 20 * 60_000 }));
        images.push({ id, vulns: parseTrivyReport(report) });
      } catch (error) {
        failed.push({ id, reason: error instanceof SyntaxError ? "trivy answered no report" : error.message });
      } finally {
        await rm(file, { force: true });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { images, failed };
}

// ---- Windows and macOS (step 13 D). Read only: wmic, reg query, netstat and a Windows Update search; sw_vers, softwareupdate --list, lsof.
const WINDOWS_UPDATE_SEARCH = "$s=New-Object -ComObject Microsoft.Update.Session;$r=$s.CreateUpdateSearcher().Search(\"IsInstalled=0 and IsHidden=0 and Type='Software'\");"
  + "foreach($u in $r.Updates){$kb=$u.KBArticleIDs|Select-Object -First 1;$sec=@($u.Categories|Where-Object{$_.Name -eq 'Security Updates'}).Count;\"KB$kb`t$($u.MsrcSeverity)`t$sec\"}";
export const WINDOWS_COMMANDS = {
  os: ["wmic", "os", "get", "Version,BuildNumber,ProductType", "/value"],
  hotfix: ["wmic", "qfe", "get", "HotFixID", "/value"],
  software: ["reg", "query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "/s"],
  softwarewow: ["reg", "query", "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "/s"],
  listening: ["netstat", "-ano", "-p", "tcp"],
  reboot: ["reg", "query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired"],
  updates: ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_UPDATE_SEARCH, "utf16le").toString("base64")]
};
const MAC_PROBE = `echo "## os"; sw_vers; echo "## updates"; softwareupdate --list 2>&1; echo "## listening"; lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}'; echo "## end"`;

/** Runs the Windows commands one by one (over the guest agent or Windows OpenSSH) into one sectioned text; a failed command leaves its section empty. */
async function windowsProbe(alias) {
  const qm = /^qm:(\d{2,6})$/.exec(alias);
  if (!qm && !/^[A-Za-z][A-Za-z0-9_.-]{0,62}$/.test(alias)) throw new Error(`Not a Windows host alias: ${alias}`);
  const quote = (arg) => /[\s"]/.test(arg) ? `"${arg}"` : arg;
  let text = "";
  for (const [section, argv] of Object.entries(WINDOWS_COMMANDS)) {
    // The Windows Update search can take minutes; Windows Server 2008 R2's PowerShell 2 does not start under the guest agent at all.
    const seconds = section === "updates" ? 600 : 120;
    const result = await (qm ? guestExec(qm[1], argv, seconds) : runCode("ssh", [...SSH_OPTIONS, alias, ...argv.map(quote)], seconds * 1000)).catch(() => null);
    if (section === "os" && result?.code !== 0) throw new Error("wmic os answered no data");
    text += `## ${section}\n${result?.code === 0 ? (section === "reboot" ? "yes" : result.out.replace(/\r/g, "")) : ""}\n`;
  }
  return `${text}## end\n`;
}

const WINDOWS_SEVERITY = { Critical: "CRITICAL", Important: "HIGH", Moderate: "MEDIUM", Low: "LOW" };
/** A strict package name from a Windows or macOS display name: everything outside the shape becomes "_". */
const displayName = (text) => (text ?? "").trim().replace(/[^A-Za-z0-9@+._:~/-]+/g, "_").replace(/^[^A-Za-z0-9@]+/, "").replace(/_+$/, "").slice(0, 200);

/** Windows probe text → inventory: installed KBs and programs as packages, pending security updates by KB, the OS as a product. */
export function parseWindowsProbe(text, host) {
  const s = sections(text);
  let dropped = 0;
  const keep = (ok) => { if (!ok) dropped += 1; return ok; };
  const os = Object.fromEntries((s.os ?? []).map((line) => line.trim().split("=")).filter((pair) => pair.length === 2));
  const version = /^\d+\.\d+\.\d+$/.test(os.Version ?? "") ? os.Version : "";
  const packages = [];
  for (const line of s.hotfix ?? []) {
    const kb = /^HotFixID=(KB\d{4,8})\s*$/.exec(line.trim());
    if (kb) packages.push({ name: kb[1], version: "installed" });
  }
  for (const block of [...(s.software ?? []), "", ...(s.softwarewow ?? [])].join("\n").split(/\n(?=HKEY_)/)) {
    const name = /^\s+DisplayName\s+REG_SZ\s+(.+)$/m.exec(block)?.[1], release = /^\s+DisplayVersion\s+REG_SZ\s+(\S+)\s*$/m.exec(block)?.[1];
    if (!name || !release) continue;
    const normalized = displayName(name);
    if (keep(NAME.test(normalized) && VERSION.test(release))) packages.push({ name: normalized, version: release });
  }
  const pending = [];
  for (const line of s.updates ?? []) {
    const [kb, severity, security] = line.split("\t");
    if (!/^KB\d{4,8}$/.test(kb ?? "") || (!WINDOWS_SEVERITY[severity] && security?.trim() === "0")) continue;
    pending.push({ package: kb, advisory: `MSKB-${kb.slice(2)}`, cves: [], severity: WINDOWS_SEVERITY[severity] ?? "UNKNOWN" });
  }
  const listening = new Set();
  for (const line of s.listening ?? []) {
    const match = /^\s*TCP\s+(\S+):(\d{1,5})\s+\S+\s+LISTENING\b/.exec(line);
    if (match && !/^(127\.|\[::1\])/.test(match[1])) listening.add(Number(match[2]));
  }
  return {
    inventory: {
      alias: host.alias, label: LABEL.test(host.label) ? host.label : host.alias.replace(/[^A-Za-z0-9 ._()-]/g, "-"), reach: host.reach,
      os: { family: "WINDOWS", version, kernel: /^\d{1,6}$/.test(os.BuildNumber ?? "") ? os.BuildNumber : "" },
      packages: packages.slice(0, 20_000),
      products: [...(version ? [{ product: os.ProductType === "1" ? "windows" : "windows_server", version }] : []),
        ...packages.filter((pkg) => pkg.name === "Google_Chrome" && /^\d+\.\d+\.\d+\.\d+$/.test(pkg.version)).slice(0, 1).map((pkg) => ({ product: "chrome", version: pkg.version }))],
      libraries: [], pendingSecurity: pending.slice(0, 5000), listening: [...listening].sort((a, b) => a - b).slice(0, 500), rebootRequired: (s.reboot ?? []).includes("yes")
    },
    dropped
  };
}

/** macOS probe text → inventory: the OS as a product, pending Apple updates (softwareupdate --list) as pending security updates. */
export function parseMacProbe(text, host) {
  const s = sections(text);
  const os = Object.fromEntries((s.os ?? []).map((line) => line.split(":").map((part) => part.trim())).filter((pair) => pair.length === 2));
  const version = /^\d+(\.\d+){1,2}$/.test(os.ProductVersion ?? "") ? os.ProductVersion : "";
  const pending = [];
  const lines = s.updates ?? [];
  lines.forEach((line, index) => {
    const label = /^\* Label: (.+)$/.exec(line.trim())?.[1];
    if (!label) return;
    const release = /Version: ([0-9][0-9A-Za-z.()-]*),/.exec(lines[index + 1] ?? "")?.[1]?.replace(/[()]/g, "");
    const name = displayName(label);
    if (NAME.test(name)) pending.push({ package: name, ...(release && VERSION.test(release) ? { version: release } : {}), advisory: `APPLE-${name.replace(/[^A-Za-z0-9:._-]/g, "-").slice(0, 54)}`, cves: [], severity: "UNKNOWN" });
  });
  const listening = new Set();
  for (const line of s.listening ?? []) {
    const match = /^(.*):(\d{1,5})$/.exec(line.trim());
    if (match && !/^(127\.|\[::1\]|localhost)/.test(match[1])) listening.add(Number(match[2]));
  }
  return {
    inventory: {
      alias: host.alias, label: LABEL.test(host.label) ? host.label : host.alias.replace(/[^A-Za-z0-9 ._()-]/g, "-"), reach: host.reach,
      os: { family: "MACOS", version, kernel: /^[0-9A-Za-z]{1,12}$/.test(os.BuildVersion ?? "") ? os.BuildVersion : "" },
      packages: [], products: version ? [{ product: "macos", version }] : [], libraries: [], pendingSecurity: pending.slice(0, 500),
      listening: [...listening].sort((a, b) => a - b).slice(0, 500), rebootRequired: false
    },
    dropped: 0
  };
}

export const PUBLIC_INSTALLER = "public-installer";
const PUBLIC_IMAGES = ["core", "cli", "browser"];
const MANIFEST_TYPES = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

/** The published release: npm's latest run-spaceapp and the digest of each GHCR image of that version (anonymous reads). */
export async function publicRelease(fetchImpl = fetch) {
  const get = async (url, init) => {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
    return response;
  };
  const version = (await (await get("https://registry.npmjs.org/run-spaceapp/latest")).json()).version;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("npm named no run-spaceapp release");
  const images = [];
  for (const name of PUBLIC_IMAGES) {
    const repo = `oll4com/spaceapp-${name}`;
    const { token } = await (await get(`https://ghcr.io/token?scope=repository:${repo}:pull`)).json();
    const digest = (await get(`https://ghcr.io/v2/${repo}/manifests/${version}`, { method: "HEAD", headers: { authorization: `Bearer ${token}`, accept: MANIFEST_TYPES } }))
      .headers.get("docker-content-digest");
    if (IMAGE_ID.test(digest ?? "")) images.push({ ref: `ghcr.io/${repo}:${version}`, id: digest });
  }
  return { version, images };
}

/** The public installer as a host: its lockfile's npm packages (OSV matches them) and its published images (Trivy scans them). */
export async function collectPublicInstaller(fetchImpl = fetch) {
  const { version, images } = await publicRelease(fetchImpl);
  const response = await fetchImpl(`https://raw.githubusercontent.com/oll4com/spaceapp/v${version}/package-lock.json`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`raw.githubusercontent.com answered HTTP ${response.status}`);
  return {
    inventory: {
      alias: PUBLIC_INSTALLER, label: `Public installer oll4com-spaceapp ${version}`, reach: "LOCAL", os: { family: "UNKNOWN", version, kernel: "" },
      packages: [], products: [], libraries: lockfileLibraries(await response.json(), `/oll4com/spaceapp/v${version}/package-lock.json`), pendingSecurity: [],
      listening: [], rebootRequired: false, images
    },
    dropped: 0
  };
}

/** Hosts from ~/.ssh/config (aliases with a vmNNN/ctNNN name map to their guest) and the Proxmox guest lists. */
export function discoverHosts(sshConfig, qmList, pctList) {
  const aliases = new Map();
  let current = null;
  for (const line of sshConfig.split("\n")) {
    const host = /^Host\s+(.+)$/.exec(line.trim());
    if (host) {
      const names = host[1].split(/\s+/).filter((name) => !name.includes("*"));
      current = { alias: names[0], names, user: null };
      aliases.set(current.alias, current);
      continue;
    }
    const user = /^User\s+(\S+)/.exec(line.trim());
    if (user && current) current.user = user[1];
  }
  const guestAlias = new Map();
  for (const entry of aliases.values()) {
    for (const name of entry.names) {
      const id = /^(?:vm|ct)(\d{2,6})$/.exec(name);
      // Admin-only and git aliases (Windows Administrator, the Gitea git user) are not inventory paths.
      if (id && !guestAlias.has(id[1]) && entry.user !== "git") guestAlias.set(id[1], entry);
    }
  }
  const hosts = [{ alias: "pve", label: "Proxmox host (pve)", reach: "PVE_SHELL", status: "ACTIVE", osFamily: "PROXMOX" },
    { alias: PUBLIC_INSTALLER, label: "Public installer oll4com-spaceapp", reach: "LOCAL", status: "ACTIVE", osFamily: "UNKNOWN" }];
  const guests = [
    ...qmList.split("\n").map((line) => /^\s*(\d+)\s+(\S+)\s+(running|stopped|paused)\b/.exec(line)).filter(Boolean).map((m) => ({ id: m[1], name: m[2], state: m[3], kind: "qm" })),
    ...pctList.split("\n").map((line) => /^(\d+)\s+(running|stopped)\s+(?:\S+\s+)?(\S+)\s*$/.exec(line.trim())).filter(Boolean).map((m) => ({ id: m[1], name: m[3], state: m[2], kind: "pct" }))
  ];
  for (const guest of guests) {
    const alias = guestAlias.get(guest.id);
    const windows = alias && /^(Administrator|spaceadmin)$/.test(alias.user ?? "");
    const label = `${guest.kind === "qm" ? "VM" : "CT"}${guest.id} ${guest.name}`.replace(/[^A-Za-z0-9 ._()-]/g, "-").slice(0, 80);
    const local = guest.id === "207";
    hosts.push({
      alias: local ? "local" : alias ? alias.alias : `${guest.kind}:${guest.id}`,
      label, reach: local ? "LOCAL" : alias ? "SSH" : guest.kind === "qm" ? "QM_GUEST_EXEC" : "PCT_EXEC",
      status: guest.state === "running" ? "ACTIVE" : "STOPPED", osFamily: windows ? "WINDOWS" : alias?.user === "spaceapp-lab-recovery" ? "MACOS" : "UNKNOWN"
    });
  }
  return hosts;
}

async function main(argv) {
  const [command, alias, ...flags] = argv;
  if (command === "discover") {
    const [sshConfig, qmList, pctList] = await Promise.all([
      readFile(join(homedir(), ".ssh", "config"), "utf8").catch(() => ""),
      run("ssh", [...SSH_OPTIONS, "pve", "qm", "list"]).catch(() => ""),
      run("ssh", [...SSH_OPTIONS, "pve", "pct", "list"]).catch(() => "")
    ]);
    return discoverHosts(sshConfig, qmList, pctList);
  }
  if (command === "collect" && alias === PUBLIC_INSTALLER) return collectPublicInstaller();
  if (command === "collect" && alias) {
    const label = flags.find((flag) => flag.startsWith("--label="))?.slice(8) ?? alias;
    const reach = alias === "local" ? "LOCAL" : alias === "pve" ? "PVE_SHELL" : alias.startsWith("qm:") ? "QM_GUEST_EXEC" : alias.startsWith("pct:") ? "PCT_EXEC" : "SSH";
    const family = flags.find((flag) => flag.startsWith("--family="))?.slice(9);
    if (family === "WINDOWS") return parseWindowsProbe(await windowsProbe(alias), { alias, label, reach });
    if (family === "MACOS") {
      if (reach !== "SSH") throw new Error("macOS hosts are reached over SSH only.");
      return parseMacProbe(await run("ssh", [...SSH_OPTIONS, alias, "sh", "-s"], { input: MAC_PROBE, timeoutMs: 600_000 }), { alias, label, reach });
    }
    const { inventory, dropped } = parseProbe(await probe(alias, flags.includes("--refresh")), { alias, label, reach });
    if (alias === "local") inventory.libraries = await spaceLibraries();
    return { inventory, dropped };
  }
  if (command === "scan-images" && alias && flags.length) return scanImages(alias, flags);
  throw new Error("usage: space-security-inventory.mjs discover | collect <alias> [--refresh] [--label=<text>] | scan-images <alias> <sha256:id>...");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`), (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
