import { readFile } from "node:fs/promises";

/**
 * LAN access to Space Gateway. The loopback listener serves this host and its CLI namespaces (their traffic is
 * forwarded to loopback). An optional second listener on a LAN address serves other internal machines: it admits
 * only sources inside the configured private ranges, and only the proxy routes. Admin, status and stats stay
 * loopback-only, and every proxy request still needs a gateway key.
 */
export interface Ipv4Cidr {
  text: string;
  network: number;
  mask: number;
}

export interface LanAccess {
  host: string;
  port: number;
  allowedSources: Ipv4Cidr[];
}

export const defaultLanPort = 4925;

/**
 * What LAN clients may call: health and the provider proxy routes that need a gateway key. `/antigravity` is not one:
 * it relays any Google sign-in without a key, so it stays on loopback (security addendum step 8).
 */
export const lanPathPrefixes = ["/health", "/v1", "/backend-api/codex", "/backend-api/transcribe", "/api/codex/weekly-remaining", "/pools"];

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value >>> 0;
}

export function parseCidr(text: string): Ipv4Cidr {
  const [address, bits = "32"] = text.trim().split("/");
  const ip = ipv4ToInt(address ?? "");
  const prefix = Number(bits);
  if (ip === null || !/^\d{1,2}$/.test(bits) || prefix > 32) throw new Error(`Not an IPv4 range: ${text}`);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { text: `${address}/${prefix}`, network: (ip & mask) >>> 0, mask };
}

/** The IPv4 form of a socket address (`::ffff:10.0.0.1` -> `10.0.0.1`), or null for IPv6 and missing addresses. */
export function plainIpv4(address: string | undefined): string | null {
  if (!address) return null;
  const plain = address.startsWith("::ffff:") ? address.slice(7) : address;
  return ipv4ToInt(plain) === null ? null : plain;
}

function contains(range: Ipv4Cidr, ip: number): boolean {
  return ((ip & range.mask) >>> 0) === range.network;
}

const privateRanges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].map(parseCidr);

/** Whether a whole range lies inside the private (RFC 1918) address space. */
export function isPrivateCidr(range: Ipv4Cidr): boolean {
  return privateRanges.some((outer) => range.mask >= outer.mask && contains(outer, range.network));
}

export function isLoopback(address: string | undefined): boolean {
  if (address === "::1") return true;
  const ip = plainIpv4(address);
  return ip !== null && ip.startsWith("127.");
}

export function sourceAllowed(address: string | undefined, ranges: Ipv4Cidr[]): boolean {
  const ip = plainIpv4(address);
  const value = ip === null ? null : ipv4ToInt(ip);
  return value !== null && ranges.some((range) => contains(range, value));
}

export function lanPathAllowed(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  return lanPathPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * How a request is admitted. Loopback serves this host and its CLI namespaces (forwarded to loopback); anything
 * else came in on the LAN listener and needs an allowed internal source and a proxy route. Requests injected in
 * tests have no local address and count as loopback.
 */
export function lanDecision(
  localAddress: string | undefined, remoteAddress: string | undefined, url: string, lan: LanAccess | null | undefined
): "allow" | "forbidden" | "not_found" {
  if (localAddress === undefined || isLoopback(localAddress)) return "allow";
  if (!lan || !sourceAllowed(remoteAddress, lan.allowedSources)) return "forbidden";
  return lanPathAllowed(url) ? "allow" : "not_found";
}

/** LAN access from the environment, or null when no LAN address is set. */
export function loadLanAccess(env: NodeJS.ProcessEnv): LanAccess | null {
  const host = env.SPACE_GATEWAY_LAN_HOST?.trim();
  if (!host) return null;
  const hostRange = plainIpv4(host) === null ? null : parseCidr(host);
  if (!hostRange || !isPrivateCidr(hostRange)) throw new Error("SPACE_GATEWAY_LAN_HOST must be a private IPv4 address.");
  const rawPort = env.SPACE_GATEWAY_LAN_PORT?.trim();
  const port = rawPort ? Number(rawPort) : defaultLanPort;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Gateway setting out of range: ${rawPort}`);
  const allowedSources = (env.SPACE_GATEWAY_LAN_ALLOWED_SOURCES ?? "").split(",").map((item) => item.trim()).filter(Boolean).map(parseCidr);
  if (allowedSources.length === 0) throw new Error("SPACE_GATEWAY_LAN_ALLOWED_SOURCES must list the internal ranges that may connect.");
  const outside = allowedSources.find((range) => !isPrivateCidr(range));
  if (outside) throw new Error(`SPACE_GATEWAY_LAN_ALLOWED_SOURCES may list only private ranges: ${outside.text}`);
  return { host, port, allowedSources };
}

/**
 * The environment with its LAN settings taken from the env file, read when a worker starts. The unit's environment
 * is fixed when the service starts, so reading the file lets `systemctl reload space-gateway` turn LAN access on,
 * change it or turn it off without dropping streams. An unreadable file leaves the environment as it is.
 */
export async function withLanEnvFile(env: NodeJS.ProcessEnv, file: string): Promise<NodeJS.ProcessEnv> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return env;
  }
  const merged: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("SPACE_GATEWAY_LAN_")));
  for (const line of text.split("\n")) {
    const match = /^\s*(SPACE_GATEWAY_LAN_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) merged[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return merged;
}

/**
 * LAN access chosen in the Space Gateway settings: OFF turns the listener off, ON uses the settings' address,
 * port and ranges under the same rules as the env file. ENV leaves the env file in charge (null here).
 */
export function lanAccessFromSettings(settings: { lanMode: "ENV" | "OFF" | "ON"; lanHost: string | null; lanPort: number | null; lanAllowedSources: string[] }):
  { lan: LanAccess | null; error: string | null } {
  if (settings.lanMode !== "ON") return { lan: null, error: null };
  if (!settings.lanHost?.trim()) return { lan: null, error: "Give the LAN address to listen on." };
  try {
    return { lan: loadLanAccess({ SPACE_GATEWAY_LAN_HOST: settings.lanHost ?? "", SPACE_GATEWAY_LAN_PORT: settings.lanPort ? String(settings.lanPort) : "",
      SPACE_GATEWAY_LAN_ALLOWED_SOURCES: settings.lanAllowedSources.join(",") }), error: null };
  } catch (error) {
    return { lan: null, error: error instanceof Error ? error.message.replace(/SPACE_GATEWAY_LAN_HOST/g, "The LAN address").replace(/SPACE_GATEWAY_LAN_ALLOWED_SOURCES/g, "The allowed ranges") : "Invalid LAN settings." };
  }
}
