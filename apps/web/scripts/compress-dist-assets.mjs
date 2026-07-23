#!/usr/bin/env node

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
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

for (const filePath of files) {
  if (!compressibleExtensions.has(path.extname(filePath))) continue;
  const fileStats = await stat(filePath);
  if (fileStats.size < minimumBytes) continue;
  const source = await readFile(filePath);
  const [brotliOutput, gzipOutput] = await Promise.all([
    brotli(source, {
      params: {
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_QUALITY]: 9
      }
    }),
    gzipBuffer(source, { level: 9 })
  ]);
  sourceFiles += 1;
  rawBytes += source.byteLength;
  brotliBytes += await writeVariant(filePath, "br", brotliOutput);
  gzipBytes += await writeVariant(filePath, "gz", gzipOutput);
}

console.log(JSON.stringify({ sourceFiles, rawBytes, brotliBytes, gzipBytes }));
