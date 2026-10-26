import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

// HTTPS reads of ghcr.io for the install-time image check (image-attestations.mjs). Node's fetch takes no proxy without
// the undici package, and this launcher has no dependencies, so one GET is node:https, through an HTTP CONNECT tunnel
// when a proxy applies: HTTPS_PROXY / https_proxy and NO_PROXY / no_proxy win, else the Docker client's
// proxies.default.httpsProxy / noProxy (~/.docker/config.json or $DOCKER_CONFIG), the proxy `docker pull` itself uses.

/** A read that could not reach the registry (network, proxy, timeout, 5xx), as opposed to a verification failure. */
export class RegistryUnreachableError extends Error {}

function dockerClientProxy(env) {
  try {
    const config = JSON.parse(readFileSync(join(env.DOCKER_CONFIG || join(homedir(), ".docker"), "config.json"), "utf8"));
    const proxy = config?.proxies?.default ?? {};
    return { httpsProxy: typeof proxy.httpsProxy === "string" ? proxy.httpsProxy : "", noProxy: typeof proxy.noProxy === "string" ? proxy.noProxy : "" };
  } catch {
    return { httpsProxy: "", noProxy: "" };
  }
}

/** True when a NO_PROXY list (comma or space separated: `*`, `host`, `.domain`, `*.domain`, `host:port`) covers host:443. */
export function noProxyCovers(list, host) {
  return String(list ?? "").split(/[\s,]+/).filter(Boolean).some((raw) => {
    if (raw === "*") return true;
    const [entryHost, entryPort] = raw.toLowerCase().replace(/^\*?\./, "").split(":");
    if (entryPort && entryPort !== "443") return false;
    return host === entryHost || host.endsWith(`.${entryHost}`);
  });
}

/** The proxy URL for an https URL, or null: the environment wins, the Docker client config is the fallback. */
export function registryProxy(url, { env = process.env, dockerConfig = () => dockerClientProxy(env) } = {}) {
  const value = (...names) => names.map((name) => env[name]).find((entry) => typeof entry === "string" && entry.trim() !== "")?.trim();
  const fromEnv = value("HTTPS_PROXY", "https_proxy");
  const docker = fromEnv ? null : dockerConfig();
  const proxy = fromEnv ?? (docker.httpsProxy.trim() || null);
  if (!proxy) return null;
  const noProxy = value("NO_PROXY", "no_proxy") ?? docker?.noProxy ?? "";
  return noProxyCovers(noProxy, new URL(url).hostname.toLowerCase()) ? null : proxy;
}

function tunnel(proxy, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(proxy.includes("://") ? proxy : `http://${proxy}`);
    const auth = target.username ? { "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`).toString("base64")}` } : {};
    const request = (target.protocol === "https:" ? https : http).request({
      host: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: "CONNECT", path: `${host}:443`, headers: { host: `${host}:443`, ...auth }, timeout: timeoutMs
    });
    request.on("connect", (response, socket) => {
      if (response.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new RegistryUnreachableError(`the proxy ${target.host} answered ${response.statusCode} to CONNECT ${host}`));
      }
    });
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", (error) => reject(new RegistryUnreachableError(`the proxy ${target.host} failed: ${error.message}`)));
    request.end();
  });
}

/** One GET of an https URL: `{ status, location, body }`, the body capped at maxBytes. */
export async function httpsGet(url, { headers = {}, maxBytes, timeoutMs = 30_000, env = process.env, proxyFor = registryProxy } = {}) {
  const target = new URL(url);
  const proxy = proxyFor(url, { env });
  const socket = proxy ? await tunnel(proxy, target.hostname, timeoutMs) : null;
  return new Promise((resolve, reject) => {
    const request = https.get(target, {
      // Without an agent the default port would be 80 and the Host header ghcr.io:443, which GitHub answers with 404.
      headers: { host: target.host, ...headers }, timeout: timeoutMs,
      // No agent: ClientRequest then takes its socket from createConnection (an agent would open its own).
      ...(socket ? { createConnection: () => tls.connect({ socket, servername: target.hostname }) } : {})
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (maxBytes && size > maxBytes) request.destroy(new Error(`${url} is larger than ${maxBytes} bytes`));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode, location: response.headers.location, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new RegistryUnreachableError(`${target.hostname} timed out${proxy ? " through the proxy" : ""}`)));
    request.on("error", (error) => reject(error instanceof RegistryUnreachableError || /larger than/.test(error.message) ? error
      : new RegistryUnreachableError(`${target.hostname}${proxy ? " through the proxy" : ""}: ${error.message}`)));
  });
}
