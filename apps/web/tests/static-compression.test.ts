/* @vitest-environment node */

import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants, gunzipSync, gzipSync } from "node:zlib";

const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
const compressionScriptPath = fileURLToPath(new URL("../scripts/compress-dist-assets.mjs", import.meta.url));
const cleanupPaths: string[] = [];
const cleanupProcesses: Array<ReturnType<typeof import("node:child_process").spawn>> = [];
let serverSequence = 0;

afterEach(async () => {
  for (const child of cleanupProcesses.splice(0)) child.kill("SIGTERM");
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function createDist() {
  const dist = await mkdtemp(path.join(os.tmpdir(), "space-static-compression-"));
  cleanupPaths.push(dist);
  await mkdir(path.join(dist, "assets"));
  await writeFile(path.join(dist, "index.html"), "<!doctype html><title>Space test</title>");
  return dist;
}

function request(port: number, pathname: string, acceptEncoding: string, extraHeaders: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const outgoing = http.request(
      { host: "127.0.0.1", port, path: pathname, headers: { "accept-encoding": acceptEncoding, ...extraHeaders } },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks) }));
      }
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function startServer(dist: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const { spawn } = await import("node:child_process");
  const port = 20_000 + ((process.pid + serverSequence) % 20_000);
  serverSequence += 1;
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...extraEnv, SPACE_WEB_HOST: "127.0.0.1", SPACE_WEB_PORT: String(port), SPACE_WEB_DIST: dist },
    stdio: ["ignore", "pipe", "pipe"]
  });
  cleanupProcesses.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Space test web server did not start.")), 5_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Space test web server exited with ${code}.`));
    });
    child.stdout?.on("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return port;
}

function runCompressionScript(dist: string) {
  return new Promise<{ sourceFiles: number; rawBytes: number; brotliBytes: number; gzipBytes: number }>((resolve, reject) => {
    execFile(process.execPath, [compressionScriptPath], { env: { ...process.env, SPACE_WEB_DIST: dist } }, (error, stdout) => {
      if (error) reject(error);
      else resolve(JSON.parse(String(stdout).trim().split("\n").at(-1) ?? "{}"));
    });
  });
}

describe("Space static asset compression", () => {
  it("generates Brotli and gzip variants only for compressible assets", async () => {
    const dist = await createDist();
    const javascript = "export const space = 'vibe';\n".repeat(200);
    await writeFile(path.join(dist, "assets", "app.js"), javascript);
    await writeFile(path.join(dist, "assets", "image.png"), Buffer.alloc(2_048, 7));

    await runCompressionScript(dist);

    expect(brotliDecompressSync(await readFile(path.join(dist, "assets", "app.js.br"))).toString()).toBe(javascript);
    expect(gunzipSync(await readFile(path.join(dist, "assets", "app.js.gz"))).toString()).toBe(javascript);
    await expect(readFile(path.join(dist, "assets", "image.png.br"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses maximum Brotli quality and reports exact totals when compressing files in parallel", async () => {
    const dist = await createDist();
    const sources = Array.from({ length: 12 }, (_, index) => `export const chunk${index} = ${JSON.stringify("space ".repeat(400 + index * 37))};\n`);
    await Promise.all(sources.map((source, index) => writeFile(path.join(dist, "assets", `chunk-${index}.js`), source)));

    const summary = await runCompressionScript(dist);

    const brotliSizes = await Promise.all(sources.map(async (_, index) => (await readFile(path.join(dist, "assets", `chunk-${index}.js.br`))).byteLength));
    const gzipSizes = await Promise.all(sources.map(async (_, index) => (await readFile(path.join(dist, "assets", `chunk-${index}.js.gz`))).byteLength));
    expect(summary.sourceFiles).toBe(sources.length);
    expect(summary.brotliBytes).toBe(brotliSizes.reduce((total, size) => total + size, 0));
    expect(summary.gzipBytes).toBe(gzipSizes.reduce((total, size) => total + size, 0));
    const expected = brotliCompressSync(sources[0]!, {
      params: {
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(sources[0]!)
      }
    });
    expect((await readFile(path.join(dist, "assets", "chunk-0.js.br"))).equals(expected)).toBe(true);
  });

  it("serves Brotli first and preserves the original content type", async () => {
    const dist = await createDist();
    const javascript = "console.log('space');\n".repeat(200);
    const rawPath = path.join(dist, "assets", "app.js");
    await writeFile(rawPath, javascript);
    await writeFile(`${rawPath}.br`, brotliCompressSync(javascript));
    await writeFile(`${rawPath}.gz`, gzipSync(javascript));
    const port = await startServer(dist);

    const response = await request(port, "/assets/app.js", "gzip, br");

    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("br");
    expect(response.headers.vary).toContain("Accept-Encoding");
    expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(brotliDecompressSync(response.body).toString()).toBe(javascript);
  });

  it("serves existing assets with immutable cache headers", async () => {
    const dist = await createDist();
    const javascript = "console.log('space current asset');\n";
    await writeFile(path.join(dist, "assets", "app.js"), javascript);
    const port = await startServer(dist);

    const response = await request(port, "/assets/app.js", "identity");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(response.body.toString()).toBe(javascript);
  });

  it("returns 404 no-store for missing hashed assets instead of the SPA document", async () => {
    const dist = await createDist();
    const port = await startServer(dist);

    const response = await request(port, "/assets/old-hash.js", "identity");

    expect(response.status).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.body.toString()).not.toContain("<!doctype html>");
    expect(JSON.parse(response.body.toString())).toMatchObject({
      error: { code: "ASSET_NOT_FOUND" }
    });
  });

  it("keeps falling back to the SPA document for operator routes", async () => {
    const dist = await createDist();
    const port = await startServer(dist);

    const response = await request(port, "/rooms/YJO4bWKZifL4", "identity");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-cache, no-store, must-revalidate");
    expect(response.headers.etag).toBeUndefined();
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.body.toString()).toBe("<!doctype html><title>Space test</title>");
  });

  it("falls back to gzip and leaves already-compressed media unchanged", async () => {
    const dist = await createDist();
    const javascript = "console.log('space');\n".repeat(200);
    const rawPath = path.join(dist, "assets", "app.js");
    await writeFile(rawPath, javascript);
    await writeFile(`${rawPath}.gz`, gzipSync(javascript));
    await writeFile(path.join(dist, "assets", "image.png"), Buffer.alloc(2_048, 7));
    const port = await startServer(dist);

    const gzipResponse = await request(port, "/assets/app.js", "gzip");
    const imageResponse = await request(port, "/assets/image.png", "br, gzip");

    expect(gzipResponse.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gzipResponse.body).toString()).toBe(javascript);
    expect(imageResponse.headers["content-encoding"]).toBeUndefined();
    expect(imageResponse.body).toHaveLength(2_048);
  });

  it("hardens the public homepage document without changing the operator document policy", async () => {
    const dist = await createDist();
    const port = await startServer(dist);

    const operatorRoot = await request(port, "/", "identity");
    const homepageAlias = await request(port, "/homepage", "identity");
    const demoWorkspace = await request(port, "/demo-workspace", "identity");
    const legacyAppAlias = await request(port, "/app", "identity");

    expect(operatorRoot.status).toBe(200);
    expect(operatorRoot.headers["content-security-policy"]).toBe("frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
    expect(operatorRoot.headers["x-frame-options"]).toBe("SAMEORIGIN");
    // The script policy is report-only until its reports are clean (security addendum step 7).
    expect(operatorRoot.headers["content-security-policy-report-only"]).toBe("script-src 'self' https://www.youtube.com; object-src 'none'; base-uri 'self'; report-uri /csp-report");
    expect(operatorRoot.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    const report = await new Promise<number>((resolve, reject) => {
      const sent = http.request({ host: "127.0.0.1", port, path: "/csp-report", method: "POST", headers: { "content-type": "application/csp-report" } },
        (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      sent.on("error", reject);
      sent.end(JSON.stringify({ "csp-report": { "violated-directive": "script-src", "blocked-uri": "https://evil.example/x.js?token=1" } }));
    });
    expect(report).toBe(204);
    expect(homepageAlias.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(homepageAlias.headers["content-security-policy"]).toContain("frame-src 'self'");
    expect(homepageAlias.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(homepageAlias.headers["content-security-policy"]).toContain("coderadio-admin-v2.freecodecamp.org");
    expect(homepageAlias.headers["x-frame-options"]).toBe("DENY");
    expect(homepageAlias.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(homepageAlias.headers["permissions-policy"]).toContain("camera=()");
    expect(demoWorkspace.headers["content-security-policy"]).toContain("connect-src 'none'");
    expect(demoWorkspace.headers["content-security-policy"]).toContain("frame-src 'none'");
    expect(demoWorkspace.headers["content-security-policy"]).toContain("media-src 'none'");
    expect(demoWorkspace.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(demoWorkspace.headers["permissions-policy"]).toContain("camera=()");
    expect(demoWorkspace.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(legacyAppAlias.status).toBe(308);
    expect(legacyAppAlias.headers.location).toBe("/");
  });

  it("caches non-hashed static files for a day with a weak validator and 304 revalidation", async () => {
    const dist = await createDist();
    await mkdir(path.join(dist, "brand"));
    const gif = Buffer.from("GIF89a-space-test-background");
    await writeFile(path.join(dist, "brand", "background.gif"), gif);
    await writeFile(path.join(dist, "entry-loading.css"), ".entry-loading{display:grid}");
    const port = await startServer(dist);

    const first = await request(port, "/brand/background.gif", "identity");
    const css = await request(port, "/entry-loading.css", "identity");

    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toBe("image/gif");
    expect(first.headers["cache-control"]).toBe("public, max-age=86400, stale-while-revalidate=604800");
    expect(first.headers.etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(first.body.equals(gif)).toBe(true);
    expect(css.headers["cache-control"]).toBe("public, max-age=86400, stale-while-revalidate=604800");
    expect(css.headers.etag).toMatch(/^W\//);

    const revalidated = await request(port, "/brand/background.gif", "identity", { "if-none-match": first.headers.etag });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.etag).toBe(first.headers.etag);
    expect(revalidated.headers["cache-control"]).toBe("public, max-age=86400, stale-while-revalidate=604800");
    expect(revalidated.body).toHaveLength(0);

    const strongForm = String(first.headers.etag).replace(/^W\//, "");
    const listed = await request(port, "/brand/background.gif", "identity", { "if-none-match": `"other", ${strongForm}` });
    expect(listed.status).toBe(304);

    const changed = await request(port, "/brand/background.gif", "identity", { "if-none-match": 'W/"0-0"' });
    expect(changed.status).toBe(200);
    expect(changed.body.equals(gif)).toBe(true);
  });

  it("uses distinct validators for compressed variants of cacheable static files", async () => {
    const dist = await createDist();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${"<g/>".repeat(400)}</svg>`;
    await writeFile(path.join(dist, "favicon.svg"), svg);
    await writeFile(path.join(dist, "favicon.svg.br"), brotliCompressSync(svg));
    const port = await startServer(dist);

    const identity = await request(port, "/favicon.svg", "identity");
    const brotli = await request(port, "/favicon.svg", "br");

    expect(identity.headers["content-type"]).toBe("image/svg+xml");
    expect(brotli.headers["content-encoding"]).toBe("br");
    expect(brotli.headers.etag).toMatch(/-br"$/);
    expect(brotli.headers.etag).not.toBe(identity.headers.etag);
    const crossVariant = await request(port, "/favicon.svg", "br", { "if-none-match": identity.headers.etag });
    expect(crossVariant.status).toBe(200);
    expect(brotliDecompressSync(crossVariant.body).toString()).toBe(svg);
  });

  it("revalidates non-hashed scripts on every use and keeps documents and hashed assets unchanged", async () => {
    const dist = await createDist();
    await writeFile(path.join(dist, "mock-loader.js"), "console.log('mock loader');\n");
    await writeFile(path.join(dist, "proof.html"), "<!doctype html><title>Proof</title>");
    await writeFile(path.join(dist, "assets", "app-abc123.js"), "console.log('hashed');\n");
    const port = await startServer(dist);

    const script = await request(port, "/mock-loader.js", "identity");
    const document = await request(port, "/proof.html", "identity");
    const hashed = await request(port, "/assets/app-abc123.js", "identity", { "if-none-match": "*" });

    expect(script.headers["cache-control"]).toBe("no-cache");
    expect(script.headers.etag).toMatch(/^W\//);
    const scriptRevalidated = await request(port, "/mock-loader.js", "identity", { "if-none-match": script.headers.etag });
    expect(scriptRevalidated.status).toBe(304);
    expect(document.headers["cache-control"]).toBe("no-cache, no-store, must-revalidate");
    expect(document.headers.etag).toBeUndefined();
    expect(hashed.status).toBe(200);
    expect(hashed.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(hashed.headers.etag).toBeUndefined();
  });

  it("serves media and font types with explicit content types", async () => {
    const dist = await createDist();
    await mkdir(path.join(dist, "media"));
    const expectedTypes: Record<string, string> = {
      "clip.mp4": "video/mp4",
      "clip.webm": "video/webm",
      "font.woff2": "font/woff2",
      "photo.avif": "image/avif",
      "photo.jpeg": "image/jpeg",
      "photo.jpg": "image/jpeg",
      "sound.mp3": "audio/mpeg"
    };
    for (const name of Object.keys(expectedTypes)) await writeFile(path.join(dist, "media", name), Buffer.alloc(32, 1));
    const port = await startServer(dist);

    for (const [name, contentType] of Object.entries(expectedTypes)) {
      const response = await request(port, `/media/${name}`, "identity");
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe(contentType);
      expect(response.headers["cache-control"]).toBe("public, max-age=86400, stale-while-revalidate=604800");
    }
  });

  it("serves a no-store runtime config with only a validated Discord invite", async () => {
    const dist = await createDist();
    const port = await startServer(dist, { SPACE_PUBLIC_DISCORD_URL: "https://discord.gg/space-demo" });

    const response = await request(port, "/homepage-config.js", "identity");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.toString()).toBe(
      'window.__SPACE_PUBLIC_CONFIG__={"discordUrl":"https://discord.gg/space-demo","contactEmail":null};\n'
    );
  });

  it("adds only a plain contact address for the public legal pages", async () => {
    const dist = await createDist();
    const valid = await startServer(dist, { SPACE_PUBLIC_CONTACT_EMAIL: " owner@example.com " });
    expect((await request(valid, "/homepage-config.js", "identity")).body.toString()).toContain('"contactEmail":"owner@example.com"');
    const unsafe = await startServer(dist, { SPACE_PUBLIC_CONTACT_EMAIL: "owner@example.com\"><script>" });
    expect((await request(unsafe, "/homepage-config.js", "identity")).body.toString()).toContain('"contactEmail":null');
  });
});
