import { describe, expect, it } from "vitest";
import { agentRunExecutionContextSchema } from "../src/schemas.js";

const legacy = { traceId: "trace:test", modelConfigId: null, providerId: null, providerName: null,
  requestedModel: null, requestedReasoning: null };
const file = { artifactId: "artifact:test", name: "file.pdf", mimeType: "application/pdf", byteSize: 1234, sha256: "a".repeat(64) };

describe("Chat attachment receipts", () => {
  it("keeps legacy unknown distinct from an explicit empty list and preserves saved file evidence", () => {
    expect(agentRunExecutionContextSchema.parse(legacy).attachments).toBeUndefined();
    expect(agentRunExecutionContextSchema.parse({ ...legacy, attachments: [] }).attachments).toEqual([]);
    expect(agentRunExecutionContextSchema.parse({ ...legacy, attachments: [file] }).attachments).toEqual([file]);
  });
  it("rejects an oversized list or invalid saved evidence", () => {
    for (const attachments of [Array(9).fill(file), [{ ...file, byteSize: -1 }], [{ ...file, sha256: "unknown" }], [{ ...file, name: "x".repeat(513) }]]) {
      expect(agentRunExecutionContextSchema.safeParse({ ...legacy, attachments }).success).toBe(false);
    }
  });
});
