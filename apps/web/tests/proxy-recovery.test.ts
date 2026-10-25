/* @vitest-environment node */

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
const cleanupPaths: string[] = [];
const cleanupProcesses: ChildProcess[] = [];
const cleanupServers: Server[] = [];

afterEach(async () => {
  for (const child of cleanupProcesses.splice(0)) child.kill("SIGTERM");
  await Promise.all(cleanupServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function reservePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port.");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function createDist(): Promise<string> {
  const dist = await mkdtemp(path.join(os.tmpdir(), "space-proxy-recovery-"));
  cleanupPaths.push(dist);
  await writeFile(path.join(dist, "index.html"), "<!doctype html><title>Space proxy test</title>");
  return dist;
}

async function startWeb(apiPort: number, recoveryWindowMs: number): Promise<number> {
  const dist = await createDist();
  const webPort = await reservePort();
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      SPACE_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
      SPACE_API_RECOVERY_WINDOW_MS: String(recoveryWindowMs),
      SPACE_WEB_DIST: dist,
      SPACE_WEB_HOST: "127.0.0.1",
      SPACE_WEB_PORT: String(webPort)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  cleanupProcesses.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Space test web server did not start.")), 5_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Space test web server exited with ${code}.`));
    });
    child.stdout?.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return webPort;
}

async function startApi(port: number, handler: http.RequestListener): Promise<Server> {
  const server = http.createServer(handler);
  cleanupServers.push(server);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

function request(port: number, method = "GET", pathname = "/api/recovery") {
  const startedAt = Date.now();
  return new Promise<{ status: number; body: string; elapsedMs: number }>((resolve, reject) => {
    const outgoing = http.request({ host: "127.0.0.1", port, path: pathname, method }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => resolve({
        status: incoming.statusCode ?? 0,
        body: Buffer.concat(chunks).toString(),
        elapsedMs: Date.now() - startedAt
      }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("Space web API recovery proxy", () => {
  it("proxies the Harness root event stream instead of serving the Space SPA", async () => {
    const apiPort = await reservePort();
    let seenPath: string | undefined;
    await startApi(apiPort, (incoming, response) => {
      seenPath = incoming.url;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("event: ready\ndata: {}\n\n");
    });
    const webPort = await startWeb(apiPort, 1_000);

    const response = await request(webPort, "GET", "/plugins/events");

    expect(response.status).toBe(200);
    expect(response.body).toContain("event: ready");
    expect(seenPath).toBe("/plugins/events");
  });

  it("holds an initial GET until the API becomes ready and returns only the recovered 200", async () => {
    const apiPort = await reservePort();
    const webPort = await startWeb(apiPort, 1_000);
    const pending = request(webPort);

    await new Promise((resolve) => setTimeout(resolve, 120));
    await startApi(apiPort, (incoming, response) => {
      if (incoming.url?.startsWith("/readyz")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"recovered":true}');
    });

    const response = await pending;

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ recovered: true });
  });

  it("keeps holding while the API is up but not ready (strict readiness), then returns the recovered 200", async () => {
    const apiPort = await reservePort();
    const probes: string[] = [];
    await startApi(apiPort, (incoming, response) => {
      if (incoming.url?.startsWith("/readyz")) {
        probes.push(incoming.url);
        // The API answers strict probes with 503 until its dependencies are ready (health-routes.ts).
        response.writeHead(probes.length < 3 ? 503 : 200, { "content-type": "application/json" });
        response.end(probes.length < 3 ? '{"ok":false}' : '{"ok":true}');
        return;
      }
      if (probes.length < 3) {
        incoming.socket.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"recovered":true}');
    });
    const webPort = await startWeb(apiPort, 3_000);

    const response = await request(webPort);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ recovered: true });
    expect(probes.length).toBeGreaterThanOrEqual(3);
    expect(new Set(probes)).toEqual(new Set(["/readyz?strict=1"]));
  });

  it("returns the unchanged structured UPSTREAM_UNAVAILABLE contract after the deadline", async () => {
    const apiPort = await reservePort();
    const webPort = await startWeb(apiPort, 250);

    const response = await request(webPort);

    expect(response.elapsedMs).toBeGreaterThanOrEqual(200);
    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "Space API is not reachable from the web server.",
        requestId: "space-web"
      }
    });
  });

  it("never retries a mutation whose upstream connection closes before a response", async () => {
    const apiPort = await reservePort();
    let mutationAttempts = 0;
    let readinessProbes = 0;
    await startApi(apiPort, (incoming, response) => {
      if (incoming.url?.startsWith("/readyz")) {
        readinessProbes += 1;
        response.writeHead(200);
        response.end();
        return;
      }
      mutationAttempts += 1;
      incoming.socket.destroy();
    });
    const webPort = await startWeb(apiPort, 1_000);

    const response = await request(webPort, "POST");
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(response.status).toBe(502);
    expect(mutationAttempts).toBe(1);
    expect(readinessProbes).toBe(0);
  });

  it("shares one readiness probe flight across simultaneous safe requests", async () => {
    const apiPort = await reservePort();
    const webPort = await startWeb(apiPort, 1_000);
    const first = request(webPort);
    const second = request(webPort);

    await new Promise((resolve) => setTimeout(resolve, 120));
    let readinessProbes = 0;
    await startApi(apiPort, (incoming, response) => {
      if (incoming.url?.startsWith("/readyz")) {
        readinessProbes += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"recovered":true}');
    });

    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(readinessProbes).toBe(1);
  });
});
