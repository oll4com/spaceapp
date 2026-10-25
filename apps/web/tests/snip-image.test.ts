import { describe, it, expect, vi } from "vitest";
import { fitRect, selection, drawMarks } from "../src/features/snip-tool/snip-image.js";
describe("snip geometry and irreversible exported redaction", () => {
  it("normalizes reverse drags in actual source pixels", () => {
    expect(selection({ x: 1500, y: 900 }, { x: 300, y: 200 })).toEqual({ x: 300, y: 200, width: 1200, height: 700 });
  });
  it("clamps crop and movement to image bounds", () => {
    expect(fitRect({ x: -10, y: 580, width: 1000, height: 100 }, 800, 600)).toEqual({ x: 0, y: 500, width: 800, height: 100 });
  });
  it("paints opaque redactions last, rounding outward over all selected pixels", () => {
    const calls: string[] = [];
    const ctx = { save: vi.fn(), restore: vi.fn(), fillText: () => calls.push("text"), fillRect: vi.fn(() => calls.push("redact")) };
    drawMarks(ctx as any, [{ kind: "redact", start: { x: 2.2, y: 3.1 }, end: { x: 20.6, y: 30.8 } }, { kind: "text", start: { x: 3, y: 4 }, text: "private" }], 800);
    expect(calls).toEqual(["text", "redact"]);
    expect(ctx.fillRect).toHaveBeenCalledWith(2, 3, 19, 28);
    expect((ctx as any).globalAlpha).toBe(1); expect((ctx as any).fillStyle).toBe("#000000");
  });
});
