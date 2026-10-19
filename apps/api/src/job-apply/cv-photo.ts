/**
 * The candidate photo embedded in a CV PDF (operator rule 2026-10-17: every form that asks for a photo gets this one).
 * A JPEG image in a PDF (/Filter /DCTDecode) is stored as a complete JPEG file, so copying its stream bytes keeps the
 * original resolution and encoding. The largest such image is the photo; icons and backgrounds are smaller or not JPEG.
 */
export interface CvPhoto {
  bytes: Buffer;
  width: number;
  height: number;
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

function streamLength(pdf: string, value: string): number | null {
  const direct = /^\d+$/.exec(value);
  if (direct) return Number(value);
  const reference = /^(\d+)\s+(\d+)\s+R$/.exec(value);
  if (!reference) return null;
  const object = new RegExp(`(?:^|[\\r\\n\\s])${reference[1]}\\s+${reference[2]}\\s+obj\\s*(\\d+)\\s*endobj`).exec(pdf);
  return object ? Number(object[1]) : null;
}

export function extractCvPhoto(pdfBytes: Buffer): CvPhoto | null {
  const pdf = pdfBytes.toString("latin1");
  let best: CvPhoto | null = null;
  // Each stream object's own dictionary: from "N G obj <<" to the ">> stream" before its "endobj".
  for (const match of pdf.matchAll(/\d+\s+\d+\s+obj\s*<<((?:(?!endobj)[\s\S]){0,8000}?)>>\s*stream(\r\n|\n)/g)) {
    const dictionary = match[1]!;
    if (!/\/Subtype\s*\/Image\b/.test(dictionary)) continue;
    // Only a plain JPEG stream; a chained filter (Flate over DCT) would need decoding first.
    if (!/\/Filter\s*(?:\/DCTDecode|\[\s*\/DCTDecode\s*\])/.test(dictionary)) continue;
    const width = Number(/\/Width\s+(\d+)/.exec(dictionary)?.[1]);
    const height = Number(/\/Height\s+(\d+)/.exec(dictionary)?.[1]);
    const lengthValue = /\/Length\s+(\d+(?:\s+\d+\s+R)?)/.exec(dictionary)?.[1];
    const length = lengthValue ? streamLength(pdf, lengthValue) : null;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) continue;
    if (length === null || length < 4 || length > MAX_PHOTO_BYTES) continue;
    const start = match.index! + match[0].length;
    const bytes = pdfBytes.subarray(start, start + length);
    // A complete JPEG: SOI at the start and EOI at the end of the stream.
    if (bytes.length !== length || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[length - 2] !== 0xff || bytes[length - 1] !== 0xd9) continue;
    if (!best || width * height > best.width * best.height) best = { bytes: Buffer.from(bytes), width, height };
  }
  return best;
}
