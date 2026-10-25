import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getStreamingBotLlmConfig } from "../src/orchestrator.js";
import { resolveStreamingBotModel, streamingBotModelOptions } from "../src/model-selection.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function config(baseUrl = "http://127.0.0.1:4920/v1") {
  const root = await mkdtemp(join(tmpdir(), "space-bot-key-"));
  roots.push(root);
  await writeFile(join(root, "bot.key"), "sk-sgw-test\n", { mode: 0o640 });
  return getStreamingBotLlmConfig({ SPACE_STREAMING_BOT_ENABLED: "true", SPACE_STREAMING_BOT_BASE_URL: baseUrl,
    SPACE_STREAMING_BOT_KEY_FILE: join(root, "bot.key"), SPACE_STREAMING_BOT_KEY_NAME: "space-streaming-bot" });
}

describe("streaming bot model routes", () => {
  it("offers Claude and OpenAI API models through Space Gateway and resolves each to its protocol and URL", async () => {
    const ready = await config();
    expect(streamingBotModelOptions(ready).map((option) => `${option.providerId}/${option.modelId}`)).toEqual([
      "gateway-claude/claude-haiku-5-5", "gateway-claude/claude-sonnet-5-5",
      "gateway-openai/gpt-5.4-mini", "gateway-openai/gpt-5-mini", "gateway-openai/gpt-4.1-mini"
    ]);
    expect(resolveStreamingBotModel({ kind: "API", providerId: "gateway-claude", modelId: "claude-haiku-5-5" }, ready))
      .toEqual({ modelId: "claude-haiku-5-5", route: { protocol: "anthropic", url: "http://127.0.0.1:4920/v1/messages" }, errorCode: null });
    expect(resolveStreamingBotModel({ kind: "API", providerId: "gateway-openai", modelId: "gpt-5.4-mini" }, ready).route)
      .toEqual({ protocol: "openai", url: "http://127.0.0.1:4920/pools/openai/v1/chat/completions" });
    expect(resolveStreamingBotModel({ kind: "API", providerId: "gateway-claude", modelId: "gpt-5.4-mini" }, ready).errorCode).toBe("MODEL_NOT_IN_CATALOG");
    expect(resolveStreamingBotModel(null, ready).errorCode).toBe("MODEL_NOT_SELECTED");
  });

  it("marks every route unavailable until the bot's key is set up", () => {
    const missing = getStreamingBotLlmConfig({});
    expect(streamingBotModelOptions(missing).every((option) => !option.available)).toBe(true);
    expect(resolveStreamingBotModel({ kind: "API", providerId: "gateway-claude", modelId: "claude-haiku-5-5" }, missing).errorCode).toBe("MODEL_UNAVAILABLE");
  });
});
