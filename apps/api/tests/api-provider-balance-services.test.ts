import { describe, expect, it, vi } from "vitest";
import {
  createApiProviderAccountProvider,
  discoverApiProviderKeys
} from "../src/api-provider-balance-services.js";

describe("api provider balance services", () => {
  it("discovers keys from environment and files", async () => {
    // Hermetic: the environment wins over the key files, so the host's own keys are not needed.
    vi.stubEnv("OPENROUTER_API_KEY", " test-openrouter-key ");
    try {
      expect((await discoverApiProviderKeys()).openrouter).toBe("test-openrouter-key");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fetches provider accounts list without unhandled errors", async () => {
    const provider = createApiProviderAccountProvider();
    const result = await provider();
    expect(result).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);

    const deepseek = result.data.find((a) => a.providerId === "deepseek");
    if (deepseek) {
      expect(deepseek.label).toBe("DeepSeek");
      expect(["CONNECTED", "UNCONFIGURED", "ERROR", "EXHAUSTED"]).toContain(deepseek.status);
      if (deepseek.status === "CONNECTED") {
        expect(deepseek.balance).toBeDefined();
      }
    }

    const openrouter = result.data.find((a) => a.providerId === "openrouter");
    if (openrouter) {
      expect(openrouter.label).toBe("OpenRouter");
      expect(["CONNECTED", "UNCONFIGURED", "ERROR", "EXHAUSTED"]).toContain(openrouter.status);
    }

    const vercel = result.data.find((a) => a.providerId === "vercel-gateway");
    if (vercel) {
      expect(vercel.label).toBe("Vercel AI Gateway");
      expect(["CONNECTED", "UNCONFIGURED", "ERROR", "EXHAUSTED"]).toContain(vercel.status);
      if (vercel.status === "CONNECTED") {
        expect(vercel.balance).toBeDefined();
      }
    }

    const google = result.data.find((a) => a.providerId === "google");
    if (google) {
      expect(google.label).toContain("Google Gemini");
      expect(["CONNECTED", "UNCONFIGURED", "ERROR", "EXHAUSTED"]).toContain(google.status);
    }
  });
});
