// "Download .ico" in the Studio (operator request 2026-10-19): a square design becomes one Windows/web icon file holding
// PNG images at the usual favicon and app-icon sizes. Built in the browser: an .ico is not a design asset type.

export const ICO_SIZES = [16, 32, 48, 64, 128, 256] as const;

/** An ICO file (ICONDIR + one ICONDIRENTRY per image + the PNG bytes); each PNG must be at most 256 px square. */
export function encodeIco(images: ReadonlyArray<{ size: number; png: Uint8Array }>): Uint8Array<ArrayBuffer> {
  const headerBytes = 6 + 16 * images.length;
  const out = new Uint8Array(new ArrayBuffer(headerBytes + images.reduce((sum, image) => sum + image.png.length, 0)));
  const view = new DataView(out.buffer);
  view.setUint16(2, 1, true); // type 1: icon
  view.setUint16(4, images.length, true);
  let offset = headerBytes;
  images.forEach((image, index) => {
    if (!Number.isInteger(image.size) || image.size < 1 || image.size > 256) throw new Error(`An icon image is 1-256 px, not ${image.size}.`);
    const entry = 6 + 16 * index;
    view.setUint8(entry, image.size % 256); // 256 is written as 0
    view.setUint8(entry + 1, image.size % 256);
    view.setUint16(entry + 4, 1, true); // colour planes
    view.setUint16(entry + 6, 32, true); // bits per pixel
    view.setUint32(entry + 8, image.png.length, true);
    view.setUint32(entry + 12, offset, true);
    out.set(image.png, offset);
    offset += image.png.length;
  });
  return out;
}

/** The .ico of an image: drawn at every ICO_SIZES size on a canvas and packed as PNG-in-ICO. */
export async function icoFromImage(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const images: Array<{ size: number; png: Uint8Array }> = [];
    for (const size of ICO_SIZES) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser cannot draw the icon.");
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, size, size);
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!png) throw new Error("This browser cannot encode the icon.");
      images.push({ size, png: new Uint8Array(await png.arrayBuffer()) });
    }
    return new Blob([encodeIco(images)], { type: "image/x-icon" });
  } finally {
    bitmap.close();
  }
}
