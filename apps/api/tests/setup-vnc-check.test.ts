import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import * as vnc from "../src/setup-vnc-check.js";

async function server(mode: "none" | "auth" | "denied" | "garbage") {
  let connections = 0; const sent: Buffer[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const service = createServer(socket => {
    connections++; sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.write(mode === "garbage" ? "An HTTP port, not VNC!" : "RFB 003.008\n");
    let stage = 0;
    socket.on("data", data => {
      sent.push(data);
      if (stage === 0) { stage++; socket.write(Buffer.from([1, mode === "none" ? 1 : 2])); }
      else if (stage === 1) {
        stage++;
        if (mode === "none") socket.write(Buffer.alloc(4)); else socket.write(Buffer.from("00112233445566778899aabbccddeeff", "hex"));
      } else if (stage === 2 && mode !== "none") {
        stage++; const status = Buffer.alloc(4); status.writeUInt32BE(mode === "denied" || data.toString("hex") !== "7f5dd787bf3d2cffb354f6c1ee5d6e16" ? 1 : 0); socket.write(status);
      } else {
        stage++;
        const initialized = Buffer.alloc(24); initialized.writeUInt16BE(1280, 0); initialized.writeUInt16BE(720, 2);
        initialized[4] = 32; initialized[5] = 24; initialized[7] = 1;
        initialized.writeUInt32BE(7, 20); socket.write(Buffer.concat([initialized, Buffer.from("fixture")]));
      }
    });
  });
  await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
  const port = (service.address() as import("node:net").AddressInfo).port;
  return { port, sent, count: () => connections,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => service.close(() => resolve())); } };
}

describe("selected Remote Desktop setup check", () => {
  it("resolves only the caller's saved VNC panes without exposing their credentials or probing them while listing", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Agent Proof Setup VNC", initialPaneCount: 1 }, "trace:setup-vnc", "user:owner");
    const pane = store.createPane({ roomId: room.id, title: "Owned connection", mode: "VNC",
      vncTarget: { host: "127.0.0.1", port: 5900, password: "private-fixture-password", presetId: null } });
    const adapter = vnc.createStoredSetupVncAdapter(store);
    expect(await adapter.list("user:owner")).toEqual([{ id: pane.id, label: "Saved Remote Desktop connection 1" }]);
    expect(await adapter.list("user:other")).toEqual([]);
    expect(JSON.stringify(await adapter.list("user:owner"))).not.toContain("private-fixture-password");
    store.updatePane(pane.id, { isClosed: true });
    expect(await adapter.list("user:owner")).toEqual([]);
  });
  it("requires the full RFB security and server-init handshake without requesting pixels or sending input", async () => {
    const s = await server("none");
    try {
      const result = await vnc.checkSetupVncHandshake({ host: "127.0.0.1", port: s.port });
      expect(result).toEqual({ protocol: "003.008", security: 1, width: 1280, height: 720 });
      expect(Buffer.concat(s.sent)).toEqual(Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1])]));
    } finally { await s.close(); }
  });

  it("authenticates VNC challenge-response and rejects a failed or missing password", async () => {
    const s = await server("auth");
    try {
      await expect(vnc.checkSetupVncHandshake({ host: "127.0.0.1", port: s.port, password: "fixture" })).resolves.toMatchObject({ security: 2 });
      expect(s.sent[2]?.length).toBe(16);
      await expect(vnc.checkSetupVncHandshake({ host: "127.0.0.1", port: s.port })).rejects.toThrow();
    } finally { await s.close(); }
    const denied = await server("denied");
    try { await expect(vnc.checkSetupVncHandshake({ host: "127.0.0.1", port: denied.port, password: "fixture" })).rejects.toThrow(); }
    finally { await denied.close(); }
  });

  it("does not accept an open non-VNC port or probe an unlisted owner's target", async () => {
    const s = await server("garbage");
    try {
      await expect(vnc.checkSetupVncHandshake({ host: "127.0.0.1", port: s.port })).rejects.toThrow();
      const adapter = vnc.createSetupVncAdapter({ listTargets: async ownerId => ownerId === "user:owner" ? [{ id: "owned", label: "Saved connection", host: "127.0.0.1", port: s.port }] : [] });
      expect(await adapter.list("user:owner")).toEqual([{ id: "owned", label: "Saved connection" }]);
      const before = s.count();
      await expect(adapter.inspect("user:other", "owned")).rejects.toThrow();
      await expect(adapter.inspect("user:owner", "arbitrary-target")).rejects.toThrow();
      expect(s.count()).toBe(before);
    } finally { await s.close(); }
  });
});
