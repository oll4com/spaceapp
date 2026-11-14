import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLiveKitMeter, priceLiveKitUse } from "../src/livekit-meter.js";

describe("LiveKit Inference meter", () => {
  it("prices minutes and characters, appends one line per call and stops at 95% of the grant or its expiry", async () => {
    expect(priceLiveKitUse({ source: "live", kind: "stt", model: "deepgram/nova-3", seconds: 600 })).toBeCloseTo(0.058);
    expect(priceLiveKitUse({ source: "video", kind: "tts", model: "cartesia/sonic-3", characters: 1_000_000 })).toBe(50);
    const path = join(await mkdtemp(join(tmpdir(), "livekit-meter-")), "var", "ledger.jsonl");
    let at = Date.parse("2026-11-13T00:00:00Z");
    const meter = createLiveKitMeter(path, () => at);
    expect([await meter.spent(), await meter.open()]).toEqual([0, true]);
    await meter.record({ source: "video", kind: "tts", model: "cartesia/sonic-3", characters: 0 });
    await meter.record({ source: "live", kind: "tts", model: "cartesia/sonic-3", characters: 132_000_000 });
    expect(await meter.spent()).toBe(6600);
    expect(await meter.open()).toBe(true);
    await meter.record({ source: "live", kind: "tts", model: "cartesia/sonic-3", characters: 1_000_000 });
    expect(await meter.open()).toBe(false);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
    // A new process reads the same sum, a torn line skipped.
    await writeFile(path, `${await readFile(path, "utf8")}{"usd":`);
    expect(await createLiveKitMeter(path, () => at).spent()).toBe(6650);
    at = Date.parse("2027-11-07T00:00:00Z");
    expect(await createLiveKitMeter(join(tmpdir(), "livekit-none.jsonl"), () => at).open()).toBe(false);
  });

  it("closes LiveKit when the ledger cannot be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "livekit-meter-"));
    await mkdir(join(dir, "ledger.jsonl"));
    expect(await createLiveKitMeter(join(dir, "ledger.jsonl"), () => Date.parse("2026-11-13T00:00:00Z")).open()).toBe(false);
  });
});
