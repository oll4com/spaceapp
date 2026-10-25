import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";

async function authenticatedCookie(app: Awaited<ReturnType<typeof createApp>>): Promise<string> {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "space@space.local", password: "space-dev" }
  });
  return login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

describe("API response compression", () => {
  it("negotiates gzip and Brotli for JSON responses above one KiB", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Compressed events", initialPaneCount: 0 }, "trace:compress");
    const pane = store.createPane(
      { roomId: room.id, title: "Compressed terminal", mode: "TERMINAL", cwd: "/etc" },
      "trace:compress-pane"
    );
    for (let index = 0; index < 20; index += 1) {
      store.updatePane(pane.id, { title: `Compressed terminal ${index} ${"x".repeat(100)}` }, `trace:compress-${index}`);
    }
    const app = await createApp({
      store,
      auth: {
        sessionSecret: "test-secret-with-enough-length",
        devLogin: true,
        secureCookies: false
      }
    });
    const cookie = await authenticatedCookie(app);

    const gzip = await app.inject({
      method: "GET",
      url: `/api/events?roomId=${encodeURIComponent(room.id)}&pageSize=50`,
      headers: { cookie, "accept-encoding": "gzip" }
    });
    const brotli = await app.inject({
      method: "GET",
      url: `/api/events?roomId=${encodeURIComponent(room.id)}&pageSize=50`,
      headers: { cookie, "accept-encoding": "br" }
    });
    const small = await app.inject({ method: "GET", url: "/healthz", headers: { "accept-encoding": "gzip" } });

    expect(gzip.statusCode).toBe(200);
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(gzip.headers.vary).toContain("accept-encoding");
    expect(brotli.statusCode).toBe(200);
    expect(brotli.headers["content-encoding"]).toBe("br");
    expect(small.headers["content-encoding"]).toBeUndefined();

    await app.close();
  });

  it("negotiates permessage-deflate for terminal WebSocket replay traffic", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "WebSocket compression", initialPaneCount: 0 }, "trace:ws-compress");
    const pane = store.createPane(
      { roomId: room.id, title: "Compressed terminal replay", mode: "TERMINAL", cwd: "/etc" },
      "trace:ws-compress-pane"
    );
    const app = await createApp({
      store,
      auth: {
        sessionSecret: "test-secret-with-enough-length",
        devLogin: true,
        secureCookies: false
      }
    });
    const cookie = await authenticatedCookie(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/panes/${encodeURIComponent(pane.id)}/cli/terminal?sessionId=cli_session%3Acompression-test&token=${"x".repeat(32)}`,
      { headers: { cookie }, perMessageDeflate: true }
    );

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      expect(socket.extensions.split(",").map((extension) => extension.trim()))
        .toContain("permessage-deflate");
    } finally {
      socket.terminate();
      await app.close();
    }
  });
});
