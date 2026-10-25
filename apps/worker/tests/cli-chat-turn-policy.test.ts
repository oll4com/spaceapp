import { describe, expect, it } from "vitest";
import {
  cliChatTurnRuntimeIdsFromEnv,
  isCliChatQuotaError,
  isCliChatTurnProviderId
} from "../src/turn-runtime-policy.js";

describe("cliChatTurnRuntimeIdsFromEnv", () => {
  it("defaults to the full contracts chat runtime list", () => {
    const ids = cliChatTurnRuntimeIdsFromEnv({});
    for (const runtimeId of [
      "cli:claude", "cli:gemini", "cli:qwen", "cli:kimi", "cli:grok",
      "cli:deepseek", "cli:cursor", "cli:copilot", "cli:autohand", "cli:hermes"
    ]) {
      expect(ids.has(runtimeId)).toBe(true);
    }
  });

  it("honors the SPACE_CLI_CHAT_TURN_RUNTIME_IDS override", () => {
    const ids = cliChatTurnRuntimeIdsFromEnv({ SPACE_CLI_CHAT_TURN_RUNTIME_IDS: "cli:kimi, cli:grok" });
    expect([...ids].sort()).toEqual(["cli:grok", "cli:kimi"]);
  });

  it("keeps workflow defaults deterministic instead of reading the host process environment", () => {
    const previous = process.env.SPACE_CLI_CHAT_TURN_RUNTIME_IDS;
    process.env.SPACE_CLI_CHAT_TURN_RUNTIME_IDS = "cli:grok";
    try {
      const ids = cliChatTurnRuntimeIdsFromEnv();
      expect(ids.has("cli:kimi")).toBe(true);
      expect(ids.has("cli:hermes")).toBe(true);
      expect(isCliChatTurnProviderId("cli:kimi")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SPACE_CLI_CHAT_TURN_RUNTIME_IDS;
      else process.env.SPACE_CLI_CHAT_TURN_RUNTIME_IDS = previous;
    }
  });
});

describe("isCliChatTurnProviderId", () => {
  it("accepts every chat-capable CLI runtime by default", () => {
    expect(isCliChatTurnProviderId("cli:kimi", {})).toBe(true);
    expect(isCliChatTurnProviderId("cli:claude", {})).toBe(true);
    expect(isCliChatTurnProviderId("cli:hermes", {})).toBe(true);
  });

  it("rejects unknown or empty provider ids", () => {
    expect(isCliChatTurnProviderId(null, {})).toBe(false);
    expect(isCliChatTurnProviderId("codex", {})).toBe(false);
    expect(isCliChatTurnProviderId("cli:unknown", {})).toBe(false);
  });
});

describe("isCliChatQuotaError", () => {
  it("matches provider quota/credit exhaustion messages", () => {
    expect(isCliChatQuotaError("[API Error: 402 Insufficient credits. Add more using https://openrouter.ai]")).toBe(true);
    expect(isCliChatQuotaError("403 chat pre-consumed quota failed, user quota: $0.21")).toBe(true);
    expect(isCliChatQuotaError("You've reached your usage limit for this billing cycle.")).toBe(true);
    expect(isCliChatQuotaError("cli:kimi has no available tokens/quota right now.")).toBe(true);
  });

  it("does not match ordinary errors or answers", () => {
    expect(isCliChatQuotaError("command not found")).toBe(false);
    expect(isCliChatQuotaError("The account balance inquiry feature works.")).toBe(false);
    expect(isCliChatQuotaError("")).toBe(false);
  });
});
