import { describe, expect, it } from "vitest";
import { configuredDelegateModel, estimateLiveCost, parseLiveModelPolicy } from "../src/live-model-policy.js";

describe("Live model policy", () => {
  it("keeps an absent catalog empty instead of inventing prices", () => {
    const policy = parseLiveModelPolicy(undefined, undefined);
    expect(policy.models).toEqual([]);
    expect(policy.mode).toBe("balanced");
    expect(policy.dailyBudgetUsd).toBeNull();
    expect(policy.source).toBe("empty");
  });

  it("rejects malformed operator metadata closed", () => {
    const policy = parseLiveModelPolicy("{not-json", "12");
    expect(policy.models).toEqual([]);
    expect(policy.dailyBudgetUsd).toBe(12);
    expect(policy.revision).toBe("invalid");
  });

  it("estimates only when the configured price dimensions are known", () => {
    const [model] = parseLiveModelPolicy(JSON.stringify([{
      id: "google/gemini-live",
      provider: "google",
      protocol: "gemini-live",
      inputUsdPer1kTokens: 0.001,
      outputUsdPer1kTokens: 0.002,
      audioUsdPerMinute: 0.03
    }])).models;
    expect(model).toBeDefined();
    expect(estimateLiveCost({ model: model!, inputTokens: 1000, outputTokens: 500, audioMinutes: 2 })).toBeCloseTo(0.062);
  });

  it("returns unknown cost when a provider omits pricing", () => {
    const [model] = parseLiveModelPolicy(JSON.stringify([{
      id: "vercel/selected",
      provider: "vercel",
      protocol: "responses"
    }])).models;
    expect(estimateLiveCost({ model: model!, inputTokens: 100 })).toBeNull();
  });

  it("uses configured delegate models without changing provider fallback behavior", () => {
    const policy = parseLiveModelPolicy(JSON.stringify([
      { id: "google/gemini-flash-cheap", provider: "google", protocol: "responses" },
      { id: "disabled", provider: "openai", protocol: "responses", enabled: false }
    ]));
    expect(configuredDelegateModel(policy, "google", "default-google")).toBe("google/gemini-flash-cheap");
    expect(configuredDelegateModel(policy, "openai", "default-openai")).toBe("default-openai");
  });

  it("selects only operator-configured models for the active cost tier", () => {
    const policy = parseLiveModelPolicy(JSON.stringify([
      { id: "google/economy", provider: "google", protocol: "responses", tier: "economy" },
      { id: "google/quality", provider: "google", protocol: "responses", tier: "quality" },
      { id: "google/balanced", provider: "google", protocol: "responses", tier: "balanced" }
    ]), undefined, "economy");
    expect(configuredDelegateModel(policy, "google", "fallback", "economy")).toBe("google/economy");
    expect(configuredDelegateModel(policy, "google", "fallback", "quality")).toBe("google/quality");
    expect(configuredDelegateModel(policy, "google", "fallback", "balanced")).toBe("google/balanced");
    expect(configuredDelegateModel(policy, "openai", "fallback", "economy")).toBe("fallback");
  });

  it("accepts only the three operator cost modes and defaults safely", () => {
    expect(parseLiveModelPolicy(undefined, undefined, "economy").mode).toBe("economy");
    expect(parseLiveModelPolicy(undefined, undefined, "quality").mode).toBe("quality");
    expect(parseLiveModelPolicy(undefined, undefined, "not-a-mode").mode).toBe("balanced");
  });
});
