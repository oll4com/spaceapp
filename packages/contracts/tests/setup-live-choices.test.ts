import { describe, expect, it } from "vitest";
import { setupConnectionChoiceSchema } from "../src/index.js";

describe("Live setup choice identifiers", () => {
  it("preserves supported composite model IDs and provider voice capitalization", () => {
    for (const choice of [
      { featureId: "pane:live", providerId: "vercel", modelId: "openai/gpt-live-1", voiceId: "alloy" },
      { featureId: "pane:live", providerId: "amazon", modelId: "amazon.nova-2-sonic-v1:0", voiceId: "en-US-Jenny" },
      { featureId: "pane:live", providerId: "google", modelId: "gemini-3.8-live", voiceId: "Aoede" }
    ]) expect(setupConnectionChoiceSchema.safeParse(choice).success).toBe(true);
    expect(setupConnectionChoiceSchema.safeParse({ featureId: "pane:live", modelId: "model with spaces" }).success).toBe(false);
    expect(setupConnectionChoiceSchema.safeParse({ featureId: "pane:live", voiceId: "voice\nsecret" }).success).toBe(false);
  });
});
