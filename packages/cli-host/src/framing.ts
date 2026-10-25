import { Buffer } from "node:buffer";

const defaultMaximumFrameBytes = 8 * 1024 * 1024;

export function encodeLengthPrefixedJson(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > 0xffffffff) throw new Error("CLI host IPC frame exceeds the 32-bit length prefix.");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class LengthPrefixedJsonDecoder {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maximumFrameBytes = defaultMaximumFrameBytes) {}

  push(chunk: Buffer | Uint8Array): unknown[] {
    if (chunk.length) this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const values: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > this.maximumFrameBytes) {
        throw new Error(`CLI host IPC frame length ${length} is invalid.`);
      }
      if (this.buffer.length < length + 4) break;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      values.push(JSON.parse(payload.toString("utf8")));
    }
    return values;
  }
}
