import { describe, expect, it } from "vitest";
import {
  isLikelyModelDescriptor,
  isSameModel,
  normalizeModelDisplay,
  resolveStepModel
} from "../src/features/terminal-pane/plan-model-resolver.js";

describe("plan-model-resolver", () => {
  describe("isLikelyModelDescriptor", () => {
    it("identifies model strings with reasoning or provider", () => {
      expect(isLikelyModelDescriptor("gpt-6.1-sol / high")).toBe(true);
      expect(isLikelyModelDescriptor("gpt-6-astra / high")).toBe(true);
      expect(isLikelyModelDescriptor("opencode/deepseek-v4-flash-free")).toBe(true);
      expect(isLikelyModelDescriptor("claude-3-5-sonnet")).toBe(true);
      expect(isLikelyModelDescriptor("gemini-2.5-pro")).toBe(true);
    });

    it("rejects non-model stage tags", () => {
      expect(isLikelyModelDescriptor("WIP")).toBe(false);
      expect(isLikelyModelDescriptor("DONE")).toBe(false);
      expect(isLikelyModelDescriptor("COMPLETED")).toBe(false);
      expect(isLikelyModelDescriptor("PENDING")).toBe(false);
      expect(isLikelyModelDescriptor("Stage 1")).toBe(false);
    });
  });

  describe("normalizeModelDisplay", () => {
    it("replaces slash separators with center dot", () => {
      expect(normalizeModelDisplay("gpt-6.1-sol / high")).toBe("gpt-6.1-sol · high");
      expect(normalizeModelDisplay("gpt-6-luna / medium")).toBe("gpt-6-luna · medium");
    });
  });

  describe("isSameModel", () => {
    it("detects same model formatted differently", () => {
      expect(isSameModel("gpt-6.1-sol / high", "gpt-6.1-sol · high")).toBe(true);
      expect(isSameModel("gpt-6-astra", "gpt-6-astra · high")).toBe(true);
      expect(isSameModel("sol", "gpt-6.1-sol · high")).toBe(true);
      expect(isSameModel("gpt-6-astra", "gemini-2.5-pro")).toBe(false);
    });
  });

  describe("resolveStepModel", () => {
    it("extracts model from title brackets", () => {
      const step = {
        title: "02. Upstream pin and integration contract [gpt-6-astra / high]",
        agent: null,
        notes: null
      };
      expect(resolveStepModel(step, { minimumModel: "gpt-6.1-sol", minimumReasoning: "high" })).toBe(
        "gpt-6-astra · high"
      );
    });

    it("extracts model from notes if title has none", () => {
      const step = {
        title: "Setup infrastructure",
        agent: null,
        notes: "Recommended model: gpt-6-astra; reasoning: high. Dependencies: none."
      };
      expect(resolveStepModel(step, { minimumModel: "gpt-6.1-sol", minimumReasoning: "medium" })).toBe(
        "gpt-6-astra · high"
      );
    });

    it("uses step.agent if step.agent is a model descriptor", () => {
      const step = {
        title: "Database schema migration",
        agent: "gpt-6.1-sol / high",
        notes: null
      };
      expect(resolveStepModel(step, null)).toBe("gpt-6.1-sol · high");
    });

    it("ignores runtime failure disclaimer in step.agent and falls back to plan minimumModel", () => {
      const step = {
        title: "Audit and acceptance baseline",
        agent: "Codex /root (runtime model ID unavailable)",
        notes: null
      };
      expect(resolveStepModel(step, { minimumModel: "gpt-6.1-sol", minimumReasoning: "high" })).toBe(
        "gpt-6.1-sol · high"
      );
    });

    it("falls back to plan minimumModel when step has no override", () => {
      const step = {
        title: "Verification and closure",
        agent: null,
        notes: null
      };
      expect(resolveStepModel(step, { minimumModel: "opencode/deepseek-v4-flash-free", minimumReasoning: null })).toBe(
        "opencode/deepseek-v4-flash-free"
      );
    });
  });
});
