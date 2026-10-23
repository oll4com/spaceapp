import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createServer as createViteServer } from "vite";
import WebSocket, { WebSocketServer } from "ws";
import { setTimeout as delay } from "node:timers/promises";
import { Processes, startWeb } from "../dev-stack/processes.mjs";

test("the source web server proxies readiness and a real terminal WebSocket to the selected API", async () => {
  const api = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, path: request.url }));
  });
  const sockets = new WebSocketServer({ server: api });
  sockets.on("connection", socket => socket.on("message", data => socket.send(data.toString())));
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  const previous = process.env.SPACE_API_ORIGIN;
  process.env.SPACE_API_ORIGIN = `http://127.0.0.1:${api.address().port}`;
  let web;
  let terminal;
  try {
    web = await createViteServer({
      root: new URL("../../apps/web", import.meta.url).pathname,
      configFile: new URL("../../apps/web/vite.config.ts", import.meta.url).pathname,
      server: { host: "127.0.0.1", port: 0, watch: null }, logLevel: "error"
    });
    await web.listen();
    const origin = `http://127.0.0.1:${web.httpServer.address().port}`;
    assert.deepEqual(await (await fetch(`${origin}/readyz`)).json(), { ok: true, path: "/readyz" });
    terminal = new WebSocket(`${origin.replace("http:", "ws:")}/api/panes/test/cli/terminal`);
    await once(terminal, "open", { signal: AbortSignal.timeout(10_000) });
    const received = once(terminal, "message", { signal: AbortSignal.timeout(10_000) });
    terminal.send("terminal transport");
    assert.equal((await received)[0].toString(), "terminal transport");
  } finally {
    terminal?.terminate();
    for (const socket of sockets.clients) socket.terminate();
    await web?.close();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => api.close(resolve));
    if (previous === undefined) delete process.env.SPACE_API_ORIGIN;
    else process.env.SPACE_API_ORIGIN = previous;
  }
});

test("the launcher starts the hoisted Vite binary with apps/web as its working directory", async () => {
  const api = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, path: request.url }));
  });
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const lines = [];
  const processes = new Processes({ output: line => lines.push(line) });
  try {
    startWeb(processes, new URL("../../", import.meta.url).pathname, {
      ...process.env, SPACE_WEB_HOST: "127.0.0.1", SPACE_WEB_PORT: String(port),
      SPACE_API_ORIGIN: `http://127.0.0.1:${api.address().port}`
    });
    const deadline = Date.now() + 15_000;
    let result;
    while (Date.now() < deadline) {
      processes.abort.signal.throwIfAborted();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { result = await response.json(); break; }
      } catch { /* Vite is still starting. */ }
      await delay(100);
    }
    assert.deepEqual(result, { ok: true, path: "/readyz" }, lines.join("\n"));
  } finally {
    await processes.stop();
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
  }
});
