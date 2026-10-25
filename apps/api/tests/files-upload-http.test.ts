import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest, type ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import type { FastifyInstance } from "fastify";
import { ownedSystemAnalytics } from "./owned-system-analytics.js";

const MiB = 1024 * 1024;
const chunk = Buffer.alloc(64 * 1024, 42);
const boundary = "space-owned-stream-boundary";
const requests = new Set<ClientRequest>();
let root: string;
let destination: string;
let origin: string;
let app: FastifyInstance;
let authHeaders: Record<string, string>;
let store: InMemorySpaceStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "space-upload-http-"));
  destination = join(root, "workspace");
  await mkdir(destination);
  vi.stubEnv("SPACE_WORKSPACE_ROOT", destination);
  vi.stubEnv("SPACE_VAR_DIR", join(root, "var"));
  const { createApp } = await import("../src/app.js");
  const { getApiConfig } = await import("../src/config.js");
  store = new InMemorySpaceStore();
  app = await createApp({
    store,
    config: getApiConfig({ SPACE_ARTIFACT_ROOT: join(root, "artifacts") }),
    systemAnalyticsService: ownedSystemAnalytics(store, root),
    auth: { sessionSecret: "owned-http-upload-fixture-secret", devLogin: true, secureCookies: false }
  });
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const login = await fetch(`${origin}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "space@space.local", password: "space-dev" })
  });
  expect(login.status).toBe(200);
  await login.arrayBuffer();
  const cookie = login.headers.getSetCookie().find(value => value.startsWith("space_session="))?.split(";")[0];
  expect(cookie).toBeTruthy();
  const csrf = await fetch(`${origin}/api/auth/csrf`, { headers: { cookie: cookie! } });
  expect(csrf.status).toBe(200);
  const { csrfToken } = await csrf.json() as { csrfToken: string };
  authHeaders = { cookie: cookie!, "x-space-csrf-token": csrfToken };
}, 30_000);

afterAll(async () => {
  for (const request of requests) request.destroy();
  try { await app?.close(); }
  finally {
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

function startUpload(filename: string, headers = authHeaders) {
  const request = httpRequest(`${origin}/api/files/upload`, {
    method: "POST", agent: false,
    headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` }
  });
  requests.add(request);
  request.once("close", () => requests.delete(request));
  request.setTimeout(15_000, () => request.destroy(new Error("Owned upload fixture timed out")));
  const response = new Promise<{ status: number; body: string }>(resolve => {
    request.once("error", () => resolve({ status: 0, body: "connection closed" }));
    request.once("response", reply => {
      let body = "";
      reply.setEncoding("utf8");
      reply.on("data", data => { body += data; });
      reply.once("end", () => resolve({ status: reply.statusCode!, body }));
      reply.once("error", () => resolve({ status: 0, body: "response interrupted" }));
    });
  });
  request.write(`--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\nadmin\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="targetDir"\r\n\r\n${destination}\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + "Content-Type: application/octet-stream\r\n\r\n");
  return {
    request, response,
    async write(bytes: number, sample = () => {}) {
      for (let sent = 0; sent < bytes; sent += chunk.length) {
        const value = chunk.subarray(0, Math.min(chunk.length, bytes - sent));
        await new Promise<void>((resolve, reject) => {
          request.write(value, error => error ? reject(error) : resolve());
        });
        sample();
      }
    },
    async finish() { request.end(`\r\n--${boundary}--\r\n`); return response; }
  };
}

it("enforces session and CSRF authentication before staging an HTTP upload", async () => {
  const anonymous = startUpload("anonymous.bin", {});
  expect((await anonymous.finish()).status).toBe(401);
  const missingCsrf = startUpload("csrf.bin", { cookie: authHeaders.cookie! });
  expect((await missingCsrf.finish()).status).toBe(403);
  expect(await readdir(destination)).toEqual([]);
});

it("bounds four streamed HTTP uploads, rejects a fifth, and reuses an aborted slot without publishing partial bytes", async () => {
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
  const uploads = Array.from({ length: 4 }, (_, i) => startUpload(`file-${i}.bin`));
  await Promise.all(uploads.map(upload => upload.write(MiB, sample)));
  await vi.waitFor(async () => {
    const names = await readdir(destination);
    expect(names).toHaveLength(4);
    expect(names.every(name => name.startsWith(".space-upload-"))).toBe(true);
    expect((await Promise.all(names.map(name => stat(join(destination, name))))).every(file => file.size > 0)).toBe(true);
  });

  const fifth = startUpload("rejected.bin");
  const rejected = await fifth.finish();
  expect(rejected.status).toBe(429);
  expect(JSON.parse(rejected.body)).toMatchObject({ error: { code: "UPLOAD_BUSY" } });

  uploads[0]!.request.destroy();
  await uploads[0]!.response;
  await vi.waitFor(async () => { expect(await readdir(destination)).toHaveLength(3); });
  const replacement = startUpload("replacement.bin");
  await replacement.write(MiB, sample);
  const completed = [...uploads.slice(1), replacement];
  const replies = await Promise.all(completed.map(async upload => {
    await upload.write(63 * MiB, sample);
    return upload.finish();
  }));
  sample();
  for (const reply of replies) {
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ ok: true, uploadedCount: 1 });
  }
  // Client and server share this process. This bound is half the 256 MiB body
  // total and includes both ends' transport/parser buffers, with no forced GC.
  expect(peakRss - initialRss).toBeLessThan(128 * MiB);
  const names = await readdir(destination);
  expect(names.sort()).toEqual(["file-1.bin", "file-2.bin", "file-3.bin", "replacement.bin"]);
  const expected = createHash("sha256");
  for (let i = 0; i < 64 * MiB / chunk.length; i++) expected.update(chunk);
  const expectedHash = expected.digest("hex");
  for (const name of names) {
    expect((await stat(join(destination, name))).size).toBe(64 * MiB);
    const actual = createHash("sha256");
    for await (const part of createReadStream(join(destination, name))) actual.update(part);
    expect(actual.digest("hex")).toBe(expectedHash);
    await rm(join(destination, name));
  }
  console.info(JSON.stringify({ proof: "owned HTTP uploads", concurrent: 4, completedBytes: 256 * MiB,
    peakRssGrowthBytes: peakRss - initialRss, rssGrowthLimitBytes: 128 * MiB }));
}, 30_000);

it("rejects a streamed HTTP file beyond 100 MiB and preserves the previous destination", async () => {
  await writeFile(join(destination, "existing.bin"), "original");
  const upload = startUpload("existing.bin");
  await upload.write(100 * MiB + 1);
  const reply = await upload.finish();
  expect(reply.status).toBe(413);
  expect(JSON.parse(reply.body)).toMatchObject({ error: { code: "UPLOAD_TOO_LARGE" } });
  expect(await readFile(join(destination, "existing.bin"), "utf8")).toBe("original");
  await vi.waitFor(async () => { expect(await readdir(destination)).toEqual(["existing.bin"]); });
}, 30_000);

it("reports which files were saved when a later file of the upload cannot be published, and audits them", async () => {
  // A non-empty directory where the second file should land makes its rename fail after the first succeeded.
  await mkdir(join(destination, "blocked", "inner"), { recursive: true });
  const body = [
    `--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\nadmin\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="targetDir"\r\n\r\n${destination}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="saved.txt"\r\nContent-Type: text/plain\r\n\r\nfirst\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blocked"\r\nContent-Type: text/plain\r\n\r\nsecond\r\n`,
    `--${boundary}--\r\n`
  ].join("");
  const response = await fetch(`${origin}/api/files/upload`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
    body
  });
  expect(response.status).toBe(500);
  const payload = await response.json() as { error: { code: string; message: string } };
  expect(payload.error.code).toBe("UPLOAD_PARTIALLY_SAVED");
  expect(payload.error.message).toContain("1 of 2 files were saved (saved.txt); blocked");
  expect(await readFile(join(destination, "saved.txt"), "utf8")).toBe("first");
  expect((await readdir(destination)).filter(name => name.startsWith(".space-upload-"))).toEqual([]);
  expect(store.listAuditEvents().some(event => event.action === "files.upload" && event.targetId?.endsWith("saved.txt"))).toBe(true);
});
