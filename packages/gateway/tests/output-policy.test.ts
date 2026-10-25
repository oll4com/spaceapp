import { describe, expect, it } from "vitest";
import { defaultGatewaySettings } from "@space/db";
import type { GatewaySettings } from "@space/contracts";
import {
  INTERNAL_KEY_NAME, outputPolicyText, requestOutputPolicy, withAnthropicOutputPolicy, withGeminiOutputPolicy, withResponsesOutputPolicy
} from "../src/compression/output-policy.js";
import { effectiveCompression, requestCompressionMode } from "../src/compression/provider-settings.js";

const settings = (patch: Partial<GatewaySettings> = {}): GatewaySettings => ({ ...defaultGatewaySettings, updatedAt: new Date(0).toISOString(), ...patch });
const key = (patch: { name?: string; outputPolicyOverride?: "OFF" | "CONCISE" | "LEAN" | "BOTH" | null } = {}) => ({ name: "Claude Code", outputPolicyOverride: null, ...patch });

describe("per-provider compression settings", () => {
  it("overlays a provider's entry on the global settings and leaves the output policy off by default", () => {
    const global = settings({ compressionMode: "ON", compressionProfile: "TOKEN", compressionCodeText: "ON", compressionTimeBudgetMs: 250,
      compressionProviders: { CLAUDE: { mode: "OFF", outputPolicy: "LEAN" }, CODEX: { profile: "CACHE", timeBudgetMs: 400 } } });
    expect(effectiveCompression(global, "CLAUDE")).toEqual({ mode: "OFF", profile: "TOKEN", codeText: "ON", timeBudgetMs: 250, outputPolicy: "LEAN" });
    expect(effectiveCompression(global, "CODEX")).toEqual({ mode: "ON", profile: "CACHE", codeText: "ON", timeBudgetMs: 400, outputPolicy: "OFF" });
    expect(effectiveCompression(global, "ANTIGRAVITY")).toEqual({ mode: "ON", profile: "TOKEN", codeText: "ON", timeBudgetMs: 250, outputPolicy: "OFF" });
  });

  it("lets the off header win over a key override, and a key override over the provider", () => {
    const effective = effectiveCompression(settings({ compressionProviders: { CLAUDE: { mode: "OFF" } } }), "CLAUDE");
    expect(requestCompressionMode(effective, null, undefined)).toBe("OFF");
    expect(requestCompressionMode(effective, "ON", null)).toBe("ON");
    expect(requestCompressionMode(effective, "ON", "Off")).toBe("OFF");
  });
});

describe("output policy texts", () => {
  it("starts every block with its stable version line; BOTH is concise then lean; OFF adds nothing", () => {
    const lean = outputPolicyText("LEAN")!;
    const concise = outputPolicyText("CONCISE")!;
    expect(lean.startsWith("[Space Gateway output policy v1: lean]\n\nYou are a lazy senior developer.")).toBe(true);
    expect(lean).toContain("Never cut: validation at trust boundaries");
    expect(concise.startsWith("[Space Gateway output policy v1: concise]\n\nRespond terse.")).toBe(true);
    expect(outputPolicyText("BOTH")).toBe(`${concise}\n\n${lean}`);
    expect(outputPolicyText("OFF")).toBeNull();
    // The rules never name the trademarked project nor point at slash commands a gateway cannot serve.
    for (const text of [lean, concise]) {
      expect(text).not.toMatch(/caveman|ponytail/i);
      expect(text).not.toMatch(/(^|\s)\/[a-z]+(\s|$)/m);
    }
    expect(outputPolicyText("LEAN")).toBe(lean);
  });

  it("applies only to the measured clients, never to the internal key or with the off header; a key override wins", () => {
    const base = { policy: "LEAN" as const, headerValue: undefined };
    expect(requestOutputPolicy({ ...base, key: key(), clientName: "Claude Code" })).toBe("LEAN");
    expect(requestOutputPolicy({ ...base, key: null, clientName: "Antigravity" })).toBe("LEAN");
    expect(requestOutputPolicy({ ...base, key: key(), clientName: "Anthropic SDK" })).toBe("OFF");
    expect(requestOutputPolicy({ ...base, key: key(), clientName: null })).toBe("OFF");
    expect(requestOutputPolicy({ ...base, key: key({ name: INTERNAL_KEY_NAME }), clientName: "Codex CLI" })).toBe("OFF");
    expect(requestOutputPolicy({ ...base, key: key(), clientName: "Claude Code", headerValue: "off" })).toBe("OFF");
    expect(requestOutputPolicy({ ...base, key: key({ outputPolicyOverride: "OFF" }), clientName: "Claude Code" })).toBe("OFF");
    expect(requestOutputPolicy({ policy: "OFF", headerValue: undefined, key: key({ outputPolicyOverride: "CONCISE" }), clientName: "Codex CLI" })).toBe("CONCISE");
  });
});

describe("output policy placement", () => {
  const text = outputPolicyText("LEAN")!;

  it("goes before the last cached system block, adds no cache_control and leaves the input untouched", () => {
    const system = [{ type: "text", text: "billing" }, { type: "text", text: "identity", cache_control: { type: "ephemeral" } },
      { type: "text", text: "instructions", cache_control: { type: "ephemeral" } }];
    const body = { model: "claude-opus-5-5", system, messages: [] };
    const out = withAnthropicOutputPolicy(body, text)!;
    expect((out.system as unknown[]).map((block) => (block as { text: string }).text)).toEqual(["billing", "identity", text, "instructions"]);
    expect((out.system as Record<string, unknown>[])[2]).toEqual({ type: "text", text });
    expect(body.system).toHaveLength(3);
    // Same input, same bytes: the prompt cache keeps the block after its first write.
    expect(JSON.stringify(withAnthropicOutputPolicy(body, text))).toBe(JSON.stringify(out));
    expect(withAnthropicOutputPolicy(out, text)).toBeNull();
  });

  it("turns a string system into blocks and appends when no block is cached", () => {
    expect(withAnthropicOutputPolicy({ system: "You are helpful." }, text)!.system).toEqual([{ type: "text", text: "You are helpful." }, { type: "text", text }]);
    expect(withAnthropicOutputPolicy({}, text)!.system).toEqual([{ type: "text", text }]);
  });

  it("appends to Responses instructions once", () => {
    expect(withResponsesOutputPolicy({ input: [] }, text)!.instructions).toBe(text);
    const out = withResponsesOutputPolicy({ instructions: "Base." }, text)!;
    expect(out.instructions).toBe(`Base.\n\n${text}`);
    expect(withResponsesOutputPolicy(out, text)).toBeNull();
  });

  it("adds a systemInstruction part on Antigravity agent turns only", () => {
    const agent = { model: "gemini-3.8-flash-high", requestType: "agent", request: { contents: [], systemInstruction: { role: "user", parts: [{ text: "Base." }] } } };
    const out = withGeminiOutputPolicy(agent, text)!;
    expect((out.request as { systemInstruction: { parts: unknown[] } }).systemInstruction.parts).toEqual([{ text: "Base." }, { text }]);
    expect(agent.request.systemInstruction.parts).toHaveLength(1);
    expect(withGeminiOutputPolicy(out, text)).toBeNull();
    expect(withGeminiOutputPolicy({ ...agent, requestType: "checkpoint" }, text)).toBeNull();
    expect((withGeminiOutputPolicy({ requestType: "agent", request: { contents: [] } }, text)!.request as { systemInstruction: unknown }).systemInstruction)
      .toEqual({ role: "user", parts: [{ text }] });
  });
});
