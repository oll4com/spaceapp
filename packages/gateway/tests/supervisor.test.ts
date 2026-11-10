import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const supervisorSource = join(import.meta.dirname, "..", "src", "supervisor.ts");
const workerSource = (marker: string) => `
import http from "node:http";
import { appendFileSync } from "node:fs";
const server = http.createServer((request, response) => {
  if (request.url === "/slow") { setTimeout(() => response.end("slow-done:" + process.pid), 700); return; }
  response.end("${marker}:" + process.pid);
});
server.listen(Number(process.env.TEST_PORT), "127.0.0.1");
process.on("message", (message) => {
  if (message?.type !== "space-gateway:drain") return;
  appendFileSync(process.env.TEST_LOG, "drain " + message.reason + " ${marker}\\n");
  server.close(() => process.exit(0));
});
`;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); });
  });
}

const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill("SIGKILL"); });

async function until<T>(read: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => null);
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("gateway supervisor", () => {
  it("hands over to a new worker without refusing requests, keeps the old one on a failed start, and stops cleanly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-supervisor-"));
    const workerFile = join(directory, "worker.mjs");
    const logFile = join(directory, "log.txt");
    writeFileSync(logFile, "");
    writeFileSync(workerFile, workerSource("v1"));
    const runner = join(directory, "runner.mts");
    writeFileSync(runner, `import { startSupervisor } from ${JSON.stringify(supervisorSource)};\nstartSupervisor({ workerFile: ${JSON.stringify(workerFile)}, startTimeoutMs: 5000, restartDelayMs: 100, log: (line) => console.log(line) });\n`);
    const port = await freePort();
    const child = spawn(process.execPath, [runner], { env: { ...process.env, TEST_PORT: String(port), TEST_LOG: logFile }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const get = async (path = "/") => (await fetch(`http://127.0.0.1:${port}${path}`)).text();

    const first = await until(async () => { const body = await get(); return body.startsWith("v1:") ? body : null; });

    // A slow request is in flight on the old worker while the new one takes over.
    const slow = get("/slow");
    writeFileSync(workerFile, workerSource("v2"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill("SIGHUP");
    const second = await until(async () => { const body = await get(); return body.startsWith("v2:") ? body : null; });
    expect(second).not.toBe(first);
    expect(await slow).toBe(`slow-done:${first.split(":")[1]}`);
    await until(async () => (readFileSync(logFile, "utf8").includes("drain reload v1") ? true : null));

    // A worker that cannot start is dropped; v2 keeps answering.
    writeFileSync(workerFile, "process.exit(3);\n");
    child.kill("SIGHUP");
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await get()).toBe(second);

    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(readFileSync(logFile, "utf8")).toContain("drain stop v2");
  }, 30_000);

  it("stays up and starts another worker when the running one exits on its own (2026-10-28)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-supervisor-"));
    const workerFile = join(directory, "worker.mjs");
    const logFile = join(directory, "log.txt");
    writeFileSync(logFile, "");
    // The 2026-10-28 worker died on an unhandled database error: here "/crash" ends it the same way.
    writeFileSync(workerFile, `${workerSource("v1")}\nserver.on("request", (request) => { if (request.url === "/crash") setTimeout(() => process.exit(1), 20); });\n`);
    const runner = join(directory, "runner.mts");
    writeFileSync(runner, `import { startSupervisor } from ${JSON.stringify(supervisorSource)};\nstartSupervisor({ workerFile: ${JSON.stringify(workerFile)}, restartDelayMs: 100, log: (line) => console.log(line) });\n`);
    const port = await freePort();
    const child = spawn(process.execPath, [runner], { env: { ...process.env, TEST_PORT: String(port), TEST_LOG: logFile }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let exitCode: number | null | undefined;
    child.once("exit", (code) => { exitCode = code; });
    const get = async (path = "/") => (await fetch(`http://127.0.0.1:${port}${path}`)).text();

    const first = await until(async () => { const body = await get(); return body.startsWith("v1:") ? body : null; });
    for (let crash = 0; crash < 2; crash += 1) {
      const before = await get();
      await get("/crash");
      await until(async () => { const body = await get(); return body.startsWith("v1:") && body !== before ? body : null; });
    }
    expect(exitCode).toBeUndefined();
    expect(await get()).not.toBe(first);
  }, 30_000);

  it("holds the credential key a worker unwrapped and hands it to the next worker over IPC, so a reload needs no KMS", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-supervisor-"));
    const workerFile = join(directory, "worker.mjs");
    const logFile = join(directory, "log.txt");
    writeFileSync(logFile, "");
    writeFileSync(workerFile, `import { heldCredentialKey, holdCredentialKey } from ${JSON.stringify(supervisorSource)};
${workerSource("k")}
const held = await heldCredentialKey(2000);
if (!held) holdCredentialKey("dW53cmFwcGVk");
appendFileSync(process.env.TEST_LOG, "key " + (held ?? "kms") + "\\n");
`);
    const runner = join(directory, "runner.mts");
    writeFileSync(runner, `import { startSupervisor } from ${JSON.stringify(supervisorSource)};\nstartSupervisor({ workerFile: ${JSON.stringify(workerFile)}, startTimeoutMs: 5000, restartDelayMs: 100, log: () => {} });\n`);
    const port = await freePort();
    const child = spawn(process.execPath, [runner], { env: { ...process.env, TEST_PORT: String(port), TEST_LOG: logFile }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    await until(async () => (readFileSync(logFile, "utf8").includes("key kms") ? true : null));
    child.kill("SIGHUP");
    await until(async () => (readFileSync(logFile, "utf8").includes("key dW53cmFwcGVk") ? true : null));
    expect(readFileSync(logFile, "utf8").match(/key kms/g)).toHaveLength(1);
  }, 30_000);
});

