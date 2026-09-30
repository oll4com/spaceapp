import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  JEV_MODEL_ID,
  createRoomDecisionsClient,
  jevDecisionsEndpoint
} from "../room-decisions.js";

function mockFetch(payload: unknown, status = 200) {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  })) as unknown as typeof fetch;
}

describe("jevDecisionsEndpoint", () => {
  it("maps /api/v1 base to /api/alpha/decisions", () => {
    expect(jevDecisionsEndpoint("https://openrouter.ai/api/v1")).toBe(
      "https://openrouter.ai/api/alpha/decisions"
    );
  });

  it("keeps root base and full endpoint stable", () => {
    expect(jevDecisionsEndpoint("https://openrouter.ai")).toBe(
      "https://openrouter.ai/api/alpha/decisions"
    );
    expect(jevDecisionsEndpoint("https://openrouter.ai/api/alpha/decisions")).toBe(
      "https://openrouter.ai/api/alpha/decisions"
    );
  });
});

describe("createRoomDecisionsClient mocked", () => {
  it("parses noul/choice/score answers without network", async () => {
    const client = createRoomDecisionsClient({
      baseUrl: "https://openrouter.ai",
      apiKey: "test-key",
      fetch: mockFetch({
        model: "typesafe/jev-1.13-20260917",
        answers: {
          is_urgent: { type: "noul", noul: 0.95 },
          department: { type: "choice", choice: "billing", confidence: 0.82 },
          frustration: { type: "score", score: 1.04, confidence: 0.94 }
        },
        usage: { input_tokens: 427, output_tokens: 73, cost: 0.000017934 }
      })
    });

    const result = await client.decide({
      state: "Help! My payouts have been failing for 3 days.",
      questions: {
        is_urgent: {
          type: "noul",
          instructions: "Does this message convey urgency?",
          criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" }
        },
        department: {
          type: "choice",
          instructions: "Which team should handle this?",
          criteria: { billing: "Payments", technical: "Bugs", sales: "Pricing" }
        },
        frustration: {
          type: "score",
          instructions: "How frustrated is the customer?",
          criteria: ["Calm", "Frustrated", "Very angry"]
        }
      }
    });

    expect(result.model).toContain("typesafe/jev-1.13");
    expect(result.answers["is_urgent"]).toMatchObject({ noul: 0.95 });
    expect(result.usage.inputTokens).toBe(427);
    expect(result.usage.cost).toBeCloseTo(0.000017934, 9);
  });

  it("rejects chat-style array questions before any fetch", async () => {
    let called = false;
    const client = createRoomDecisionsClient({
      baseUrl: "https://openrouter.ai",
      apiKey: "test-key",
      fetch: ((async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({ answers: {} }) };
      }) as unknown) as typeof fetch
    });

    await expect(
      client.decide({ state: "x", questions: [] as unknown as never })
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("throws without credentials", async () => {
    const client = createRoomDecisionsClient({ baseUrl: null, apiKey: null });
    await expect(client.decide({ state: "x", questions: {} })).rejects.toThrow(
      "not configured"
    );
  });
});

// Live proof: runs only with SPACE_JEV_LIVE=1 and a readable OpenRouter token.
// Does not commit secrets; reads the operator token file at runtime.
describe("jev live proof via OpenRouter", () => {
  it.skipIf(process.env["SPACE_JEV_LIVE"] !== "1")("returns typed decisions in under 15s", async () => {
    const tokenPath =
      process.env["SPACE_JEV_TOKEN_FILE"] ?? "/var/lib/spaceapp-user/.config/opencode/openrouter.token";
    const apiKey = (await readFile(tokenPath, "utf8")).trim();
    expect(apiKey.length).toBeGreaterThan(10);

    const client = createRoomDecisionsClient({
      baseUrl: "https://openrouter.ai",
      apiKey,
      model: JEV_MODEL_ID,
      timeoutMs: 15_000
    });

    const result = await client.decide({
      state: "Help! My payouts have been failing for 3 days.",
      questions: {
        is_urgent: {
          type: "noul",
          instructions: "Does this message convey urgency?",
          criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" }
        },
        department: {
          type: "choice",
          instructions: "Which team should handle this?",
          criteria: {
            billing: "Payments, invoicing, refunds",
            technical: "Bugs, outages, integrations",
            sales: "Pricing, upgrades, new accounts"
          }
        },
        frustration: {
          type: "score",
          instructions: "How frustrated is the customer?",
          criteria: ["Calm", "Frustrated", "Very angry"]
        }
      }
    });

    expect(result.model).toContain("typesafe/jev-1.13");
    const urgent = result.answers["is_urgent"] as { noul: number };
    const dept = result.answers["department"] as { choice: string };
    expect(urgent.noul).toBeGreaterThan(0.5);
    expect(["billing", "technical", "sales"]).toContain(dept.choice);
    expect(result.latencyMs).toBeLessThan(15_000);
    expect(result.usage.inputTokens ?? 0).toBeGreaterThan(0);
  }, 20_000);
});
