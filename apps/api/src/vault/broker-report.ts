import { execFile } from "../safe-child-process.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// What the operator sees before approving a Vault broker reinstall (Vault review 2026-10-22, plan clipboard:HIPO0ALNjfsP
// step 4): the commit the installed bundle was built from (its build banner), its SHA-256, and the diff stat of the bundle's
// sources between that commit and stable's HEAD, which the reinstall would build. Agents land code on main through the queue
// without anyone reviewing the broker's diff, so the card shows it. A bundle built before bundles carried their commit says
// "unknown" and shows the sources' newest commits instead.

export const VAULT_BROKER_BUNDLE_PATH = "/usr/local/libexec/space-vault/broker.mjs";
/** The bundle's sources: esbuild follows these imports; the dependencies (zod, @noble/curves) come from the lockfile. */
export const VAULT_BROKER_SOURCES = [
  "apps/api/src/vault-broker-main.ts", "apps/api/src/vault/broker-server.ts", "apps/api/src/vault/broker-client.ts", "apps/api/src/source-control/errors.ts",
  "packages/contracts/src/vault.ts", "packages/contracts/src/vault-crypto.ts", "packages/contracts/src/vault-password.ts", "packages/contracts/src/vault-fill.ts",
  "package-lock.json"
] as const;
/** The build banner (apps/api build:vault-broker, scripts/space-vault-broker-reinstall.mjs): the bundle's first line. */
export const VAULT_BROKER_BANNER = /^\/\/ space-vault-broker ([0-9a-f]{7,40}) built (\S+)/;

export interface VaultBrokerReportDeps { bundlePath?: string; repo?: string; sources?: readonly string[] }

/** Markdown for the decision card; never throws (what cannot be read is said). */
export async function vaultBrokerReport(deps: VaultBrokerReportDeps = {}): Promise<string> {
  const bundlePath = deps.bundlePath ?? VAULT_BROKER_BUNDLE_PATH;
  const repo = deps.repo ?? "/opt/spaceapp";
  const sources = deps.sources ?? VAULT_BROKER_SOURCES;
  let bundle: Buffer;
  try { bundle = await readFile(bundlePath); } catch { return `**Installed broker:** none at \`${bundlePath}\` (a first install).`; }
  const banner = VAULT_BROKER_BANNER.exec(bundle.subarray(0, 200).toString("utf8"));
  const sha256 = createHash("sha256").update(bundle).digest("hex");
  const lines = [`**Installed broker:** ${banner ? `commit \`${banner[1]}\` (built ${banner[2]})` : "unknown commit (built before bundles carried their commit)"}, SHA-256 \`${sha256}\`.`];
  const head = await git(repo, ["rev-parse", "--short=10", "HEAD"]).then((out) => out.trim(), () => null);
  if (!head) return [...lines, `Stable's checkout at \`${repo}\` could not be read.`].join("\n");
  if (banner) {
    const diff = await git(repo, ["diff", "--no-color", "--no-ext-diff", "--stat=120", `${banner[1]}..HEAD`, "--", ...sources]).catch((error: Error) => `(diff unavailable: ${error.message})`);
    lines.push(`**Changes in the broker's sources between it and stable's HEAD \`${head}\`:**`, "```", diff.trim() || "none: the reinstall would build the same sources", "```");
  } else {
    const log = await git(repo, ["log", "--no-color", "--format=%h %ad %s", "--date=short", "--max-count=5", "--", ...sources]).catch((error: Error) => `(log unavailable: ${error.message})`);
    lines.push(`**Newest changes to the broker's sources (stable's HEAD \`${head}\`):**`, "```", log.trim() || "none", "```");
  }
  return lines.join("\n");
}

function git(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["--no-pager", "--no-optional-locks", "-c", "safe.directory=*", "-C", repo, ...args],
      { timeout: 15_000, maxBuffer: 1_048_576, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim().split("\n")[0]?.slice(0, 200) ?? "git failed")) : resolve(stdout));
  });
}
