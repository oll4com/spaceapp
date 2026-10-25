import { readFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { DESIGN_ENGINE_MODELS, nearestDesignAspectRatio, type DesignGeneratingEngine } from "@space/contracts";
import { SpaceConflictError, SpaceFeatureDisabledError } from "@space/runtime";

// Image bytes for the Design pane: what a file really is (never the declared type), its pixel size, and the Space Gateway
// client of `POST /images/v1/generate` with the pane's own gateway key (`space-design`, image models only, a daily cost cap).

export type DesignMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "video/mp4";

/** The type a file's bytes show: PNG, JPEG, WebP, GIF or MP4 (ISO base media `ftyp`); anything else is refused. */
export function sniffDesignMime(bytes: Buffer): DesignMimeType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  return null;
}

/** Pixel size of a PNG, JPEG, WebP or GIF; null when the header does not say (or for video). */
export function imageDimensions(bytes: Buffer): { width: number; height: number } | null {
  const mime = sniffDesignMime(bytes);
  if (mime === "image/png" && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (mime === "image/gif" && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (mime === "image/webp" && bytes.length >= 30) {
    const chunk = bytes.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (chunk === "VP8L") { const bits = bytes.readUInt32LE(21); return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }; }
    if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (mime === "image/jpeg") {
    // Walk the segments to the first start-of-frame marker (SOF0-SOF15 except DHT, JPG and DAC).
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      }
      offset += 2 + bytes.readUInt16BE(offset + 2);
    }
  }
  return null;
}

const PNG_TEXT_CHUNKS = new Set(["iTXt", "tEXt", "zTXt"]);
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const frame = Buffer.alloc(12 + data.length);
  frame.writeUInt32BE(data.length, 0);
  body.copy(frame, 4);
  frame.writeUInt32BE(crc32(body), 8 + data.length);
  return frame;
}

/**
 * The PNG with one uncompressed UTF-8 iTXt chunk per entry right after IHDR; text chunks with the same keywords are
 * dropped first, so a re-uploaded design never keeps stale metadata. Other files, and PNGs without IHDR, are returned as is.
 */
export function withPngMetadata(bytes: Buffer, entries: Record<string, string>): Buffer {
  const headerEnd = 33; // signature (8) + IHDR chunk (4 length + 4 type + 13 data + 4 CRC)
  if (sniffDesignMime(bytes) !== "image/png" || bytes.length < headerEnd || bytes.subarray(12, 16).toString("ascii") !== "IHDR") return bytes;
  const keys = new Set(Object.keys(entries));
  const kept: Buffer[] = [];
  let offset = headerEnd;
  while (offset + 12 <= bytes.length) {
    const end = offset + 12 + bytes.readUInt32BE(offset);
    if (end > bytes.length) break;
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, end - 4);
    const keyword = data.subarray(0, Math.max(0, data.indexOf(0))).toString("latin1");
    if (!(PNG_TEXT_CHUNKS.has(type) && keys.has(keyword))) kept.push(bytes.subarray(offset, end));
    offset = end;
  }
  const added = Object.entries(entries).map(([keyword, text]) =>
    pngChunk("iTXt", Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(text, "utf8")])));
  return Buffer.concat([bytes.subarray(0, headerEnd), ...added, ...kept, bytes.subarray(offset)]);
}

/** The uncompressed tEXt and iTXt chunks of a PNG as keyword → text (the first of a repeated keyword); zTXt, compressed iTXt and other files give {}. */
export function readPngText(bytes: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  if (sniffDesignMime(bytes) !== "image/png") return out;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const end = offset + 12 + bytes.readUInt32BE(offset);
    if (end > bytes.length) break;
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, end - 4);
    const nul = data.indexOf(0);
    const keyword = nul > 0 ? data.subarray(0, nul).toString("latin1") : "";
    if (keyword && !(keyword in out)) {
      if (type === "tEXt") out[keyword] = data.subarray(nul + 1).toString("latin1");
      if (type === "iTXt" && data[nul + 1] === 0) {
        // keyword \0 compression-flag method language \0 translated-keyword \0 text
        const language = data.indexOf(0, nul + 3);
        const translated = language < 0 ? -1 : data.indexOf(0, language + 1);
        if (translated >= 0) out[keyword] = data.subarray(translated + 1).toString("utf8");
      }
    }
    if (type === "IEND") break;
    offset = end;
  }
  return out;
}

export interface DesignGenerateInput {
  engine: DesignGeneratingEngine;
  prompt: string;
  /** The format's size: the image is generated at the nearest supported aspect ratio, then composed to the exact size. */
  width: number;
  height: number;
  references: Array<{ mimeType: "image/png" | "image/jpeg" | "image/webp"; bytes: Buffer }>;
}
export interface DesignGeneratedImage { bytes: Buffer; mimeType: DesignMimeType; model: string; text: string | null }
export type DesignImageGenerator = (input: DesignGenerateInput) => Promise<DesignGeneratedImage>;

/**
 * The gateway client. The key is read from its file on every call, so `space-admin-action design-key` rotating it needs no
 * API restart; without the file every engine answers DESIGN_ENGINE_UNAVAILABLE.
 */
export function createGatewayImageGenerator(options: { gatewayUrl: string; keyFile: string | null; fetchImpl?: typeof fetch; timeoutMs?: number }): DesignImageGenerator {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (input) => {
    const key = options.keyFile ? (await readFile(options.keyFile, "utf8").catch(() => "")).trim() : "";
    if (!key) throw new SpaceFeatureDisabledError("DESIGN_ENGINE_UNAVAILABLE", "Image generation needs the Design gateway key (space-admin-action design-key); templates still work.");
    const model = DESIGN_ENGINE_MODELS[input.engine];
    const longest = Math.max(input.width, input.height);
    let response: Response;
    try {
      response = await fetchImpl(`${options.gatewayUrl}/images/v1/generate`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model, prompt: input.prompt, aspectRatio: nearestDesignAspectRatio(input.width, input.height),
          ...(input.engine === "GPT_IMAGE" ? {} : { imageSize: longest > 1600 ? "2K" : "1K" }),
          referenceImages: input.references.map((reference) => ({ mimeType: reference.mimeType, base64: reference.bytes.toString("base64") }))
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 300_000)
      });
    } catch (error) {
      throw new SpaceFeatureDisabledError("DESIGN_ENGINE_UNAVAILABLE", `Space Gateway did not answer: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
    }
    const body = await response.json().catch(() => null) as { images?: Array<{ mimeType?: string; base64?: string }>; model?: string; text?: string | null; error?: { message?: string } } | null;
    if (!response.ok) {
      const message = body?.error?.message ?? `HTTP ${response.status}`;
      if (response.status === 401 || response.status === 403 || response.status === 404) throw new SpaceFeatureDisabledError("DESIGN_ENGINE_UNAVAILABLE", `Space Gateway refused the image request: ${message}`.slice(0, 300));
      throw new SpaceConflictError(`Image generation failed: ${message}`.slice(0, 300));
    }
    const image = body?.images?.[0];
    const bytes = Buffer.from(image?.base64 ?? "", "base64");
    const mimeType = sniffDesignMime(bytes);
    if (!mimeType || !mimeType.startsWith("image/")) throw new SpaceConflictError("Space Gateway returned no image.");
    return { bytes, mimeType, model: body?.model ?? model, text: body?.text ?? null };
  };
}
