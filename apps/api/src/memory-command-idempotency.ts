import { createHash } from "node:crypto";
import { memoryCommandIdempotencyKeySchema } from "@space/contracts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Memory command request values must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item ?? null)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Memory command request contains an unsupported value.");
}

export function hashMemoryIdempotencyKey(rawHeader: unknown): string {
  const normalized = memoryCommandIdempotencyKeySchema.parse(rawHeader);
  return sha256(normalized);
}

export function hashMemoryCommandRequest(commandScope: string, request: unknown): string {
  return sha256(`${commandScope}\u0000${stableJson(request)}`);
}

export function buildMemoryCommandResourceId(
  prefix: string,
  commandScope: string,
  actorKey: string,
  idempotencyKeyHash: string
): string {
  return `${prefix}:${sha256(`${commandScope}\u0000${actorKey}\u0000${idempotencyKeyHash}`).slice(0, 32)}`;
}
