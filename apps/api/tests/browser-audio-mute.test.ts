import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { audibleMessagePaneIds, createBrowserAudioMute, pulseBrowserAudioMuteDeps, soundingChromeProfiles } from "../src/browser-audio-mute.js";

// Operator 2/11 14:22 BKK: a Twitch tab in a browser pane nobody looked at played on their computer.
describe("browser audio mute at the source", () => {
  function fixture() {
    const inputs = [
      { index: 1, mute: false, properties: { "application.process.id": "100" } }, // Twitch's Chrome
      { index: 2, mute: false, properties: { "application.process.id": "200" } }, // the YouTube pane's Chrome, left playing
      { index: 3, mute: false, properties: { "application.process.id": "300" } } // not a managed Chrome
    ];
    const calls: string[][] = [];
    const stopWatch = vi.fn();
    const onNew: Array<() => void> = [];
    const mute = createBrowserAudioMute({
      pactl: async (args) => {
        calls.push(args);
        if (args[0] === "set-sink-input-mute") inputs.find((input) => input.index === Number(args[1]))!.mute = args[2] === "1";
        return args.includes("list") ? JSON.stringify(inputs) : "";
      },
      watch: (callback) => { onNew.push(callback); return stopWatch; },
      chromeProfileOf: async (pid) => ({ 100: "/profiles/twitch", 200: "/profiles/youtube/" } as Record<number, string>)[pid] ?? null,
      profilesOf: async (ids) => ids.map((id) => ({ "pane:yt": "/profiles/youtube", "pane:twitch": "/profiles/twitch" } as Record<string, string>)[id] ?? "/profiles/none"),
      warn: vi.fn()
    });
    const sets = () => calls.filter((args) => args[0] === "set-sink-input-mute").map((args) => args.slice(1).join("="));
    return { inputs, mute, sets, stopWatch, onNew };
  }

  it("names the Chromes playing sound, muted or not, so the idle sweep never freezes them (light browser step 4)", async () => {
    const inputs = [
      { index: 1, mute: true, corked: false, properties: { "application.process.id": "100" } }, // plays, muted at the source
      { index: 2, mute: false, corked: true, properties: { "application.process.id": "200" } }, // paused
      { index: 3, mute: false, properties: { "application.process.id": "300" } }, // no corked field: counts as playing
      { index: 4, mute: false, corked: false, properties: { "application.process.id": "400" } } // not a managed Chrome
    ];
    const profiles: Record<number, string> = { 100: "/profiles/twitch/", 200: "/profiles/idle", 300: "/profiles/radio" };
    const sounding = await soundingChromeProfiles({ pactl: async () => JSON.stringify(inputs), chromeProfileOf: async (pid) => profiles[pid] ?? null });
    expect([...sounding].sort()).toEqual(["/profiles/radio", "/profiles/twitch"]);
  });

  it("mutes every Chrome but the audible panes', all of them while no socket is open, and leaves unknown streams", async () => {
    const { inputs, mute, sets, stopWatch, onNew } = fixture();
    await mute.idle();
    expect(inputs.map((input) => input.mute)).toEqual([true, true, false]); // nobody listens: every managed Chrome is muted
    const socket = mute.hold(["pane:yt"]);
    await mute.idle();
    expect(sets()).toEqual(["1=1", "2=1", "2=0"]);
    expect(inputs.map((input) => input.mute)).toEqual([true, false, false]);

    socket.update(["pane:yt", "pane:twitch"]); // the operator focused the Twitch pane
    await mute.idle();
    expect(inputs.map((input) => input.mute)).toEqual([false, false, false]);

    socket.update(["pane:yt"]); // and left it
    await mute.idle();
    expect(inputs[0]!.mute).toBe(true);

    inputs.push({ index: 4, mute: false, properties: { "application.process.id": "100" } }); // Twitch starts a new stream
    onNew[0]!();
    await mute.idle();
    expect(inputs[3]!.mute).toBe(true);

    socket.release();
    await mute.idle();
    expect(inputs.map((input) => input.mute)).toEqual([true, true, false, true]); // the last socket closed
    socket.update(["pane:twitch"]); // a late update after the socket closed changes nothing
    await mute.idle();
    expect(inputs[0]!.mute).toBe(true);
    expect(stopWatch).not.toHaveBeenCalled();
    mute.stop();
    expect(stopWatch).toHaveBeenCalledOnce();
  });

  it("reads only well-formed audible messages", () => {
    expect(audibleMessagePaneIds(JSON.stringify({ type: "audible", paneIds: ["pane:abcdefgh", "pane:abcdefgh"] }))).toEqual(["pane:abcdefgh"]);
    expect(audibleMessagePaneIds(JSON.stringify({ type: "audible", paneIds: ["../x"] }))).toBeNull();
    expect(audibleMessagePaneIds("{nope")).toBeNull();
  });

  it("finds a process's Chrome profile on it or on its parent", async () => {
    const parent = spawn("sh", ["-c", "sleep 5; :", "--user-data-dir=/profiles/proof"]);
    try {
      let child = 0;
      for (let tries = 0; !child && tries < 50; tries++) {
        await new Promise((done) => setTimeout(done, 20));
        const kids = await readFile(`/proc/${parent.pid}/task/${parent.pid}/children`, "utf8").catch(() => "");
        child = Number(kids.trim().split(" ")[0]) || 0;
      }
      const deps = pulseBrowserAudioMuteDeps("unix:/nonexistent", async () => []);
      expect(await deps.chromeProfileOf(parent.pid!)).toBe("/profiles/proof");
      expect(await deps.chromeProfileOf(child)).toBe("/profiles/proof");
      expect(await deps.chromeProfileOf(process.pid)).toBeNull();
    } finally {
      parent.kill();
    }
  });
});
