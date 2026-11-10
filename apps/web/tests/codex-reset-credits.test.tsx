import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CodexUsageAccountList } from "@space/contracts";
import { cliAccountForecasts, cliAccountForecastText, cliAccountForecastTitle } from "../src/features/cli-accounts/cli-account-availability.js";
import { QuotaAtReset } from "../src/features/desktop-widgets/QuotaAtReset.js";
import { providerQuotaAtReset } from "../src/features/desktop-widgets/quota-overview.js";
import type { SharedQuotaCache } from "../src/features/desktop-widgets/shared-quota-cache.js";

// Operator 2/11 15:38 BKK: Codex weekly reset credits count in every quota figure.
const clock = Date.parse("2026-11-02T09:00:00Z");
const week = "2026-11-04T06:43:00.000Z";
const row = (id: string, weekly: number, resetCredits: number | null) => ({ id, label: `${id}@gmail.com`, planType: "plus", fiveHourRemainingPercent: 100,
  weeklyRemainingPercent: weekly, fiveHourResetAt: null, weeklyResetAt: week, sampledAt: null, resetCredits });
const codex = (credits: number | null): CodexUsageAccountList => ({ data: [row("a", 3, credits), row("b", 3, credits)],
  pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 }, source: "space-gateway", isStale: false, error: null, checkedAt: new Date(clock).toISOString() });
const cache = (credits: number | null) => ({ codex: codex(credits), agy: null, claude: null }) as unknown as SharedQuotaCache;

describe("Codex reset credits in the quota figures", () => {
  it("the pickers add the pool's credits to the at-reset figure", () => {
    const [forecast] = cliAccountForecasts("cli:codex", cache(2), clock);
    expect(cliAccountForecastText(forecast!)).toMatch(/free .* · \+4 resets \(≈ \+200% of a week\)$/);
    expect(cliAccountForecastTitle(forecast!)).toContain("Plus 4 resets (≈ +200% of a week): each reset credit gives its account a fresh week.");
    expect(cliAccountForecastText(cliAccountForecasts("cli:codex", cache(0), clock)[0]!)).not.toContain("reset");
  });

  it("the Quotas card and Accounts & quotas show them on the At reset line", () => {
    render(<QuotaAtReset atReset={providerQuotaAtReset("codex", cache(2), clock)} clock={clock} />);
    expect(screen.getByText(/· \+4 resets \(≈ \+200% of a week\)/)).toBeTruthy();
  });
});
