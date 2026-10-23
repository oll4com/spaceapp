import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { hostProtocolProbe, parseSmokeOptions } from "../container-service-smoke.mjs";

const exec = promisify(execFile);

async function withProtocolServer(t, reply, run) {
  const directory = await mkdtemp(join(tmpdir(), "spaceapp-probe-"));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\spaceapp-smoke-${randomUUID()}`
    : join(directory, "host.sock");
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    let received = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 4 || received.length < received.readUInt32BE(0) + 4) return;
      const request = JSON.parse(received.subarray(4).toString());
      assert.equal(request.kind, "request");
      assert.equal(request.method, "ping");
      assert.deepEqual(request.params, {});
      reply(socket, request);
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
  await run(() => exec(process.execPath, ["--input-type=module", "-e",
    `await (${hostProtocolProbe.toString()})(${JSON.stringify(socketPath)}, "ping");`
  ], { timeout: 20_000, windowsHide: true }));
}

function responseFrame(request, result) {
  const payload = Buffer.from(JSON.stringify({ kind: "response", requestId: request.requestId, ok: true, result }));
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32BE(payload.length);
  payload.copy(frame, 4);
  return frame;
}

test("smoke requires an explicit supported target and architecture before touching Docker", () => {
  for (const args of [[], ["--target", "core"], ["--target", "core", "--image", "example:core", "--arch", "x64"],
    ["--target", "unknown", "--image", "example:core", "--arch", "amd64"],
    ["--target", "cli", "--image", "-unexpected-option", "--arch", "amd64"]]) {
    assert.throws(() => parseSmokeOptions(args), /Usage/);
  }
});

test("socket smoke completes a length-prefixed ping even across split frames", async (t) => {
  await withProtocolServer(t, (socket, request) => {
    const frame = responseFrame(request, { ok: true, hostPid: 42, startedAt: new Date().toISOString() });
    socket.write(frame.subarray(0, 2));
    setTimeout(() => socket.write(frame.subarray(2)), 10);
  }, async (probe) => {
    const output = await probe();
    assert.equal(JSON.parse(output.stdout).hostPid, 42);
  });
});

test("a socket that accepts then closes is not a passing host smoke", async (t) => {
  await withProtocolServer(t, (socket) => socket.end(), async (probe) => {
    await assert.rejects(probe, /Host closed before responding/);
  });
});

test("an invalid length-prefixed protocol reply fails the smoke", async (t) => {
  await withProtocolServer(t, (socket) => socket.end(Buffer.alloc(4)), async (probe) => {
    await assert.rejects(probe, /Invalid host protocol frame/);
  });
});

test("a well-framed response from an unhealthy host fails the smoke", async (t) => {
  await withProtocolServer(t, (socket, request) => {
    socket.write(responseFrame(request, { ok: false, hostPid: 42, startedAt: new Date().toISOString() }));
  }, async (probe) => {
    await assert.rejects(probe, /false !== true/);
  });
});
