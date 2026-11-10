import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, expect, it } from "vitest";
import { signSessionWithTtl } from "../src/auth.js";

const secret = "synthetic-t3-static-session-secret-only";
const prefix = "/api/t3code/assets/";
const token = (id = "user:operator") => signSessionWithTtl({ id, role: "ADMIN", email: `${randomUUID()}@space.test` }, secret, 600);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const script = Buffer.from(`export const value = "${"t3code ".repeat(400)}";\n`);
const font = Buffer.from([0x77, 0x4f, 0x46, 0x32, ...new Array(2048).fill(7)]);
const model = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(4096, 1)]);

async function fixture(enabled = true) {
  const module = await import("../src/t3code/static-assets.js").catch(() => ({} as Record<string, any>));
  expect(typeof module.registerT3StaticAssets, "Shared T3 client assets are missing").toBe("function");
  const dir = await mkdtemp(join(tmpdir(), "t3-static-test-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "current", "dist", "client", "assets");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "main-AbC123_x.js"), script);
  await writeFile(join(root, "font-Zz9.woff2"), font);
  await writeFile(join(root, "iphone-duo-Cu4Xx1NH.glb"), model);
  await writeFile(join(dir, "secret.js"), "never served");
  const app = Fastify(); await app.register(cookie);
  await module.registerT3StaticAssets(app, { enabled, sessionSecret: secret, root });
  await app.ready(); cleanup.push(() => app.close());
  return { app, headers: { cookie: `space_session=${token()}` } };
}

it("serves the pane-independent client bundle only to the Space owner session", async () => {
  const f = await fixture();
  const url = prefix + "main-AbC123_x.js";
  expect((await f.app.inject({ url })).statusCode).toBe(401);
  expect((await f.app.inject({ url, headers: { cookie: `space_session=${token("user:foreign")}` } })).statusCode).toBe(403);
  expect((await f.app.inject({ url, headers: { ...f.headers, "sec-fetch-site": "cross-site" } })).statusCode).toBe(403);
  const disabled = await fixture(false);
  const off = await disabled.app.inject({ url, headers: disabled.headers });
  expect(off.statusCode).toBe(404); expect(off.json().error.code).toBe("T3CODE_DISABLED");
});

it("lets the browser keep hashed modules across panes and reloads", async () => {
  const f = await fixture();
  const result = await f.app.inject({ url: prefix + "main-AbC123_x.js", headers: f.headers });
  expect(result.statusCode).toBe(200);
  expect(result.rawPayload).toEqual(script);
  expect(result.headers["content-type"]).toBe("text/javascript; charset=utf-8");
  expect(result.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
  expect(result.headers["x-content-type-options"]).toBe("nosniff");
  expect(result.headers.vary).toMatch(/accept-encoding/i);
  // Module workers take their policy from their own script response.
  expect(result.headers["content-security-policy"]).toContain("connect-src 'self'");
  const etag = String(result.headers.etag);
  expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
  const again = await f.app.inject({ url: prefix + "main-AbC123_x.js", headers: { ...f.headers, "if-none-match": etag } });
  expect(again.statusCode).toBe(304); expect(again.rawPayload.length).toBe(0);
});

it("compresses text assets with brotli or gzip and leaves compressed formats alone", async () => {
  const f = await fixture();
  const url = prefix + "main-AbC123_x.js";
  const br = await f.app.inject({ url, headers: { ...f.headers, "accept-encoding": "gzip, deflate, br, zstd" } });
  expect(br.headers["content-encoding"]).toBe("br");
  expect(Number(br.headers["content-length"])).toBe(br.rawPayload.length);
  expect(br.rawPayload.length).toBeLessThan(script.length / 4);
  expect(brotliDecompressSync(br.rawPayload)).toEqual(script);
  const gz = await f.app.inject({ url, headers: { ...f.headers, "accept-encoding": "gzip" } });
  expect(gz.headers["content-encoding"]).toBe("gzip"); expect(gunzipSync(gz.rawPayload)).toEqual(script);
  const refused = await f.app.inject({ url, headers: { ...f.headers, "accept-encoding": "br;q=0, gzip;q=0" } });
  expect(refused.headers["content-encoding"]).toBeUndefined(); expect(refused.rawPayload).toEqual(script);
  const woff = await f.app.inject({ url: prefix + "font-Zz9.woff2", headers: { ...f.headers, "accept-encoding": "br, gzip" } });
  expect(woff.headers["content-type"]).toBe("font/woff2");
  expect(woff.headers["content-encoding"]).toBeUndefined(); expect(woff.rawPayload).toEqual(font);
  // The preview's device-frame models (binary glTF) load through the shared path.
  const glb = await f.app.inject({ url: prefix + "iphone-duo-Cu4Xx1NH.glb", headers: { ...f.headers, "accept-encoding": "gzip" } });
  expect(glb.statusCode).toBe(200); expect(glb.headers["content-type"]).toBe("model/gltf-binary");
  expect(gunzipSync(glb.rawPayload)).toEqual(model);
  const head = await f.app.inject({ method: "HEAD", url, headers: { ...f.headers, "accept-encoding": "br" } });
  expect(head.statusCode).toBe(200); expect(head.headers["content-encoding"]).toBe("br"); expect(head.rawPayload.length).toBe(0);
});

it("serves only flat runtime asset names and never files outside the runtime assets", async () => {
  const f = await fixture();
  for (const name of ["..%2Fsecret.js", "..%2F..%2F..%2F..%2Fsecret.js", "%2E%2E%2Fsecret.js", ".hidden.js", "main-AbC123_x.exe", "main-AbC123_x.js%00.css", "sub%2Fmain.js", "missing-Qq1.js"]) {
    const result = await f.app.inject({ url: prefix + name, headers: f.headers });
    expect(result.statusCode, name).toBe(404);
    expect(result.headers["cache-control"], name).toBe("no-store");
    expect(result.body, name).not.toContain("never served");
  }
  expect((await f.app.inject({ url: prefix + "nested/main-AbC123_x.js", headers: f.headers })).statusCode).toBe(404);
  expect((await f.app.inject({ method: "POST", url: prefix + "main-AbC123_x.js", headers: f.headers })).statusCode).toBe(404);
});

it("lists the startup files of the installed runtime from its own build manifest", async () => {
  const module = await import("../src/t3code/static-assets.js");
  const dir = await mkdtemp(join(tmpdir(), "t3-startup-test-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "dist", "client", "assets");
  await mkdir(root, { recursive: true }); await mkdir(join(dir, "dist", "client", ".vite"));
  await writeFile(join(dir, "dist", "client", ".vite", "manifest.json"), JSON.stringify({
    "index.html": { file: "assets/index-A1.js", isEntry: true, imports: ["_boot-B2.js"] },
    "_boot-B2.js": { file: "assets/boot-B2.js", dynamicImports: ["_app-C3.js"] },
    "_app-C3.js": { file: "assets/app-C3.js", imports: ["_runtime-D4.js", "_boot-B2.js"], css: ["assets/app-E5.css"], dynamicImports: ["_settings-F6.js"] },
    "_runtime-D4.js": { file: "assets/runtime-D4.js" },
    "_settings-F6.js": { file: "assets/settings-F6.js" },
    "src/routes/_chat.tsx?tsr-split=component": { file: "assets/_chat-G7.js", imports: ["_app-C3.js"] },
    "src/routes/settings.tsx?tsr-split=component": { file: "assets/settings-H8.js" },
    "evil": { file: "assets/../../secret.js" },
  }));
  expect(await module.t3StartupAssets(root)).toEqual({ entry: ["index-A1.js", "boot-B2.js"], app: ["app-C3.js", "runtime-D4.js", "_chat-G7.js"], styles: ["app-E5.css"] });
  const app = Fastify(); await app.register(cookie);
  await module.registerT3StaticAssets(app, { enabled: true, sessionSecret: secret, root });
  cleanup.push(() => app.close());
  expect((await app.inject({ url: "/api/t3code/startup-assets" })).statusCode).toBe(401);
  const listed = await app.inject({ url: "/api/t3code/startup-assets", headers: { cookie: `space_session=${token()}` } });
  expect(listed.headers["cache-control"]).toBe("no-store");
  expect(listed.json()).toEqual({ version: 1, basePath: "/api/t3code/assets/", files: ["index-A1.js", "boot-B2.js", "app-C3.js", "runtime-D4.js", "_chat-G7.js", "app-E5.css"] });
});
