import { createCipheriv, createHash } from "node:crypto";
import { connect } from "node:net";
import type { SpaceStore } from "@space/runtime";
import type { SetupSelectedServices } from "./setup-selected-services.js";
import { assertSafeVncTarget } from "./vnc-proxy.js";

interface Target { host: string; port: number; password?: string | null }
const failed = () => new Error("The selected Remote Desktop target did not pass its protocol and access check.");

function challengeResponse(challenge: Buffer, password: string): Buffer {
  const key = Buffer.alloc(8); Buffer.from(password, "latin1").copy(key, 0, 0, 8);
  for (let i = 0; i < key.length; i++) {
    let value = key[i]!; let reversed = 0;
    for (let bit = 0; bit < 8; bit++) { reversed = reversed << 1 | value & 1; value >>= 1; }
    key[i] = reversed;
  }
  // Repeating the DES key gives the protocol's single DES operation through the available 3DES primitive.
  const cipher = createCipheriv("des-ede3", Buffer.concat([key, key, key]), null); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

/** Full bounded RFB handshake. Never requests framebuffer pixels or sends keyboard/pointer events. */
export async function checkSetupVncHandshake(target: Target): Promise<{ protocol: string; security: number; width: number; height: number }> {
  assertSafeVncTarget(target.host);
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || target.password && target.password.length > 512) throw failed();
  const socket = connect({ host: target.host, port: target.port });
  let buffered = Buffer.alloc(0); let received = 0; let error: Error | null = null;
  let pending: { length: number; resolve: (data: Buffer) => void; reject: (cause: Error) => void } | null = null;
  function stop() { error = failed(); pending?.reject(error); pending = null; socket.destroy(); }
  function flush() {
    if (!pending || buffered.length < pending.length) return;
    const item = pending; pending = null;
    const result = buffered.subarray(0, item.length); buffered = buffered.subarray(item.length); item.resolve(result);
  }
  socket.on("data", (chunk: Buffer) => {
    if (error) return;
    received += chunk.length; if (received > 8192) { stop(); return; }
    buffered = Buffer.concat([buffered, chunk]); flush();
  });
  socket.on("error", stop); socket.on("close", stop);
  const deadline = setTimeout(stop, 5_000);
  const read = (length: number): Promise<Buffer> => {
    if (error) return Promise.reject(error);
    if (!Number.isInteger(length) || length < 0 || length > 4096 || pending) return Promise.reject(failed());
    return new Promise((resolve, reject) => { pending = { length, resolve, reject }; flush(); });
  };
  try {
    const banner = (await read(12)).toString("ascii");
    if (!/^RFB 003\.(003|007|008)\n$/.test(banner)) throw failed();
    const protocol = banner.slice(4, 11); socket.write(banner);
    let security: number;
    if (protocol === "003.003") security = (await read(4)).readUInt32BE();
    else {
      const count = (await read(1))[0]!; if (count < 1 || count > 64) throw failed();
      const supported = await read(count);
      security = supported.includes(2) && target.password ? 2 : supported.includes(1) ? 1 : 0;
      if (!security) throw failed(); socket.write(Buffer.from([security]));
    }
    if (security === 2) {
      if (!target.password) throw failed();
      socket.write(challengeResponse(await read(16), target.password));
      if ((await read(4)).readUInt32BE() !== 0) throw failed();
    } else if (security === 1) {
      if (protocol === "003.008" && (await read(4)).readUInt32BE() !== 0) throw failed();
    } else throw failed();
    socket.write(Buffer.from([1])); // Shared access preserves any existing viewer.
    const init = await read(24); const width = init.readUInt16BE(0); const height = init.readUInt16BE(2);
    const bits = init[4]!; const depth = init[5]!; const nameLength = init.readUInt32BE(20);
    if (!width || !height || width > 16384 || height > 16384 || ![8, 16, 32].includes(bits) || !depth || depth > bits || nameLength > 4096) throw failed();
    await read(nameLength); // Discard the remote desktop's name; it is not evidence content.
    return { protocol, security, width, height };
  } finally { clearTimeout(deadline); socket.destroy(); }
}

export function createSetupVncAdapter(options: { listTargets: (ownerId: string) => Promise<Array<Target & { id: string; label: string }>> }): NonNullable<SetupSelectedServices["pane:vnc"]> {
  return {
    list: async ownerId => (await options.listTargets(ownerId)).slice(0, 100).map(({ id, label }) => ({ id, label })),
    inspect: async (ownerId, choiceId) => {
      const target = (await options.listTargets(ownerId)).slice(0, 100).find(item => item.id === choiceId);
      if (!target) throw failed();
      const result = await checkSetupVncHandshake(target);
      return createHash("sha256").update(JSON.stringify({ version: "vnc-setup:v1", ownerId, choiceId,
        host: target.host, port: target.port, password: target.password ?? null, ...result })).digest("hex");
    }
  };
}

/** Saved targets only, resolved from the caller's existing rooms; no arbitrary host from setup input. */
export function createStoredSetupVncAdapter(store: Pick<SpaceStore, "listRooms" | "listPanes">) {
  return createSetupVncAdapter({ listTargets: async ownerId => {
    const targets: Array<Target & { id: string; label: string }> = [];
    for (const room of (await store.listRooms(ownerId)).slice(0, 100)) {
      if (room.ownerUserId !== ownerId && !(ownerId === "user:operator" && !room.ownerUserId)) continue;
      for (const pane of await store.listPanes(room.id)) {
        if (pane.mode !== "VNC" || !pane.vncTarget) continue;
        targets.push({ id: pane.id, label: `Saved Remote Desktop connection ${targets.length + 1}`, ...pane.vncTarget });
        if (targets.length >= 100) return targets;
      }
    }
    return targets;
  } });
}
