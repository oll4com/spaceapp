import { expect, it, vi } from "vitest";
import { registerRoomPlaybackTarget, runRoomPlaybackCommand } from "../src/features/room-agent/room-playback-control.js";
it("targets the current room and does not apply a duplicate next command", async () => {
  const current = vi.fn(() => true), other = vi.fn(() => true);
  const dispose = [registerRoomPlaybackTarget("pane:a", { roomId: "room:a", kind: "YOUTUBE", playing: true, run: current }),
    registerRoomPlaybackTarget("pane:b", { roomId: "room:b", kind: "YOUTUBE", playing: true, run: other })];
  try {
    const command = { type: "MUSIC", action: "NEXT", target: "YOUTUBE" } as const;
    expect(await runRoomPlaybackCommand("room:a", "request:1", command)).toBe(true);
    expect(await runRoomPlaybackCommand("room:a", "request:1", command)).toBe(true);
    expect(current).toHaveBeenCalledOnce(); expect(other).not.toHaveBeenCalled();
  } finally { dispose.forEach(fn=>fn()); }
});
it("does not guess between players or report success when the player rejects a command", async () => {
  const run = vi.fn(() => false);
  const first = registerRoomPlaybackTarget("pane:c", { roomId: "room:c", kind: "YOUTUBE", playing: true, run });
  const second = registerRoomPlaybackTarget("pane:d", { roomId: "room:c", kind: "YOUTUBE", playing: true, run });
  const command = { type: "MUSIC", action: "PLAY", target: "YOUTUBE" } as const;
  try {
    expect(await runRoomPlaybackCommand("room:c", "request:2", command)).toBe(false);
    expect(run).not.toHaveBeenCalled(); second();
    expect(await runRoomPlaybackCommand("room:c", "request:3", command)).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  } finally { first(); second(); }
});


it("serializes playback for one room while another room remains independent", async () => {
  let release!: (ok: boolean) => void;
  const order: string[] = [];
  const run = vi.fn((command: { action: string }) => {
    order.push(command.action);
    return command.action === "NEXT" ? new Promise<boolean>(resolve => { release = resolve; }) : true;
  });
  const dispose = registerRoomPlaybackTarget("pane:serial", { roomId: "room:serial", kind: "MUSIC", playing: true, run });
  const disposeOther = registerRoomPlaybackTarget("pane:independent", { roomId: "room:independent", kind: "MUSIC", playing: true, run: () => true });
  try {
    const next = runRoomPlaybackCommand("room:serial", "request:serial-next", { type: "MUSIC", action: "NEXT", target: "AUTO" });
    const pause = runRoomPlaybackCommand("room:serial", "request:serial-pause", { type: "MUSIC", action: "PAUSE", target: "AUTO" });
    await vi.waitFor(() => expect(order).toEqual(["NEXT"]));
    expect(await runRoomPlaybackCommand("room:independent", "request:independent", { type: "MUSIC", action: "PAUSE", target: "AUTO" })).toBe(true);
    release(true);
    expect(await next).toBe(true); expect(await pause).toBe(true);
    expect(order).toEqual(["NEXT", "PAUSE"]);
    expect(await runRoomPlaybackCommand("room:serial", "request:serial-next", { type: "MUSIC", action: "PREVIOUS", target: "AUTO" })).toBe(false);
    expect(order).toHaveLength(2);
  } finally { dispose(); disposeOther(); }
});
