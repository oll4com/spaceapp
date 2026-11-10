import { describe, expect, it } from "vitest";
import { lowQuotaText, type QuotaLowSources } from "../src/features/desktop-widgets/quota-low.js";

const clock = Date.parse("2026-10-31T06:00:00Z");
const list = <T,>(data: T[]) => ({ data }) as never;
const codex = (label: string, fiveHour: number | null, weekly: number | null, weeklyResetAt: string | null = null) =>
  ({ id: label, label, fiveHourRemainingPercent: fiveHour, weeklyRemainingPercent: weekly, weeklyResetAt, sampledAt: null });

describe("lowQuotaText (operator 2026-10-31: the quota icon turns red under 5%)", () => {
  it("names the lowest window under 5% and counts the others", () => {
    const sources: QuotaLowSources = {
      codex: list([codex("a@x.com", 80, 3), codex("b@x.com", 4.6, 50), codex("c@x.com", 60, 70)]),
      claude: list([{ id: "main", label: "Main", status: "CONNECTED", fiveHourRemainingPercent: 2, weeklyRemainingPercent: 40 }]),
    };
    expect(lowQuotaText(sources, clock)).toBe("Claude: 2% left (5h) · 2 more under 5%");
  });

  it("never turns red on unknown, offline, refilled or budget-less data, nor at exactly 5%", () => {
    const sources: QuotaLowSources = {
      codex: list([codex("a@x.com", null, null), codex("b@x.com", 5, 90), codex("c@x.com", 90, 0, "2026-10-31T05:00:00Z")]),
      agy: list([{ id: "g", label: "g", status: "EXPIRED", gemini: { displayName: "Gemini", fiveHourRemainingPercent: 0, weeklyRemainingPercent: 0 }, claude: { displayName: "Claude", fiveHourRemainingPercent: null, weeklyRemainingPercent: null } }]),
      claude: list([{ id: "k", label: "Key", status: "API_KEY", fiveHourRemainingPercent: 0, weeklyRemainingPercent: 0, pool: [] }]),
    };
    expect(lowQuotaText(sources, clock)).toBeNull();
    expect(lowQuotaText(null, clock)).toBeNull();
  });

  it("counts Antigravity groups and Gateway pool accounts", () => {
    expect(lowQuotaText({ agy: list([{ id: "g", label: "g@x.com", status: "CONNECTED",
      gemini: { displayName: "Gemini", fiveHourRemainingPercent: 50, weeklyRemainingPercent: 50 },
      claude: { displayName: "Claude", fiveHourRemainingPercent: 1, weeklyRemainingPercent: 50 } }]) }, clock))
      .toBe("Antigravity Claude · GPT: 1% left (5h)");
    expect(lowQuotaText({ claude: list([{ id: "space-gateway", label: "Space Gateway", status: "GATEWAY", fiveHourRemainingPercent: null, weeklyRemainingPercent: null,
      pool: [{ label: "max1", signInRequired: false, fiveHourRemainingPercent: 90, fiveHourResetAt: null, weeklyRemainingPercent: 4, weeklyResetAt: null }] }]) }, clock))
      .toBe("Claude: 4% left (weekly)");
  });

  it("counts a CONNECTED account the Gateway pool lists again once (Nous app c283b8c)", () => {
    const member = (label: string, weekly: number) => ({ label, signInRequired: false, fiveHourRemainingPercent: 90, fiveHourResetAt: null, weeklyRemainingPercent: weekly, weeklyResetAt: null });
    const sources: QuotaLowSources = { claude: list([
      { id: "space-gateway", label: "Space Gateway", status: "GATEWAY", fiveHourRemainingPercent: null, weeklyRemainingPercent: null, pool: [member("max1", 3), member("max2", 4)] },
      { id: "main", label: "Main", email: "max1@x.com", status: "CONNECTED", fiveHourRemainingPercent: 90, weeklyRemainingPercent: 3 },
    ]) };
    // One entry per provider and window, never an account (operator 6/11).
    expect(lowQuotaText(sources, clock)).toBe("Claude: 3% left (weekly)");
  });

  it("never counts an API provider's budget, whatever is left (operator 2/11: OpenRouter at $0.00 of $15 turned Quotas red)", () => {
    // The quota sample the widgets pass also carries the API providers; they are not subscription windows.
    const withApi = { api: list([
      { id: "openrouter", label: "OpenRouter", status: "EXHAUSTED", limit: "$15.00", remainingPercent: 0 },
      { id: "anthropic", label: "Claude API (Anthropic)", status: "CONNECTED", limit: "$200.00", remainingPercent: 3 },
    ]) } as QuotaLowSources;
    expect(lowQuotaText(withApi, clock)).toBeNull();
    expect(lowQuotaText({ ...withApi, codex: list([codex("a@x.com", 80, 2)]) }, clock)).toBe("Codex: 2% left (weekly)");
  });
});
