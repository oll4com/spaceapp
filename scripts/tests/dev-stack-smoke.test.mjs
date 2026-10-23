import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";
import { assertReady, observeTerminal } from "../dev-stack-smoke.mjs";

test("readiness cannot pass with disabled workflows or an unavailable CLI host", () => {
  assert.throws(() => assertReady({ ok: true, dependencies: { worker: "disabled", cliHost: "RUNNING" } }), /worker/);
  assert.throws(() => assertReady({ ok: true, dependencies: { worker: "RUNNING", cliHost: "UNAVAILABLE" } }), /CLI host/);
  assert.throws(() => assertReady({ ok: false, dependencies: { worker: "RUNNING", cliHost: "RUNNING" } }), /ready/);
});

async function terminal(frames, operation) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(resolve => server.once("listening", resolve));
  server.on("connection", (socket, request) => {
    assert.equal(request.headers.cookie, "space_session=synthetic");
    for (const frame of frames) socket.send(JSON.stringify(frame));
  });
  try {
    return await operation(`ws://127.0.0.1:${server.address().port}`);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
}

const ready = { type: "ready", paneId: "pane:smoke", sessionId: "session:smoke", runtimeId: "cli:opencode" };
const options = { cookie: "space_session=synthetic", paneId: ready.paneId, sessionId: ready.sessionId, timeoutMs: 100 };

test("terminal acceptance requires matching identity, RUNNING and real stdout", async () => {
  await terminal([ready, { type: "status", status: "RUNNING" }, { type: "output", stream: "stdout", data: "OpenCode" }], async url => {
    const observed = await observeTerminal(url, options);
    assert.equal(observed.stdoutBytes, 8);
    observed.socket.terminate();
  });
});

test("an allocated or silent terminal is not a running UI", async () => {
  for (const frames of [[ready], [ready, { type: "status", status: "RUNNING" }]]) {
    await terminal(frames, url => assert.rejects(observeTerminal(url, options), /did not become ready/));
  }
});

test("another session's output and terminal errors fail the proof", async () => {
  await terminal([{ ...ready, sessionId: "session:other" }], url =>
    assert.rejects(observeTerminal(url, options), /identity/));
  await terminal([{ type: "error", code: "CLI_TERMINAL_ATTACH_FAILED", message: "synthetic" }], url =>
    assert.rejects(observeTerminal(url, options), /terminal error/));
});
