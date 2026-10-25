#!/usr/bin/env node

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipBuffer = promisify(gzip);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(process.env.SPACE_WEB_DIST ?? path.join(scriptDir, "..", "dist"));
const minimumBytes = 1_024;
const compressibleExtensions = new Set([".css", ".html", ".js", ".json", ".map", ".svg", ".txt"]);
// Build-time only: maximum Brotli quality costs CPU once per build and saves
// bytes on every download. Files are compressed in parallel to keep it fast.
const brotliQuality = 11;
const concurrency = Math.max(1, Math.min(4, availableParallelism()));

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
    })
  );
  return files.flat();
}

async function writeVariant(filePath, suffix, compressed) {
  const outputPath = `${filePath}.${suffix}`;
  await writeFile(outputPath, compressed, { mode: 0o644 });
  return compressed.byteLength;
}

const files = await listFiles(distDir);
let sourceFiles = 0;
let rawBytes = 0;
let brotliBytes = 0;
let gzipBytes = 0;

async function compressFile(filePath) {
  if (!compressibleExtensions.has(path.extname(filePath))) return;
  const fileStats = await stat(filePath);
  if (fileStats.size < minimumBytes) return;
  const [brStat, gzStat] = await Promise.all([
    stat(`${filePath}.br`).catch(() => null),
    stat(`${filePath}.gz`).catch(() => null)
  ]);
  if (brStat && gzStat && brStat.mtimeMs >= fileStats.mtimeMs && gzStat.mtimeMs >= fileStats.mtimeMs) return;
  const source = await readFile(filePath);
  const [brotliOutput, gzipOutput] = await Promise.all([
    brotli(source, {
      params: {
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_QUALITY]: brotliQuality,
        [constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength
      }
    }),
    gzipBuffer(source, { level: 9 })
  ]);
  const [brotliSize, gzipSize] = await Promise.all([
    writeVariant(filePath, "br", brotliOutput),
    writeVariant(filePath, "gz", gzipOutput)
  ]);
  sourceFiles += 1;
  rawBytes += source.byteLength;
  brotliBytes += brotliSize;
  gzipBytes += gzipSize;
}

let nextFileIndex = 0;
async function compressQueue() {
  while (nextFileIndex < files.length) {
    const filePath = files[nextFileIndex];
    nextFileIndex += 1;
    await compressFile(filePath);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => compressQueue()));

console.log(JSON.stringify({ sourceFiles, rawBytes, brotliBytes, gzipBytes }));
