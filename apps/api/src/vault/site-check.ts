import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";

// Which of the Vault's login sites still exist (operator request 2026-10-21: a Chrome export keeps logins of sites that are
// gone). Only origins the owner stored are checked; the API answers whether a site has a DNS name and answers HTTP, never
// anything a page says. Sites on a private network are not reachable from here and are reported LOCAL, not checked.

export type VaultSiteStatus = "OK" | "NO_DNS" | "UNREACHABLE" | "LOCAL";
export interface VaultSiteResult { origin: string; status: VaultSiteStatus; detail: string | null }
export interface VaultSiteCheckDeps {
  /** IPv4 and IPv6 addresses of a host; throws with a DNS error code (ENOTFOUND, ENODATA, ETIMEOUT, ...). */
  resolve(host: string, family: 4 | 6): Promise<string[]>;
  /** A HEAD request without redirects; resolves to the status code or throws with a network error code. */
  head(origin: string): Promise<number>;
}

const privateV4 = (ip: string) => /^(0|10|127)\./.test(ip) || /^169\.254\./.test(ip) || /^192\.168\./.test(ip)
  || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
const privateIp = (ip: string) => isIP(ip) === 4 ? privateV4(ip)
  : ip === "::1" || ip === "::" || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip) || (/^::ffff:/i.test(ip) && privateV4(ip.slice(7)));
const localName = (host: string) => host === "localhost" || /\.(local|lan|home|internal|localhost|intranet|corp)$/i.test(host) || !host.includes(".");
const errorCode = (error: unknown): string => {
  const value = error as { code?: unknown; cause?: { code?: unknown; name?: unknown }; name?: unknown };
  const code = value?.cause?.code ?? value?.code ?? (value?.name === "TimeoutError" || value?.cause?.name === "TimeoutError" ? "TIMEOUT" : value?.name);
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code.toUpperCase() : "ERROR";
};

const resolver = new Resolver({ timeout: 3_000, tries: 2 });
export const vaultSiteCheckNetwork: VaultSiteCheckDeps = {
  resolve: (host, family) => family === 4 ? resolver.resolve4(host) : resolver.resolve6(host),
  head: async (origin) => (await fetch(origin, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(6_000) })).status
};

export async function checkVaultSite(origin: string, deps: VaultSiteCheckDeps): Promise<VaultSiteResult> {
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) { if (privateIp(host)) return { origin, status: "LOCAL", detail: null }; }
  else {
    if (localName(host)) return { origin, status: "LOCAL", detail: null };
    const answers = await Promise.all(([4, 6] as const).map((family) => deps.resolve(host, family).then((addresses) => ({ addresses, code: null }), (error) => ({ addresses: [] as string[], code: errorCode(error) }))));
    const addresses = answers.flatMap((answer) => answer.addresses);
    if (!addresses.length) {
      // Only a definite "no such name" (or no address of either kind) is NO_DNS; a DNS timeout or failure is reported as it is.
      const definite = answers.every((answer) => answer.code === "ENOTFOUND" || answer.code === "ENODATA");
      return { origin, status: definite ? "NO_DNS" : "UNREACHABLE", detail: definite ? null : answers.find((answer) => answer.code)?.code ?? null };
    }
    if (addresses.every(privateIp)) return { origin, status: "LOCAL", detail: null };
  }
  try { return { origin, status: "OK", detail: String(await deps.head(origin)) }; } catch (error) { return { origin, status: "UNREACHABLE", detail: errorCode(error) }; }
}

/** Checks many sites at once (a bounded pool, so a few hundred take seconds, not minutes). */
export async function checkVaultSites(origins: string[], deps: VaultSiteCheckDeps = vaultSiteCheckNetwork, concurrency = 24): Promise<VaultSiteResult[]> {
  const results: VaultSiteResult[] = new Array(origins.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, origins.length) }, async () => {
    while (next < origins.length) { const index = next++; results[index] = await checkVaultSite(origins[index]!, deps); }
  }));
  return results;
}
