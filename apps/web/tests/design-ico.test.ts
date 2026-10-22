// "Download .ico" packs PNG images into one ICO file: header, one entry per size (256 is written as 0), data at the offsets.
import { describe, expect, it } from "vitest";
import { encodeIco, ICO_SIZES } from "../src/features/design-pane/ico.js";

describe("encodeIco", () => {
  it("writes an ICONDIR, one entry per image and the PNG bytes at their offsets", () => {
    const png = (size: number) => Uint8Array.from({ length: size % 7 + 3 }, (_, index) => (size + index) % 256);
    const images = ICO_SIZES.map((size) => ({ size, png: png(size) }));
    const ico = encodeIco(images);
    const view = new DataView(ico.buffer);
    expect([view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true)]).toEqual([0, 1, ICO_SIZES.length]);
    let expectedOffset = 6 + 16 * images.length;
    images.forEach((image, index) => {
      const entry = 6 + 16 * index;
      expect(view.getUint8(entry)).toBe(image.size === 256 ? 0 : image.size);
      expect(view.getUint8(entry + 1)).toBe(image.size === 256 ? 0 : image.size);
      expect(view.getUint16(entry + 6, true)).toBe(32);
      expect(view.getUint32(entry + 8, true)).toBe(image.png.length);
      expect(view.getUint32(entry + 12, true)).toBe(expectedOffset);
      expect([...ico.subarray(expectedOffset, expectedOffset + image.png.length)]).toEqual([...image.png]);
      expectedOffset += image.png.length;
    });
    expect(ico.length).toBe(expectedOffset);
  });

  it("refuses images larger than 256 px", () => {
    expect(() => encodeIco([{ size: 512, png: new Uint8Array(4) }])).toThrow(/1-256 px/);
  });
});
