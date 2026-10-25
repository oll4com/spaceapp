import { afterEach, beforeEach, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { mkdtemp, readFile, readdir, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { withStagedUploads, withStagedBufferUpload, withPersistedUpload } from "../src/multipart-upload.js";
import { acquireFileUpload, fileUploadLimits } from "../src/file-upload.js";

let root: string;
let app: FastifyInstance;
let committed: string[];
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "space-multipart-"));
  committed = [];
  app = Fastify();
  await app.register(multipart, { throwFileSizeLimit: false, limits: { fileSize: 100 } });
  app.post("/upload", async request => {
    const fields: Record<string, string> = {};
    return withStagedUploads(request, root, {
      maxFiles: 2, fileBytes: 8,
      onField: (name, value) => { fields[name] = String(value); }
    }, async files => {
      for (const file of files) {
        await withPersistedUpload(root, file, path.join(root, "files", file.filename), async () => {
          if (file.filename === "fail.txt") throw new Error("DB unavailable");
          committed.push(await readFile(path.join(root, "files", file.filename), "utf8"));
        });
      }
      return { fields, count: files.length };
    });
  });
});
afterEach(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });

function upload(files: Array<[string, string]>, closed = true) {
  const field = '--b\r\nContent-Disposition: form-data; name="model"\r\n\r\nfixture-model\r\n';
  const parts = files.map(([filename, body]) => `--b\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`).join("");
  return app.inject({ method: "POST", url: "/upload", headers: { "content-type": "multipart/form-data; boundary=b" }, payload: field + parts + (closed ? "--b--\r\n" : "") });
}

it("streams complete files, preserves multipart fields, and removes private staging", async () => {
  const response = await upload([["one.txt", "first"], ["two.txt", "second"]]);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ fields: { model: "fixture-model" }, count: 2 });
  expect(committed).toEqual(["first", "second"]);
  expect(await readdir(root)).toEqual(["files"]);
});

it("enforces the route byte limit before any persistence", async () => {
  const response = await upload([["one.txt", "first"], ["two.txt", "0123456789"]]);
  expect(response.statusCode).toBe(413);
  expect(committed).toEqual([]);
  expect(await readdir(root)).toEqual([]);
});

it("rejects excess files and malformed bodies without persisting the valid prefix", async () => {
  expect((await upload([["1", "one"], ["2", "two"], ["3", "three"]])).statusCode).toBe(422);
  expect((await upload([["1", "one"]], false)).statusCode).toBeGreaterThanOrEqual(400);
  expect(committed).toEqual([]);
  expect(await readdir(root)).toEqual([]);
});

it("rejects storage symlinks and leaves the target untouched", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "space-upload-outside-"));
  try {
    await symlink(outside, path.join(root, "files"));
    expect((await upload([["one.txt", "first"]])).statusCode).toBe(403);
    expect(await readdir(outside)).toEqual([]);
  } finally { await rm(outside, { recursive: true, force: true }); }
});

it("does not overwrite an existing file", async () => {
  await mkdir(path.join(root, "files"));
  await writeFile(path.join(root, "files", "one.txt"), "original");
  expect((await upload([["one.txt", "changed"]])).statusCode).toBeGreaterThanOrEqual(400);
  expect(await readFile(path.join(root, "files", "one.txt"), "utf8")).toBe("original");
});

it("removes unrecorded files when persistence fails", async () => {
  expect((await upload([["fail.txt", "first"]])).statusCode).toBe(500);
  expect(await readdir(path.join(root, "files"))).toEqual([]);
  expect(await readdir(root)).toEqual(["files"]);
});

it("shares admission between JSON Control and multipart uploads", async () => {
  const releases = Array.from({ length: fileUploadLimits.concurrent }, () => acquireFileUpload());
  try {
    await expect(withStagedBufferUpload(root, { buffer: Buffer.from("small"), filename: "note.txt", mimeType: "text/plain" }, async () => undefined))
      .rejects.toMatchObject({ code: "UPLOAD_BUSY", statusCode: 429 });
    expect(await readdir(root)).toEqual([]);
  } finally { releases.forEach(release => release()); }
});

it("bounds JSON Control upload bytes and cleans up rejected consumption", async () => {
  await expect(withStagedBufferUpload(root, { buffer: Buffer.alloc(1024 * 1024 + 1), filename: "big.txt", mimeType: "text/plain" }, async () => undefined))
    .rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE" });
  await expect(withStagedBufferUpload(root, { buffer: Buffer.from("small"), filename: "note.txt", mimeType: "text/plain" }, async () => { throw new Error("Consumer failed"); }))
    .rejects.toThrow("Consumer failed");
  expect(await readdir(root)).toEqual([]);
});
