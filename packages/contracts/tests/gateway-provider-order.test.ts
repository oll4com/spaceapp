import { describe, expect, it } from "vitest";
import { GATEWAY_DEFAULT_PROVIDER_ORDER, gatewayProviderOrderOf, gatewayProviderOrderSchema, nousModelMatchesProvider, nousSpaceModel, gatewayFreeKeyProviderOf } from "../src/index.js";

const on = (route: string, enabled = true) => ({ route, enabled });

describe("Space Gateway provider order", () => {
  it("puts the routes in order: subscriptions on, cloud credits off", () => {
    expect(GATEWAY_DEFAULT_PROVIDER_ORDER).toEqual([on("CLAUDE"), on("CODEX"), on("CLAUDE_OPENCODE"), on("ANTIGRAVITY"), on("ANTIGRAVITY_FLASH"), on("ANTIGRAVITY_CLAUDE"), on("BEDROCK", false), on("VERTEX", false)]);
    expect(gatewayProviderOrderSchema.safeParse(GATEWAY_DEFAULT_PROVIDER_ORDER).success).toBe(true);
  });

  it("gives a stored order and keeps the operator's choices", () => {
    const stored = [on("CODEX"), on("OPENROUTER"), on("CLAUDE"), on("CLAUDE_OPENCODE", false), on("ANTIGRAVITY"), on("OPENAI_API", false), on("DEEPSEEK", false)];
    expect(gatewayProviderOrderOf(stored)).toEqual([on("CODEX"), on("CLAUDE"), on("CLAUDE_OPENCODE", false), on("ANTIGRAVITY"), on("ANTIGRAVITY_FLASH"), on("ANTIGRAVITY_CLAUDE"), on("BEDROCK", false), on("VERTEX", false)]);
  });

  it("parses Space route models and matches native Antigravity argon vs flash", () => {
    expect(nousSpaceModel("gemini:gemini-4-argon-high")).toEqual({ route: "ANTIGRAVITY", model: "gemini-4-argon-high" });
    expect(nousSpaceModel("gemini:gemini-3.8-flash-high")).toEqual({ route: "ANTIGRAVITY_FLASH", model: "gemini-3.8-flash-high" });
    expect(nousSpaceModel("gemini-flash:gemini-3.8-flash-high")).toEqual({ route: "ANTIGRAVITY_FLASH", model: "gemini-3.8-flash-high" });
    expect(nousSpaceModel("claude:claude-sonnet-5-5")).toEqual({ route: "CLAUDE", model: "claude-sonnet-5-5" });
    expect(nousModelMatchesProvider("groq:llama-3.3-70b-versatile", "space")).toBe(false);
  });

  it("names the free key pool a saved Vault key joins by its label, and none for a paid pool, a password or two providers (operator 7/11)", () => {
    expect(gatewayFreeKeyProviderOf("Inception Labs API key (SpaceApp Gateway, free 100M tokens)")).toBe("INCEPTION");
    expect(gatewayFreeKeyProviderOf("Jina AI API key (free 10M tokens)")).toBe("JINA");
    // 7/11: a path in a label is not the provider (a Cloudflare admin key "(public-host ~/.gemini)" was offered as a Gemini key).
    expect(gatewayFreeKeyProviderOf("cloudflare GLOBAL API key, example.invalid account full admin (public-host ~/.gemini)")).toBeNull();
    expect(gatewayFreeKeyProviderOf("Gemini API key spaceappdv AI Studio proj space-gateway free tier")).toBe("GOOGLE_AI");
    expect(gatewayFreeKeyProviderOf("AMD Token Lab key")).toBe("AMD_TOKEN_LAB");
    expect(gatewayFreeKeyProviderOf("Groq free tier")).toBe("GROQ");
    expect(gatewayFreeKeyProviderOf("Mixedbread API key ($5)")).toBe("MIXEDBREAD");
    expect(gatewayFreeKeyProviderOf("AgentRouter key ($149.78)")).toBe("AGENTROUTER");
    expect(gatewayFreeKeyProviderOf("Free.ai API key (UNVERIFIED)")).toBe("FREEAI");
    expect(gatewayFreeKeyProviderOf("Azure OpenAI space-oll4-aoai (Sweden Central)")).toBe("AZURE_OPENAI");
    expect(gatewayFreeKeyProviderOf("Gemini free tier key")).toBe("GOOGLE_AI");
    expect(gatewayFreeKeyProviderOf("Z.AI API key (free GLM Flash)")).toBe("ZAI");
    expect(gatewayFreeKeyProviderOf("SiliconFlow key")).toBe("SILICONFLOW");
    expect(gatewayFreeKeyProviderOf("Mistral API key ntheogr@gmail.com space-gateway (free tier)")).toBe("MISTRAL");
    // 7/11: the cloud-credit Claude pools join too; their pools send nothing until the credit is recorded.
    expect(gatewayFreeKeyProviderOf("AWS Bedrock API key (Activate credits)")).toBe("BEDROCK");
    expect(gatewayFreeKeyProviderOf("Vertex AI service account key space-oll4")).toBe("VERTEX");
    for (const label of ["OpenAI API key (paid)", "DeepSeek key", "Mailed DB password", "Jina key for the Gemini test"]) expect(gatewayFreeKeyProviderOf(label)).toBeNull();
  });
});
