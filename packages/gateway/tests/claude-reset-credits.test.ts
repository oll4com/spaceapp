import { describe, expect, it, vi } from "vitest";
import { CLAUDE_CODE_USER_AGENT, claimClaudeReset, claudeResetGrantFor, fetchClaudeUsage, parseClaudeResetGrants, parseClaudeUsage } from "../src/providers/claude/usage.js";

// Claude Code's /limit-reset program (operator 14/11 11:06 BKK): the usage answer's cedar_ember grants, and the claim that spends one.
const now = Date.parse("2026-11-14T04:00:00Z");
const grant = (id: string, extra: Record<string, unknown>) => ({ id, resets_left: 1, usable_now: true, ends_at: "2026-12-01T00:00:00Z", ...extra });
const usage = {
  five_hour: { utilization: 100, resets_at: "2026-11-14T06:00:00Z" },
  seven_day: { utilization: 100, resets_at: "2026-11-15T19:00:00Z" },
  cedar_ember: { eligible: true, at_limit: true, exhausted: ["five_hour", "seven_day"], grants: [
    grant("session_a", { clears: ["five_hour"], ends_at: "2026-11-20T00:00:00Z", resets_left: 3 }),
    grant("week_b", { type: "weekly", clears: ["seven_day"], ends_at: "2026-11-25T00:00:00Z" }),
    grant("full_c", { clears: ["five_hour", "seven_day"], resets_left: 2 }),
    grant("fable_d", { gives_back_weekly: true, clears: ["seven_day"], usable_now: false }),
    grant("paused_e", { type: "full", paused: true }),
    grant("spent_f", { type: "full", resets_left: 0 }),
    grant("expired_g", { type: "full", ends_at: "2026-11-01T00:00:00Z" }),
    grant("Bad Id!", { type: "full" })
  ] }
};

// crew@'s real answer with Claude Code's user agent (14/11, ids replaced); without it Anthropic answered eligible: false,
// ineligible_reason "surface", grants [] and exhausted [], which every account stored as "Resets 0".
const percentUsed = { five_hour: 0, seven_day: 100, seven_day_overage_included: 23 };
const crewCedarEmber = { eligible: true, ineligible_reason: null, at_limit: true, exhausted: ["seven_day"], grants: [
  { id: "aaaaaaaaaaaaaaa", label: "One full limit reset (November 2026)", resets_total: 1, resets_left: 0, starts_at: "2026-11-10T21:30:00+00:00",
    ends_at: "2026-12-10T22:00:00+00:00", clears: ["five_hour", "seven_day", "seven_day_overage_included"], paused: false, usable_now: false,
    use_requires_limit: false, percent_used: percentUsed, blocking: [], arm: null, type: "full", unavailable_reason: "unavailable", gives_back_weekly: false },
  { id: "bbbbbbbbbbbbbbbbb", label: "New model launch: one Fable reset for Max, Team Premium and Enterprise Premium", resets_total: 1, resets_left: 1,
    starts_at: "2026-11-09T18:00:00+00:00", ends_at: "2027-03-09T07:59:00+00:00", clears: ["five_hour", "seven_day_overage_included"], paused: false,
    usable_now: true, use_requires_limit: false, percent_used: percentUsed, blocking: [], arm: null, type: "full", unavailable_reason: null, gives_back_weekly: true }
], next_grant_id: "bbbbbbbbbbbbbbbbb", weekly_resets_at: "2026-11-15T19:00:00+00:00", cooldown_until: null, paused_held: false,
  event_props: { surface: "claude_code_cli", tier: "claude_team", tenure_bucket: "30-89", billing_path: "stripe", billing_period: "unknown", extra_usage_state: "enabled" } };

describe("Claude limit resets", () => {
  it("reads the grants as Claude Code: its user agent, the real answer's Fable reset counted but never spent for a used-up week", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ seven_day: { utilization: 100, resets_at: "2026-11-15T19:00:00+00:00" }, cedar_ember: crewCedarEmber })));
    const read = await fetchClaudeUsage("at", fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1");
    expect((init.headers as Record<string, string>)["user-agent"]).toBe(CLAUDE_CODE_USER_AGENT);
    expect(CLAUDE_CODE_USER_AGENT).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
    expect(read.resetGrants).toEqual([{ id: "bbbbbbbbbbbbbbbbb", kind: "fable", left: 1, endsAt: "2027-03-09T07:59:00.000Z", usableNow: true,
      clears: ["five_hour", "seven_day_overage_included"] }]);
    expect(read.exhausted).toEqual(["seven_day"]);
    // dev@ 14/11: this Fable grant was spent for the week and gave back only Fable's use (week 93% used after).
    expect(claudeResetGrantFor(read.resetGrants!, read.exhausted)).toBeNull();
    expect(claudeResetGrantFor(read.resetGrants!, ["seven_day_overage_included"])?.id).toBe("bbbbbbbbbbbbbbbbb");
  });


  it("reads the live grants with Claude Code's kinds, the earliest to expire first", () => {
    expect(parseClaudeResetGrants(usage, now)?.map(({ id, kind, left }) => [id, kind, left])).toEqual([
      ["session_a", "session", 3], ["week_b", "weekly", 1], ["full_c", "full", 2], ["fable_d", "fable", 1]
    ]);
    expect(parseClaudeUsage({ five_hour: { utilization: 1 } })).toMatchObject({ resetGrants: null, exhausted: [] });
    expect(parseClaudeUsage(usage).exhausted).toEqual(["five_hour", "seven_day"]);
  });

  it("spends a grant that clears every used-up window, never a Fable or a session reset while the week is used up", () => {
    const grants = parseClaudeResetGrants(usage, now)!;
    expect(claudeResetGrantFor(grants, ["five_hour", "seven_day"])?.id).toBe("full_c");
    expect(claudeResetGrantFor(grants, ["seven_day"])?.id).toBe("week_b");
    expect(claudeResetGrantFor(grants, ["five_hour"])?.id).toBe("session_a");
    const fableOnly = grants.filter((entry) => entry.kind === "fable" || entry.kind === "session");
    expect(claudeResetGrantFor(fableOnly, ["seven_day"])).toBeNull();
    expect(claudeResetGrantFor([{ ...fableOnly.find((entry) => entry.kind === "fable")!, usableNow: true }], ["seven_day"])).toBeNull();
    expect(claudeResetGrantFor(fableOnly, ["five_hour", "seven_day"])).toBeNull();
    expect(claudeResetGrantFor(grants.filter((entry) => entry.id !== "full_c"), ["five_hour", "seven_day"])?.id).toBe("week_b");
    expect(claudeResetGrantFor(grants, [])).toBeNull();
  });

  it("claims with the request key and maps Anthropic's result", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: "reset", cleared: ["seven_day"], resets_left: 1 })));
    await expect(claimClaudeReset({ accessToken: "at", organizationUuid: "org-1", grantId: "week_b", requestId: "key-1", fetchImpl: fetchImpl as unknown as typeof fetch }))
      .resolves.toEqual({ outcome: "RESET", cleared: ["seven_day"] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/api/organizations/org-1/reset_rate_limits");
    expect(JSON.parse(String(init.body))).toEqual({ program: "cedar_ember", grant_id: "week_b", request_id: "key-1" });
    expect((init.headers as Record<string, string>)["user-agent"]).toBe(CLAUDE_CODE_USER_AGENT);
    const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const claim = (fetchImpl: typeof fetch) => claimClaudeReset({ accessToken: "at", organizationUuid: "o", grantId: "g", requestId: "k", fetchImpl });
    await expect(claim(answer({ result: "already_used" }))).resolves.toMatchObject({ outcome: "ALREADY_REDEEMED" });
    await expect(claim(answer({ result: "not_limited" }))).resolves.toMatchObject({ outcome: "NOTHING_TO_RESET" });
    await expect(claim(answer({ result: "cooldown" }))).resolves.toMatchObject({ outcome: "NO_CREDIT" });
    await expect(claim(answer({ result: "surprise" }))).rejects.toThrow(/unknown result/);
    await expect(claim(answer({}, 429))).rejects.toThrow(/HTTP 429/);
  });
});
