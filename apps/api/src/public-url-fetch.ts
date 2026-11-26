// Server-side fetch of a user-supplied URL (link previews, Live fetch-url): public destinations only, on every redirect hop.
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const refused = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) refused.addSubnet(network, prefix, "ipv4");
// IPv4-mapped addresses are checked against the IPv4 rules by BlockList itself; NAT64, 6to4 and Teredo embed IPv4 targets.
for (const [network, prefix] of [["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) refused.addSubnet(network, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  return version !== 0 && !refused.check(address, version === 4 ? "ipv4" : "ipv6");
}

const refusedHostnames = /^(?:localhost|.*\.localhost|metadata|metadata\.google\.internal|instance-data)$/;

export class PublicUrlRefusedError extends Error {
  readonly code = "URL_NOT_ALLOWED";
}

/** A site that keeps redirecting (in a circle, or past maxRedirects): each hop's URL, status and whether it set a cookie (none is sent back). */
export class PublicUrlRedirectError extends PublicUrlRefusedError {
  readonly loop: boolean;
  constructor(readonly chain: Array<{ url: string; status: number; setCookie: boolean }>, readonly next: string) {
    const loop = chain.some((hop) => hop.url === next);
    super(`${loop ? "Redirect loop" : "Too many redirects"}: ${chain.map((hop) => `${hop.url} (${hop.status}${hop.setCookie ? ", sets a cookie" : ""})`).join(" → ")} → ${next}.`);
    this.loop = loop;
  }
}

export interface PublicUrlResponse { url: string; status: number; ok: boolean; headers: IncomingHttpHeaders; text: string; /** The bytes as received (a PDF's text is read from them); optional so text-only stand-ins still fit. */ body?: Buffer }

type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface PublicUrlFetchOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  maxBytes?: number;
  maxRedirects?: number;
  resolver?: Resolver;
  /** Tests only: which resolved addresses may be connected to. */
  allowAddress?: (address: string) => boolean;
}

async function publicTarget(url: URL, resolver: Resolver, allowAddress: (address: string) => boolean) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new PublicUrlRefusedError("Only HTTP and HTTPS URLs are supported.");
  if (url.username || url.password) throw new PublicUrlRefusedError("URLs with credentials are not fetched.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (refusedHostnames.test(hostname)) throw new PublicUrlRefusedError("This address is not fetched.");
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await resolver(hostname);
  if (!addresses.length || addresses.some(entry => !allowAddress(entry.address))) throw new PublicUrlRefusedError("Private and local addresses are not fetched.");
  return addresses[0]!;
}

/** GET a URL whose every hop resolves only to public addresses; the connection is pinned to the checked address. */
export async function fetchPublicUrl(input: string, options: PublicUrlFetchOptions): Promise<PublicUrlResponse> {
  const resolver = options.resolver ?? (hostname => lookup(hostname, { all: true }));
  const allowAddress = options.allowAddress ?? isPublicAddress;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const signal = AbortSignal.timeout(options.timeoutMs);
  let url: URL;
  try { url = new URL(input); } catch { throw new PublicUrlRefusedError("Invalid URL."); }
  const chain: Array<{ url: string; status: number; setCookie: boolean }> = [];
  for (let hop = 0; ; hop += 1) {
    const target = await publicTarget(url, resolver, allowAddress);
    const response = await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: "GET", signal, headers: options.headers, family: target.family,
        lookup: (_hostname, lookupOptions, callback) => (lookupOptions as { all?: boolean }).all
          ? (callback as unknown as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [target])
          : callback(null, target.address, target.family)
      }, incoming => {
        const status = incoming.statusCode ?? 0;
        if (status >= 300 && status < 400 && incoming.headers.location) {
          incoming.resume();
          return resolve({ status, headers: incoming.headers, body: Buffer.alloc(0) });
        }
        // 16/11 00:17Z (space_web_read "https://platform.minimax.io/ is binary"): some servers gzip whatever the request asked; maxBytes counts decoded bytes.
        const encoding = String(incoming.headers["content-encoding"] ?? "").trim().toLowerCase();
        const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
          : encoding === "br" ? createBrotliDecompress() : null;
        const source = decoder ? incoming.pipe(decoder) : incoming;
        const chunks: Buffer[] = [];
        let size = 0;
        source.on("data", (chunk: Buffer) => {
          // shortcut: a page larger than maxBytes is cut, not refused; previews read only its head.
          if (size + chunk.length >= maxBytes) { chunks.push(chunk.subarray(0, maxBytes - size)); size = maxBytes; incoming.destroy(); decoder?.destroy(); finish(); return; }
          chunks.push(chunk); size += chunk.length;
        });
        let done = false;
        const finish = () => { if (!done) { done = true; resolve({ status, headers: incoming.headers, body: Buffer.concat(chunks) }); } };
        source.on("end", finish);
        incoming.on("error", error => done ? undefined : reject(error));
        decoder?.on("error", error => done ? undefined : reject(error));
      });
      request.on("error", reject);
      request.end();
    });
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      chain.push({ url: url.toString(), status: response.status, setCookie: Boolean(response.headers["set-cookie"]) });
      url = new URL(response.headers.location, url);
      // 16/11 05:19Z (nousapp.dev, net_check and web_read "Too many redirects."): the chain is the finding; a repeated URL is a loop at once.
      if (chain.some((entry) => entry.url === url.toString()) || hop >= (options.maxRedirects ?? 5)) throw new PublicUrlRedirectError(chain, url.toString());
      continue;
    }
    return { url: url.toString(), status: response.status, ok: response.status >= 200 && response.status < 300, headers: response.headers, text: response.body.toString("utf8"), body: response.body };
  }
}
