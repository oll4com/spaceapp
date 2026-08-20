import net, { isIP } from "node:net";
import type { VncPreset } from "@space/contracts";

export const vncPresets: ReadonlyArray<VncPreset> = [
  { id: "vm207-desktop", name: "public-host Desktop (Xvfb :99)", host: "127.0.0.1", port: 5900 },
  { id: "vm219-windows", name: "public-host Windows 11", host: "192.0.2.249", port: 5900 },
  { id: "dc01-windows", name: "dc01 Thailand (192.0.2.20)", host: "192.0.2.20", port: 5900 },
  { id: "databricks-form", name: "Databricks form (Xvfb :98)", host: "10.254.240.22", port: 5901 }
];

const PRIVATE_V4_NETWORKS: ReadonlyArray<{ base: number; bits: number }> = [
  { base: 0x0a000000, bits: 8 },
  { base: 0xac100000, bits: 12 },
  { base: 0xc0a80000, bits: 16 },
  { base: 0x7f000000, bits: 8 }
];

function ipv4ToInt(parts: number[]): number {
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  const c = parts[2] ?? 0;
  const d = parts[3] ?? 0;
  return ((((a << 8) | b) << 8 | c) << 8) | d;
}

function maskBits(bits: number): number {
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

export function assertSafeVncTarget(host: string): void {
  if (isIP(host) !== 4) {
    throw new Error("VNC target host must be an IPv4 address on a private network.");
  }
  const addr = ipv4ToInt(host.split(".").map((part) => Number(part))) >>> 0;
  const allowed = PRIVATE_V4_NETWORKS.some(({ base, bits }) => ((addr & maskBits(bits)) >>> 0) === base);
  if (!allowed) {
    throw new Error("VNC target must be on a private network (10/8, 172.16/12, 192.168/16, or 127.0.0.0/8).");
  }
}

export interface VncStreamSocket {
  readyState: number;
  send(data: Buffer | string, options?: { binary?: boolean; compress?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (raw: Buffer, isBinary: boolean) => void): void;
  on(event: "close", listener: () => void): void;
}

export function pipeVncStream(socket: VncStreamSocket, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tcp = net.connect(port, host);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    tcp.on("connect", () => {
      if (socket.readyState !== 1) {
        tcp.destroy();
        finish();
        return;
      }
      tcp.on("data", (chunk: Buffer) => {
        if (socket.readyState === 1) {
          socket.send(chunk, { binary: true, compress: false });
        }
      });
      socket.on("message", (raw: Buffer, isBinary: boolean) => {
        if (!isBinary) return;
        if (!tcp.destroyed) tcp.write(raw);
      });
      socket.on("close", () => {
        tcp.destroy();
        finish();
      });
      tcp.on("close", () => {
        if (socket.readyState === 1) socket.close(1000, "vnc upstream closed");
        finish();
      });
      tcp.on("error", (error: Error) => {
        if (socket.readyState === 1) socket.close(1011, "vnc upstream error");
        finish(error);
      });
    });
    tcp.on("error", (error: Error) => {
      if (socket.readyState === 1) socket.close(1011, "vnc upstream error");
      finish(error);
    });
  });
}