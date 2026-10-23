import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { History } from "@temporalio/worker";

// The lockfile installs separate protobufjs copies beside common and proto.
// protobufjs' proto-JSON helpers require a Type from their own module instance.
// Resolve both from the proto package, rather than changing production deps or
// passing a Type across copies through common/lib/proto-utils.
const require = createRequire(import.meta.url);
const protoRequire = createRequire(require.resolve("@temporalio/proto"));
const { temporal } = protoRequire("@temporalio/proto");
const { fromJson, toJson } = protoRequire("protobufjs/ext/protojson");
const historyType = temporal.api.history.v1.History;
const recordingRoot = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/[/\\]+$/, "");
const syntheticRoot = "/synthetic-spaceapp";

type MessageType = {
  fullName: string;
  fieldsArray: {
    name: string;
    repeated: boolean;
    map: boolean;
    resolvedType?: MessageType;
    resolve(): unknown;
  }[];
};

function normalizeFailureStacks(message: Record<string, unknown>, type: MessageType, frameRoot: RegExp): void {
  if (type.fullName === ".temporal.api.failure.v1.Failure" && typeof message.stackTrace === "string") {
    message.stackTrace = message.stackTrace.replace(frameRoot, (_, prefix: string) => prefix + syntheticRoot);
  }
  // Follow the protobuf schema, never arbitrary keys inside encoded payloads.
  for (const field of type.fieldsArray) {
    field.resolve();
    const childType = field.resolvedType;
    const value = message[field.name];
    if (!childType?.fieldsArray || value == null) continue;
    const children = field.repeated ? value as unknown[]
      : field.map ? Object.values(value) : [value];
    for (const child of children) normalizeFailureStacks(child as Record<string, unknown>, childType, frameRoot);
  }
}

export function decodeHistory(json: unknown): History {
  return fromJson(historyType, json, { ignoreUnknownFields: true });
}

export function encodeHistory(history: History, checkoutRoot = recordingRoot): string {
  // Clone even protobuf message instances: fromObject alone can return its input.
  const message = historyType.decode(historyType.encode(historyType.fromObject(history)).finish());
  const root = checkoutRoot.replace(/[/\\]+$/, "");
  assert(root.length > 0, "A non-root checkout directory is required for stack normalization");
  const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match only the location in a V8 stack frame, preserving messages and paths
  // outside this exact checkout. Failure stacks are workflow-visible data.
  const frameRoot = new RegExp(
    `^([\\t ]+at (?:[^\\r\\n]*\\()?(?:file:\\/\\/)?)${escapedRoot}(?=[/\\\\][^\\r\\n]*:\\d+:\\d+\\)?\\r?$)`,
    "gm",
  );
  normalizeFailureStacks(message, historyType, frameRoot);
  const json = toJson(historyType, message);
  // Prove JSON serialization preserves the normalized protobuf message.
  assert.deepEqual(historyType.encode(decodeHistory(json)).finish(), historyType.encode(message).finish());
  return JSON.stringify(json, null, 2) + "\n";
}
