#!/usr/bin/env node
// Builds the all-months memory archive snapshot out of process so a long build never blocks the
// Space API event loop. Usage:
//   node archive-build-cli.js --memory-dir /opt/spaceapp/docs --index /opt/spaceapp/docs/gemini_history.md \
//     --root /opt/spaceapp/var/memory-graph [--filename snapshot-all-months.json] [--generated-at <iso>]
import { ALL_MONTHS_SNAPSHOT_FILENAME, buildMemoryGraphArchiveSnapshot } from "./archive-build.js";

function argumentValue(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}.`);
  return value;
}

async function main(): Promise<void> {
  const memoryDir = argumentValue("memory-dir");
  const indexPath = argumentValue("index");
  const rootDir = argumentValue("root");
  if (!memoryDir || !indexPath || !rootDir) {
    throw new Error("--memory-dir, --index and --root are required.");
  }
  const generatedAt = argumentValue("generated-at") ?? new Date().toISOString();
  const snapshot = await buildMemoryGraphArchiveSnapshot({
    memoryDir,
    indexPath,
    rootDir,
    generatedAt,
    filename: argumentValue("filename") ?? ALL_MONTHS_SNAPSHOT_FILENAME
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    generatedAt: snapshot.generatedAt,
    sourceHash: snapshot.sourceHash,
    summary: snapshot.summary
  })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Memory archive build failed."}\n`);
  process.exit(1);
});
