import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlib, gzip } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { authorizeT3Owner } from "./access.js";
import { T3_APP_CSP, T3_ASSET_EXTENSION, T3_IMMUTABLE_CACHE, T3_SHARED_ASSETS_PATH, T3GatewayError } from "./gateway-policy.js";

// The installed runtime's own client build (root-owned, verified by its
// manifest). Hashed file names make every response immutable.
export const T3_CLIENT_ASSETS_ROOT = "/opt/spaceapp/var/cli-versions/t3code/current/dist/client/assets";
export interface T3StaticAssetOptions { enabled: boolean; sessionSecret: string; root?: string; maxCacheBytes?: number }
type Encoding = "br" | "gzip" | "identity";
interface Variant { body: Buffer; etag: string }

const NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/;
const TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json; charset=utf-8", svg: "image/svg+xml",
  wasm: "application/wasm", woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf", png: "image/png", webp: "image/webp",
  gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg", mp3: "audio/mpeg", wav: "audio/wav", glb: "model/gltf-binary",
};
const COMPRESSIBLE = new Set(["js", "css", "json", "svg", "wasm", "ttf", "otf", "wav", "glb"]);
const brotli = promisify(brotliCompress), gzipAsync = promisify(gzip);

// Encode once per file and keep it: quality 6 costs tens of milliseconds for
// the largest chunk, off the event loop.
const encode = (body: Buffer, encoding: Exclude<Encoding, "identity">) => encoding === "br"
  ? brotli(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 6, [zlib.BROTLI_PARAM_SIZE_HINT]: body.length } })
  : gzipAsync(body, { level: 6 });

export function pickT3Encoding(header: string | undefined): Encoding {
  const weights = new Map<string, number>();
  for (const part of (header ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";").map(value => value.trim());
    if (!name) continue;
    const q = params.find(value => value.startsWith("q="));
    weights.set(name, q ? Number(q.slice(2)) || 0 : 1);
  }
  const accepts = (name: string) => (weights.get(name) ?? weights.get("*") ?? 0) > 0;
  return accepts("br") ? "br" : accepts("gzip") ? "gzip" : "identity";
}

// Bounded LRU of encoded files; concurrent requests for one file share a read.
class VariantCache {
  private readonly entries = new Map<string, Variant>();
  private readonly pending = new Map<string, Promise<Variant>>();
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}
  get(key: string, load: () => Promise<Variant>): Promise<Variant> {
    const hit = this.entries.get(key);
    if (hit) { this.entries.delete(key); this.entries.set(key, hit); return Promise.resolve(hit); }
    let pending = this.pending.get(key);
    if (!pending) {
      pending = load().then(variant => { this.store(key, variant); return variant; }).finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return pending;
  }
  private store(key: string, variant: Variant) {
    if (variant.body.length > this.maxBytes) return;
    this.entries.set(key, variant); this.bytes += variant.body.length;
    for (const [oldKey, old] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldKey); this.bytes -= old.body.length;
    }
  }
}

// The files a fresh pane needs before it can paint: the entry, the Space
// bootstrap, the app chunk set it imports, and the default chat routes. Read
// from the runtime's own Vite manifest, so a runtime switch changes the list.
const STARTUP_ROUTE = /^src\/routes\/_chat(?:\.index|\.draft\.\$draftId|\.\$environmentId\.\$threadId)?\.tsx\?tsr-split=component$/;
interface ManifestChunk { file: string; imports?: string[]; dynamicImports?: string[]; css?: string[] }
export interface T3StartupAssets { entry: string[]; app: string[]; styles: string[] }
let startupCache: { key: string; value: T3StartupAssets } | null = null;

export async function t3StartupAssets(root = T3_CLIENT_ASSETS_ROOT): Promise<T3StartupAssets> {
  const dir = await realpath(root), manifestPath = join(dir, "..", ".vite", "manifest.json");
  const key = `${dir}:${(await stat(manifestPath)).mtimeMs}`;
  if (startupCache?.key === key) return startupCache.value;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, ManifestChunk>;
  const name = (file: string) => file.replace(/^assets\//, "");
  const closure = (keys: string[], files: Set<string>, styles: Set<string>) => {
    const visit = (chunkKey: string) => {
      const chunk = manifest[chunkKey];
      if (!chunk || files.has(name(chunk.file))) return;
      files.add(name(chunk.file));
      for (const css of chunk.css ?? []) styles.add(name(css));
      for (const next of chunk.imports ?? []) visit(next);
    };
    keys.forEach(visit);
  };
  const entryFiles = new Set<string>(), entryStyles = new Set<string>();
  closure(["index.html"], entryFiles, entryStyles);
  const appFiles = new Set<string>(), styles = new Set<string>(entryStyles);
  const lazy = (manifest["index.html"]?.imports ?? []).flatMap(chunkKey => manifest[chunkKey]?.dynamicImports ?? []);
  closure([...lazy, ...Object.keys(manifest).filter(chunkKey => STARTUP_ROUTE.test(chunkKey))], appFiles, styles);
  for (const file of entryFiles) appFiles.delete(file);
  const valid = (files: Iterable<string>) => [...files].filter(file => NAME.test(file) && T3_ASSET_EXTENSION.test(file));
  const value = { entry: valid(entryFiles), app: valid(appFiles), styles: valid(styles) };
  startupCache = { key, value };
  return value;
}

export async function registerT3StaticAssets(app: FastifyInstance, options: T3StaticAssetOptions) {
  const root = options.root ?? T3_CLIENT_ASSETS_ROOT;
  const cache = new VariantCache(options.maxCacheBytes ?? 64 * 1024 * 1024);
  const variant = async (name: string, encoding: Encoding): Promise<Variant> => {
    // Resolve the runtime pointer per request so a runtime switch is served at once.
    const dir = await realpath(root);
    const raw = await cache.get(`${dir}/${name}`, async () => {
      const file = await realpath(join(dir, name));
      if (file !== join(dir, name)) throw new Error("T3 asset is not a plain runtime file");
      const body = await readFile(file);
      return { body, etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"` };
    });
    if (encoding === "identity") return raw;
    return cache.get(`${dir}/${name}:${encoding}`, async () => ({ body: await encode(raw.body, encoding), etag: `${raw.etag.slice(0, -1)}-${encoding}"` }));
  };

  // Lets the Space page warm the browser cache before a T3 pane is opened.
  app.get("/api/t3code/startup-assets", async (request, reply) => {
    try {
      authorizeT3Owner(request, options);
      if (request.headers["sec-fetch-site"] === "cross-site") throw new T3GatewayError(403, "T3_ORIGIN_INVALID");
      const assets = await t3StartupAssets(root).catch(() => { throw new T3GatewayError(404, "T3_NOT_FOUND"); });
      return reply.header("cache-control", "no-store").send({ version: 1, basePath: T3_SHARED_ASSETS_PATH,
        files: [...new Set([...assets.entry, ...assets.app, ...assets.styles])] });
    } catch (cause) {
      const error = cause instanceof T3GatewayError ? cause : new T3GatewayError(404, "T3_NOT_FOUND");
      return reply.code(error.status).header("cache-control", "no-store").send({ error: { code: error.code, message: "T3 Code assets are unavailable." } });
    }
  });

  app.route({ method: ["GET", "HEAD"], url: `${T3_SHARED_ASSETS_PATH}:name`, compress: false,
    handler: async (request, reply) => {
      try {
        authorizeT3Owner(request, options);
        if (request.headers["sec-fetch-site"] === "cross-site") throw new T3GatewayError(403, "T3_ORIGIN_INVALID");
        const name = (request.params as { name?: string }).name ?? "";
        if (!NAME.test(name) || !T3_ASSET_EXTENSION.test(name)) throw new T3GatewayError(404, "T3_NOT_FOUND");
        const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
        const compressible = COMPRESSIBLE.has(extension);
        const encoding = compressible ? pickT3Encoding(request.headers["accept-encoding"]) : "identity";
        const found = await variant(name, encoding).catch(() => { throw new T3GatewayError(404, "T3_NOT_FOUND"); });
        reply.header("cache-control", T3_IMMUTABLE_CACHE).header("content-type", TYPES[extension]!)
          .header("x-content-type-options", "nosniff").header("content-security-policy", T3_APP_CSP).header("etag", found.etag);
        if (compressible) reply.header("vary", "accept-encoding");
        if (encoding !== "identity") reply.header("content-encoding", encoding);
        if (String(request.headers["if-none-match"] ?? "").split(",").some(tag => tag.trim() === found.etag)) return reply.code(304).send();
        reply.header("content-length", found.body.length);
        return request.method === "HEAD" ? reply.send() : reply.send(found.body);
      } catch (cause) {
        const error = cause instanceof T3GatewayError ? cause : new T3GatewayError(404, "T3_NOT_FOUND");
        return reply.code(error.status).header("cache-control", "no-store").send({ error: { code: error.code, message: "T3 Code asset could not be loaded." } });
      }
    },
  });
}
