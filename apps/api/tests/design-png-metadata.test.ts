// Every design PNG carries what it shows and who made it (operator request 2026-10-19): iTXt chunks right after IHDR.
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { imageDimensions, readPngText, withPngMetadata } from "../src/design/images.js";
import { pngOf } from "./fixtures/design-png.js";

/** The chunks of a PNG after the signature: type, keyword of a text chunk, its text, and whether the CRC holds. */
function chunks(bytes: Buffer) {
  const out: Array<{ type: string; keyword: string; text: string; crcOk: boolean }> = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const nul = data.indexOf(0);
    out.push({ type, keyword: type === "iTXt" ? data.subarray(0, nul).toString("latin1") : "", text: type === "iTXt" ? data.subarray(nul + 5).toString("utf8") : "",
      crcOk: bytes.readUInt32BE(offset + 8 + length) === crc32(bytes.subarray(offset + 4, offset + 8 + length)) });
    offset += 12 + length;
  }
  return out;
}
/** A whole PNG: the fixture header with a real IHDR CRC, one IDAT and IEND. */
function fullPng(width: number, height: number): Buffer {
  const header = pngOf(width, height);
  header.writeUInt32BE(crc32(header.subarray(12, 29)), 29);
  const chunk = (type: string, data: Buffer) => {
    const frame = Buffer.alloc(12 + data.length);
    frame.writeUInt32BE(data.length, 0);
    frame.write(type, 4, "ascii");
    data.copy(frame, 8);
    frame.writeUInt32BE(crc32(frame.subarray(4, 8 + data.length)), 8 + data.length);
    return frame;
  };
  return Buffer.concat([header, chunk("IDAT", Buffer.from([1, 2, 3])), chunk("IEND", Buffer.alloc(0))]);
}

describe("withPngMetadata", () => {
  it("puts UTF-8 iTXt chunks with valid CRCs right after IHDR and keeps the size and the image data", () => {
    const out = withPngMetadata(fullPng(1080, 1350), { Description: "6 AI models played chess. Zero checkmates. Opus 5.5 · ½–½", "spaceapp:design": '{"formatId":"portrait"}' });
    expect(imageDimensions(out)).toEqual({ width: 1080, height: 1350 });
    expect(chunks(out).map((chunk) => [chunk.type, chunk.keyword, chunk.crcOk])).toEqual([
      ["IHDR", "", true], ["iTXt", "Description", true], ["iTXt", "spaceapp:design", true], ["IDAT", "", true], ["IEND", "", true]]);
    expect(chunks(out)[1]!.text).toBe("6 AI models played chess. Zero checkmates. Opus 5.5 · ½–½");
  });

  it("replaces older chunks with the same keywords, so a re-uploaded design never keeps stale metadata", () => {
    const once = withPngMetadata(fullPng(1600, 900), { Description: "Opus", Title: "Old title" });
    const twice = withPngMetadata(once, { Description: "Opus 5.5" });
    expect(chunks(twice).filter((chunk) => chunk.type === "iTXt").map((chunk) => [chunk.keyword, chunk.text])).toEqual([["Description", "Opus 5.5"], ["Title", "Old title"]]);
  });

  it("reads back what it wrote (readPngText), plus tEXt from other software", () => {
    const tEXt = Buffer.alloc(12 + 16);
    tEXt.writeUInt32BE(16, 0);
    tEXt.write("tEXt", 4, "ascii");
    Buffer.from("Author\0Somebody!", "latin1").copy(tEXt, 8);
    tEXt.writeUInt32BE(crc32(tEXt.subarray(4, 24)), 24);
    const base = fullPng(1080, 1350);
    const withAuthor = Buffer.concat([base.subarray(0, base.length - 12), tEXt, base.subarray(base.length - 12)]);
    const out = withPngMetadata(withAuthor, { Description: "Opus 5.5 · ½–½", "spaceapp:design": '{"madeBy":{"by":"AGENT"}}' });
    expect(readPngText(out)).toEqual({ Description: "Opus 5.5 · ½–½", "spaceapp:design": '{"madeBy":{"by":"AGENT"}}', Author: "Somebody!" });
    expect(readPngText(pngOf(10, 10))).toEqual({});
    expect(readPngText(Buffer.from([0xff, 0xd8, 0xff]))).toEqual({});
  });

  it("handles a PNG cut after IHDR and leaves other files alone", () => {
    const out = withPngMetadata(pngOf(800, 450), { Description: "Crop" });
    expect(imageDimensions(out)).toEqual({ width: 800, height: 450 });
    expect(out.toString("utf8")).toContain("Description");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(withPngMetadata(jpeg, { Description: "x" })).toBe(jpeg);
  });
});
