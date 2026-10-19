// Provider HTTP transport and destination policy: a leaf module, so the adapters and git credentials do not import providers.ts (ARCH-004).
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { GitControlError } from "./errors.js";

export type ProviderRequest = (url: URL, token: string, method: string, body?: unknown, scheme?: "Bearer" | "token") => Promise<unknown>;
export interface ProviderResponse { data: unknown; headers: Record<string, string> }
export type ProviderExchange = (url: URL, authorization: string, method: string, body?: unknown) => Promise<ProviderResponse>;

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number); const a = parts[0]!, b = parts[1]!;
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224;
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return privateAddress(normalized.slice(7));
  // Only global unicast IPv6 is eligible without an explicit installation rule.
  return !/^[23][0-9a-f]{3}:/.test(normalized);
}
export class ProviderUrlPolicy {
  constructor(private readonly allowedPrivateOrigins: string[] = []) {}
  normalize(input: string): string {
    let url: URL; try { url = new URL(input); } catch { throw new GitControlError("INVALID_SERVER", "Enter a valid provider server URL."); }
    if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw new GitControlError("INVALID_SERVER", "Server URL must not contain credentials or query parameters.");
    if (url.protocol !== "https:" && !this.allowedPrivateOrigins.includes(url.origin)) throw new GitControlError("INVALID_SERVER", "HTTP providers require an explicit installation allowlist.");
    return url.toString().replace(/\/+$/, "");
  }
  async address(url: URL): Promise<{ address: string; family: number }> {
    this.normalize(url.origin);
    const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
    if (!addresses.length || addresses.some(a => privateAddress(a.address)) && !this.allowedPrivateOrigins.includes(url.origin)) throw new GitControlError("INVALID_SERVER", "Private provider destinations require an explicit installation allowlist.");
    return addresses[0]!;
  }
  request: ProviderRequest = async (url, token, method, body, scheme = "Bearer") =>
    (await this.exchange(url, `${scheme} ${token}`, method, body)).data;
  exchange: ProviderExchange = async (url, authorization, method, body) => {
    const address = await this.address(url);
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        // DNS is already validated and pinned to one address; do not request an address list.
        method, family: address.family, lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        headers: { authorization, accept: "application/json", "user-agent": "Space-Source-Control", ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) }
      }, response => {
        let text = "";
        response.on("data", (part: Buffer) => { text += part.toString("utf8"); if (Buffer.byteLength(text) > 4 * 1024 * 1024) request.destroy(new Error("limit")); });
        response.on("end", () => {
          const code = response.statusCode ?? 500;
          if (code >= 300 && code < 400) return reject(new GitControlError("REDIRECT_BLOCKED", "Provider redirects are not allowed.", 502));
          if (code === 401) return reject(new GitControlError("INVALID_TOKEN", "Token is invalid or expired.", 401));
          if (code === 403) return reject(new GitControlError("INSUFFICIENT_PERMISSION", "Token lacks the required repository permission.", 403));
          if (code === 404) return reject(new GitControlError("REPOSITORY_NOT_FOUND", "Repository is unavailable to this account.", 404));
          if (code === 409 || code === 422) return reject(new GitControlError("REPOSITORY_COLLISION", "Repository name is unavailable or the create request was rejected.", 409));
          if (code === 429) return reject(new GitControlError("RATE_LIMITED", "Provider rate limit reached. Retry later.", 429));
          if (code === 408) return reject(new GitControlError("PROVIDER_UNAVAILABLE", "Provider request timed out.", 503));
          // Other 4xx answers are definite refusals (for example GitLab/Bitbucket report a taken name with 400).
          if (code >= 400 && code < 500) return reject(new GitControlError("PROVIDER_REJECTED", "Provider rejected the request. Check the repository name, target and permissions.", 400));
          if (code >= 400) return reject(new GitControlError("PROVIDER_FAILED", "Provider request failed. Check repository permissions and availability.", 502));
          try {
            const headers: Record<string, string> = {};
            for (const key of ["link", "x-next-page", "x-total-count", "x-ms-continuationtoken", "retry-after"]) {
              const value = response.headers[key]; if (typeof value === "string") headers[key] = value;
            }
            resolve({ data: JSON.parse(text), headers });
          } catch { reject(new GitControlError("PROVIDER_FAILED", "Provider returned an invalid response.", 502)); }
        });
      });
      request.setTimeout(15000, () => request.destroy());
      request.on("error", () => reject(new GitControlError("PROVIDER_UNAVAILABLE", "Provider is offline or could not be reached.", 503)));
      request.end(payload);
    });
  };
}
