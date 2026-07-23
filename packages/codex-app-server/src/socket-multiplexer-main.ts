import {
  codexAppServerMultiplexerMaxBufferBytes,
  startCodexAppServerSocketMultiplexer,
  type CodexAppServerMultiplexerDiagnostic
} from "./socket-multiplexer.js";
import { rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

function readArg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} is required.`);
  return value;
}

const listenPath = readArg("--listen");
const upstreamPath = readArg("--upstream");
const readyFile = readArg("--ready-file");
const defaultsProjectionPath = readArg("--defaults-projection");
const runtimeKey = basename(dirname(listenPath));

function writeDiagnostic(event: CodexAppServerMultiplexerDiagnostic | Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ ...event, pid: process.pid, runtimeKey })}\n`);
}

rmSync(readyFile, { force: true });
const multiplexer = await startCodexAppServerSocketMultiplexer({
  listenPath,
  upstreamPath,
  defaultsProjectionPath,
  onDiagnostic: writeDiagnostic,
  onPrimaryInitialized: () => {
    writeFileSync(readyFile, `${JSON.stringify({ ready: true, pid: process.pid })}\n`, { mode: 0o600 });
  }
});
writeDiagnostic({
  schemaVersion: "CodexAppServerMultiplexerDiagnosticV1",
  observedAt: new Date().toISOString(),
  event: "codex_app_server_multiplexer_started",
  branch: "startup",
  maxBufferBytes: codexAppServerMultiplexerMaxBufferBytes
});
let closing = false;

async function close(exitCode: number): Promise<void> {
  if (closing) return;
  closing = true;
  await multiplexer.close();
  process.exit(exitCode);
}

process.once("SIGINT", () => void close(0));
process.once("SIGTERM", () => void close(0));
process.once("SIGHUP", () => void close(0));
process.once("uncaughtException", (error) => {
  console.error(error instanceof Error ? error.message : "Codex App Server multiplexer failed.");
  void close(1);
});
process.once("unhandledRejection", (error) => {
  console.error(error instanceof Error ? error.message : "Codex App Server multiplexer failed.");
  void close(1);
});
