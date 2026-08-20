import { describe, expect, it, vi } from "vitest";
import type { AddressInfo, Socket } from "node:net";
import { assertSafeVncTarget, pipeVncStream, vncPresets } from "../vnc-proxy.js";

describe("vnc-proxy", () => {
  it("exposes the expected presets", () => {
    expect(vncPresets.map((preset) => preset.id)).toEqual(["vm207-desktop", "vm219-windows", "dc01-windows", "databricks-form"]);
    for (const preset of vncPresets) {
      expect(preset.host).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(preset.port).toBeGreaterThan(0);
      expect(preset.port).toBeLessThanOrEqual(65535);
    }
  });

  it("accepts private IPv4 targets", () => {
    expect(() => assertSafeVncTarget("192.0.2.20")).not.toThrow();
    expect(() => assertSafeVncTarget("172.16.5.5")).not.toThrow();
    expect(() => assertSafeVncTarget("192.168.1.50")).not.toThrow();
    expect(() => assertSafeVncTarget("127.0.0.1")).not.toThrow();
  });

  it("rejects public, link-local, and malformed targets", () => {
    expect(() => assertSafeVncTarget("8.8.8.8")).toThrow(/private network/);
    expect(() => assertSafeVncTarget("169.254.1.1")).toThrow(/private network/);
    expect(() => assertSafeVncTarget("::1")).toThrow(/IPv4/);
    expect(() => assertSafeVncTarget("spaceapp.example")).toThrow(/IPv4/);
    expect(() => assertSafeVncTarget("192.0.2.20:5900")).toThrow(/IPv4/);
    expect(() => assertSafeVncTarget("")).toThrow(/IPv4/);
  });

  it("pipes binary websocket messages to the tcp socket and back", async () => {
    const net = await import("node:net");
    let serverConnection: Socket | null = null;
    const server = net.createServer((connection) => {
      serverConnection = connection;
      connection.on("data", (chunk: Buffer) => connection.write(Buffer.concat([Buffer.from("echo:"), chunk])));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    const socket = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn((event: string, listener: (raw: Buffer, isBinary: boolean) => void) => {
        if (event === "message") {
          listener(Buffer.from("hello"), true);
        }
      })
    };

    const done = pipeVncStream(socket as never, "127.0.0.1", address.port);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(socket.send).toHaveBeenCalledWith(expect.any(Buffer), { binary: true, compress: false });
    const echoed = (socket.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Buffer;
    expect(echoed.toString()).toBe("echo:hello");
    (serverConnection as Socket | null)?.destroy();
    await done;
    server.close();
  });

  it("rejects when the upstream tcp connection fails", async () => {
    const socket = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn()
    };
    await expect(pipeVncStream(socket as never, "127.0.0.1", 1)).rejects.toBeTruthy();
    expect(socket.close).toHaveBeenCalledWith(1011, "vnc upstream error");
  });
});