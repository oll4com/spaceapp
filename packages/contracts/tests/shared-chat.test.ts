import { describe, expect, it } from "vitest";
import {
  auditChainEntrySchema,
  auditVerifyResponseSchema,
  sendSharedChatMessageInputSchema,
  sharedChatMessageSchema,
  spaceAgentChatActionEnvelopeSchema,
  listSharedChatMessagesQuerySchema,
  listAuditChainQuerySchema
} from "../src/index.js";

describe("shared chat contracts", () => {
  it("accepts a complete shared chat message", () => {
    expect(
      sharedChatMessageSchema.parse({
        id: "shared_chat_msg:one",
        senderType: "agent",
        senderId: "pane:codex",
        senderLabel: "Codex (OpenAI)",
        roomId: "room:one",
        kind: "message",
        content: "Nightly backup ολοκληρώθηκε: OK",
        replyToId: null,
        metadata: {},
        createdAt: "2026-08-14T10:00:00.000Z"
      })
    ).toMatchObject({ senderType: "agent", kind: "message", content: "Nightly backup ολοκληρώθηκε: OK" });
  });

  it("defaults kind and metadata on the send contract", () => {
    expect(sendSharedChatMessageInputSchema.parse({ senderLabel: "operator", content: "hello" })).toEqual({
      senderLabel: "operator",
      content: "hello",
      kind: "message",
      metadata: {}
    });
  });

  it("accepts agent chat envelopes and rejects toolId/action mismatches", () => {
    const envelope = {
      version: 1,
      actions: [{ toolId: "chat:send", action: { type: "send", content: "progress report" } }]
    };
    expect(spaceAgentChatActionEnvelopeSchema.parse(envelope).actions).toHaveLength(1);
    expect(() =>
      spaceAgentChatActionEnvelopeSchema.parse({
        version: 1,
        actions: [{ toolId: "chat:read", action: { type: "send", content: "wrong pair" } }]
      })
    ).toThrow();
  });

  it("validates list query cursors", () => {
    expect(listSharedChatMessagesQuerySchema.parse({ limit: 50, before: "shared_chat_msg:one" })).toMatchObject({
      limit: 50,
      before: "shared_chat_msg:one"
    });
    expect(listAuditChainQuerySchema.parse({ beforeSeq: 12 }).beforeSeq).toBe(12);
  });
});

describe("audit chain contracts", () => {
  it("accepts a valid chain entry with genesis previous hash", () => {
    expect(
      auditChainEntrySchema.parse({
        seq: 1,
        action: "shared_chat.message_created",
        actor: "agent:pane:codex",
        targetType: "shared_chat_message",
        targetId: "shared_chat_msg:one",
        metadata: {},
        prevHash: "0".repeat(64),
        chainHash: "a".repeat(64),
        createdAt: "2026-08-14T10:00:00.000Z"
      })
    ).toMatchObject({ seq: 1, action: "shared_chat.message_created" });
  });

  it("rejects non-hex hashes", () => {
    expect(() =>
      auditChainEntrySchema.parse({
        seq: 1,
        action: "x",
        actor: "y",
        targetType: "",
        targetId: null,
        metadata: {},
        prevHash: "z".repeat(64),
        chainHash: "a".repeat(64),
        createdAt: "2026-08-14T10:00:00.000Z"
      })
    ).toThrow();
  });

  it("accepts the verify response shape", () => {
    expect(
      auditVerifyResponseSchema.parse({
        ok: true,
        entryCount: 3,
        verifiedThroughSeq: 3,
        firstTamperedSeq: null,
        message: "Audit chain verified through seq 3."
      })
    ).toMatchObject({ ok: true, entryCount: 3 });
  });
});
