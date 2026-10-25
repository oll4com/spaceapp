import { describe, expect, it } from "vitest";
import { AUTO_ROUTE_POLICY_VERSION, decideAutoRoute, type AutoRouteCandidate, type AutoRouteTask } from "../src/index.js";

const at = "2026-10-11T08:00:00.000Z";
const candidate = (modelId: string, extra: Partial<AutoRouteCandidate> = {}): AutoRouteCandidate => ({ modelId, inputModalities: ["text", "image"],
  contextWindow: 272_000, reasoningEfforts: ["low", "medium", "high", "xhigh"], isDefault: false, quota: "UNKNOWN", ...extra });
const task = (extra: Partial<AutoRouteTask> = {}): AutoRouteTask => ({ promptChars: 40, modalities: ["text"], attachments: 0, attachmentChars: 0,
  toolGateway: true, background: false, declaredChecks: false, ...extra });
const prices = { version: "prices-test", currency: "USD" as const, prices: [
  { model: "big", inputPerMillion: 5, outputPerMillion: 20 }, { model: "small", inputPerMillion: 0.5, outputPerMillion: 2 }] };
const userDefault = { model: null, reasoning: null, source: "RUNTIME_DEFAULT" as const };

describe("Auto routing policy (shadow)", () => {
  it("sends short requests to the cheapest priced model that fits, with low reasoning", () => {
    const route = decideAutoRoute({ task: task(), candidates: [candidate("big", { isDefault: true }), candidate("small")], prices, actual: userDefault, at });
    expect(route).toMatchObject({ policyVersion: AUTO_ROUTE_POLICY_VERSION, mode: "SHADOW", tier: "LIGHT", choice: { model: "small", reasoning: "low" },
      agreesWithActual: null });
    expect(route.reasons.join(" ")).toMatch(/cheapest priced model.*prices-test/);
  });

  it("keeps the default model without prices and raises reasoning for checked, background or large work", () => {
    const candidates = [candidate("big", { isDefault: true }), candidate("small")];
    expect(decideAutoRoute({ task: task(), candidates, prices: null, actual: userDefault, at }).choice).toEqual({ model: "big", reasoning: "low" });
    expect(decideAutoRoute({ task: task({ declaredChecks: true }), candidates, prices, actual: userDefault, at })).toMatchObject({ tier: "DEEP", choice: { model: "big", reasoning: "high" } });
    expect(decideAutoRoute({ task: task({ background: true }), candidates, prices, actual: userDefault, at }).tier).toBe("DEEP");
    expect(decideAutoRoute({ task: task({ promptChars: 2_000 }), candidates, prices, actual: userDefault, at })).toMatchObject({ tier: "STANDARD", choice: { reasoning: "medium" } });
    expect(decideAutoRoute({ task: task({ attachments: 1, attachmentChars: 400_000 }), candidates, prices, actual: userDefault, at }).tier).toBe("DEEP");
  });

  it("excludes models that cannot take the input and says why", () => {
    const route = decideAutoRoute({ task: task({ modalities: ["text", "image"], attachments: 1 }), prices, actual: userDefault, at, candidates: [
      candidate("blind", { inputModalities: ["text"], isDefault: true }), candidate("unknown", { inputModalities: null }),
      candidate("tiny", { contextWindow: 4_000 }), candidate("spent", { quota: "EXHAUSTED" }), candidate("vision", { reasoningEfforts: ["medium", "high"] })] });
    expect(route.choice).toEqual({ model: "vision", reasoning: "medium" });
    expect(route.excluded).toEqual([{ model: "blind", reason: "It does not accept images." }, { model: "unknown", reason: "The catalog does not say it accepts images." },
      { model: "tiny", reason: "Its context window is too small for this input." }, { model: "spent", reason: "Its usage quota is exhausted." }]);
    const none = decideAutoRoute({ task: task({ modalities: ["text", "image"], attachments: 1 }), candidates: [candidate("blind", { inputModalities: ["text"] })], prices, actual: userDefault, at });
    expect(none).toMatchObject({ choice: null, agreesWithActual: null });
  });

  it("compares with what the user chose without changing it", () => {
    const candidates = [candidate("big", { isDefault: true }), candidate("small")];
    const chosen = { model: "big", reasoning: "xhigh", source: "USER_SELECTED" as const };
    const route = decideAutoRoute({ task: task({ promptChars: 2_000 }), candidates, prices, actual: chosen, at });
    expect(route.actual).toEqual(chosen);
    expect(route.agreesWithActual).toBe(false);
    expect(decideAutoRoute({ task: task({ promptChars: 2_000 }), candidates, prices, actual: { ...chosen, reasoning: null }, at }).agreesWithActual).toBe(true);
  });
});

describe("Auto shadow summary", () => {
  it("relates decisions to outcomes, uses the runtime-reported model and keeps unknown costs unknown", async () => {
    const { summarizeAutoRouteShadow, transitionAgentRunLedger } = await import("../src/index.js");
    const route = (tier: "LIGHT" | "DEEP", choice: string | null, actual: string | null, agrees: boolean | null) => ({ policyVersion: AUTO_ROUTE_POLICY_VERSION,
      mode: "SHADOW" as const, decidedAt: at, tier, estimatedInputTokens: 7_000, choice: choice ? { model: choice, reasoning: "low" } : null, reasons: ["x"], excluded: [],
      actual: { model: actual, reasoning: null, source: actual ? "USER_SELECTED" as const : "RUNTIME_DEFAULT" as const }, agreesWithActual: agrees });
    const usage = { status: "MEASURED" as const, inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 100_000, reasoningOutputTokens: 0,
      totalTokens: 1_100_000, source: "codex", observedAt: at, model: "big" };
    const summary = summarizeAutoRouteShadow([
      { autoRoute: route("LIGHT", "small", null, null), status: "COMPLETED", runtimeModelAtStart: "big",
        ledger: transitionAgentRunLedger({ status: "COMPLETED", at, usage, cost: { status: "ESTIMATED", reason: null, amountUsd: 7, source: "tokens × prices-test", observedAt: at, priceCatalogVersion: "prices-test" } }) },
      { autoRoute: route("DEEP", "big", "big", true), status: "FAILED", runtimeModelAtStart: "big", ledger: null },
      { autoRoute: route("DEEP", null, null, null), status: "COMPLETED", runtimeModelAtStart: null, ledger: null }
    ], prices);
    expect(summary).toMatchObject({ applied: false, runs: 3, noFit: 1, wouldChoose: { small: 1, big: 1 },
      byTier: { LIGHT: { runs: 1, differ: 1 }, DEEP: { runs: 2, agree: 1, unknown: 1 } },
      outcomes: { agree: { runs: 1, failed: 1 }, differ: { runs: 1, completed: 1 }, unknown: { runs: 1 } },
      usage: { measured: 1, unknown: 2 }, cost: { pricedRuns: 1, estimatedUsd: 7, unknownRuns: 2,
        sameTokenEstimateForAutoChoice: { runs: 1, usd: 0.7, priceCatalogVersion: "prices-test" } } });
  });
});
