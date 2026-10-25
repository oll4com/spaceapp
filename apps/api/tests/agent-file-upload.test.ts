import { afterEach, beforeEach, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { withStagedAgentFiles } from "../src/agent-file-upload.js";

let root: string;
let app: FastifyInstance;
let persisted: string[];
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "space-agent-upload-"));
  persisted = [];
  app = Fastify();
  await app.register(multipart, { throwFileSizeLimit: false, limits: { fileSize: 8 } });
  app.post("/upload", async (request) => withStagedAgentFiles(request, root, async (files, bytes) => {
    for (const file of files) persisted.push(await readFile(file.sourcePath, "utf8"));
    return { count: files.length, bytes };
  }));
});
afterEach(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });

function payload(contents: string[], closed = true) {
  return contents.map((body, i) => `--b\r\nContent-Disposition: form-data; name="file"; filename="${i}.txt"\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`).join("") + (closed ? "--b--\r\n" : "");
}
async function upload(contents: string[], closed = true) {
  return app.inject({ method: "POST", url: "/upload", headers: { "content-type": "multipart/form-data; boundary=b" }, payload: payload(contents, closed) });
}

it("passes only complete staged files to persistence and cleans staging", async () => {
  const result = await upload(["first", "second"]);
  expect(result.statusCode).toBe(200);
  expect(result.json()).toEqual({ count: 2, bytes: 11 });
  expect(persisted).toEqual(["first", "second"]);
  expect(await readdir(root)).toEqual([]);
});

it("rejects truncation before persisting any earlier file", async () => {
  const result = await upload(["first", "0123456789"]);
  expect(result.statusCode).toBe(413);
  expect(persisted).toEqual([]);
  expect(await readdir(root)).toEqual([]);
});

it("rejects an excessive count and removes every staged file", async () => {
  const result = await upload(Array.from({ length: 9 }, () => "file"));
  expect(result.statusCode).toBe(422);
  expect(persisted).toEqual([]);
  expect(await readdir(root)).toEqual([]);
});

it("rejects empty and malformed uploads with no residual staging", async () => {
  expect((await upload([""])).statusCode).toBe(422);
  expect((await upload(["partial"], false)).statusCode).toBeGreaterThanOrEqual(400);
  expect(persisted).toEqual([]);
  expect(await readdir(root)).toEqual([]);
});
