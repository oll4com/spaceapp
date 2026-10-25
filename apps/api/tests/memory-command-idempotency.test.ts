import { describe, expect, it } from "vitest";
import {
  buildMemoryCommandResourceId,
  hashMemoryCommandRequest,
  hashMemoryIdempotencyKey
} from "../src/memory-command-idempotency.js";

describe("Memory command idempotency", () => {
  it("hashes bounded keys immediately and derives stable identities without exposing the raw key", () => {
    const rawKey = "memory-command:stable-retry";
    const keyHash = hashMemoryIdempotencyKey(rawKey);
    const resourceId = buildMemoryCommandResourceId(
      "memory_change",
      "memory.change_set.create",
      "user:operator",
      keyHash
    );

    expect(keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(resourceId).toMatch(/^memory_change:[a-f0-9]{32}$/);
    expect(`${keyHash}${resourceId}`).not.toContain(rawKey);
    expect(buildMemoryCommandResourceId(
      "memory_change",
      "memory.change_set.create",
      "user:operator",
      hashMemoryIdempotencyKey(`  ${rawKey}  `)
    )).toBe(resourceId);
  });

  it("hashes validated request objects canonically", () => {
    expect(hashMemoryCommandRequest("memory.change_set.create", { kind: "EDIT", ids: ["a", "b"] }))
      .toBe(hashMemoryCommandRequest("memory.change_set.create", { ids: ["a", "b"], kind: "EDIT" }));
    expect(hashMemoryCommandRequest("memory.change_set.create", { kind: "EDIT" }))
      .not.toBe(hashMemoryCommandRequest("memory.change_set.create", { kind: "ARCHIVE" }));
  });
});
