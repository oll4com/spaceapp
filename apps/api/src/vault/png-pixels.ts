import { inflateSync } from "node:zlib";

/**
 * The RGBA pixels of an 8-bit, non-interlaced RGB or RGBA PNG (what Chrome's Page.captureScreenshot gives), for jsQR; null for
 * any other PNG. shortcut: palette, grey, 16-bit and interlaced PNGs answer null; add them if a capture ever comes that way.
 */
export function pngPixels(png: Uint8Array): { data: Uint8ClampedArray; width: number; height: number } | null {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (bytes.length < 33 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  let width = 0, height = 0, channels = 0;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0;
      if (body[8] !== 8 || !channels || body[12] !== 0) return null;
    } else if (type === "IDAT") compressed.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!width || !height || !channels || !compressed.length) return null;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(compressed)); } catch { return null; }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const pixels = new Uint8ClampedArray(width * height * 4);
  let previous = new Uint8Array(stride), line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels]! : 0, up = previous[x]!, upLeft = x >= channels ? previous[x - channels]! : 0;
      let predicted: number;
      if (filter === 0) predicted = 0;
      else if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const toLeft = Math.abs(up - upLeft), toUp = Math.abs(left - upLeft), toUpLeft = Math.abs(left + up - 2 * upLeft);
        predicted = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
      } else return null;
      line[x] = (raw[start + 1 + x]! + predicted) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const from = x * channels, to = (y * width + x) * 4;
      pixels[to] = line[from]!; pixels[to + 1] = line[from + 1]!; pixels[to + 2] = line[from + 2]!; pixels[to + 3] = channels === 4 ? line[from + 3]! : 255;
    }
    [previous, line] = [line, previous];
  }
  raw.fill(0);
  previous.fill(0);
  line.fill(0);
  return { data: pixels, width, height };
}
