import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { acquireFileUpload, stageFileUpload } from "../src/file-upload.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "space-upload-stream-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it("limits simultaneous uploads and releases a slot exactly once", () => {
  const release = Array.from({ length: 4 }, () => acquireFileUpload());
  try {
    expect(() => acquireFileUpload()).toThrow(/concurrent/);
    release[0]!();
    release[0]!();
    const replacement = acquireFileUpload();
    try { expect(() => acquireFileUpload()).toThrow(/concurrent/); }
    finally { replacement(); }
  } finally { release.forEach((done) => done()); }
});

it("enforces the hard byte limit while streaming and removes its partial file", async () => {
  const chunk = Buffer.alloc(64 * 1024, 1);
  const source = Readable.from((async function* () {
    for (let i = 0; i < 1601; i++) yield chunk;
  })());
  await expect(stageFileUpload({ directory, filename: "large.bin", source, budget: { bytes: 0 } }))
    .rejects.toMatchObject({ statusCode: 413 });
  expect(await readdir(directory)).toEqual([]);
});

it("bounds request bytes across files and supports abort cleanup", async () => {
  await expect(stageFileUpload({ directory, filename: "limit.bin", source: Readable.from([Buffer.alloc(2)]),
    budget: { bytes: 250 * 1024 * 1024 - 1 } })).rejects.toMatchObject({ statusCode: 413 });
  const abort = new AbortController();
  abort.abort();
  await expect(stageFileUpload({ directory, filename: "aborted.bin", source: Readable.from([Buffer.alloc(1)]),
    budget: { bytes: 0 }, signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(await readdir(directory)).toEqual([]);
});

it("does not expose a destination until commit, and streams a complete file with bounded memory", async () => {
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  const chunk = Buffer.alloc(64 * 1024, 42);
  const source = Readable.from((async function* () {
    for (let i = 0; i < 1536; i++) {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      yield chunk;
    }
  })());
  const staged = await stageFileUpload({ directory, filename: "complete.bin", source, budget: { bytes: 0 } });
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  try {
    await expect(stat(staged.destination)).rejects.toMatchObject({ code: "ENOENT" });
    await staged.commit();
    expect((await stat(staged.destination)).size).toBe(96 * 1024 * 1024);
    expect(peakRss - initialRss).toBeLessThan(64 * 1024 * 1024);
  } finally { await staged.cleanup(); }
  expect(await readdir(directory)).toEqual(["complete.bin"]);
});

it("does not leave data after a source error", async () => {
  const source = Readable.from((async function* () { yield Buffer.from("partial"); throw new Error("fixture disconnect"); })());
  await expect(stageFileUpload({ directory, filename: "failed.bin", source, budget: { bytes: 0 } })).rejects.toThrow("fixture disconnect");
  expect(await readdir(directory)).toEqual([]);
});
