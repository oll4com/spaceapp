import { describe, expect, it } from "vitest";
import * as pixels from "../src/features/setup-connections/setup-capture-pixels.js";

describe("capture proof privacy", () => {
  it("refuses an unrelated crop locally and sends only validated synthetic tile samples", () => {
    const colors = Array(64).fill("#4080c0");
    const crop = new Uint8ClampedArray(4096);
    expect(() => pixels.buildSetupCaptureProofPixels(crop, colors)).toThrow();
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      const at = ((row * 4 + 2) * 32 + col * 4 + 2) * 4;
      crop.set([64, 128, 192, 255], at);
    }
    // Pixels outside the known samples must never be sent.
    crop.set([255, 1, 2, 3], 0);
    const raw = atob(pixels.buildSetupCaptureProofPixels(crop, colors));
    expect(raw.length).toBe(4096);
    expect(Array.from(raw.slice(0, 4), char => char.charCodeAt(0))).toEqual([64, 128, 192, 255]);
    crop[((2 * 32) + 2) * 4] = 255;
    expect(() => pixels.buildSetupCaptureProofPixels(crop, colors)).toThrow();
  });
});
