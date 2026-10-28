import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { countryCode, createSalaryResearch, matchPosition, parsePaylabCategory, salaryRangeFromJsonLd, salaryRangeFromText, type SalaryFetch } from "../src/job-apply/salary.js";

// Trimmed copies of the real pages (fetched 2026-10-25 from this server); no test touches the network.
const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", "job-salary", name), "utf8");
const ECB = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const PAYSCALE_GR = "https://www.payscale.com/research/GR/Job=Senior_Software_Engineer/Salary";
const PAYLAB_GR = "https://www.paylab.com/gr/salaryinfo/information-technology?lang=en&global_salary_period=monthly";
const PAYSCALE_US = "https://www.payscale.com/research/US/Job=Senior_Software_Engineer/Salary";
const PAYSCALE_SF = "https://www.payscale.com/research/US/Job=Senior_Software_Engineer/Salary/11028638/San-Francisco-CA";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function research(pages: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "space-job-salary-"));
  roots.push(root);
  const bodies = Object.fromEntries(await Promise.all(Object.entries(pages).map(async ([url, name]) => [url, await fixture(name)])));
  const requested: string[] = [];
  const fetch: SalaryFetch = async (url) => {
    requested.push(url);
    if (url.includes("glassdoor")) return { status: 403, text: "Cloudflare" };
    return url in bodies ? { status: 200, text: bodies[url]! } : { status: 404, text: "" };
  };
  const cacheFile = join(root, "salary-research-cache.json");
  return { service: createSalaryResearch({ cacheFile, fetch, now: () => new Date("2026-10-25T08:00:00Z") }), requested, cacheFile };
}

describe("Job Copilot salary research", () => {
  it("prices a senior software engineer in Athens below the Greek market median, per year and per 14 payments", async () => {
    const { service, requested } = await research({ [PAYSCALE_GR]: "payscale-gr-senior-software-engineer.html", [PAYLAB_GR]: "paylab-gr-information-technology.html", [ECB]: "ecb-eurofxref-daily.xml" });
    const result = await service.research({ title: "Software Engineer", seniority: "Senior", city: "Athens", country: "Greece" }, 10);

    expect(result.query).toMatchObject({ country: "GR", currency: "EUR", paymentsPerYear: 14 });
    expect(result.market!.sources.map((row) => [row.source, row.matched, row.currency, row.period])).toEqual([
      ["payscale", "Senior Software Engineer", "USD", "YEAR"], ["paylab", "Software Engineer", "EUR", "MONTH"]]);
    // Payscale's Greek page is in USD (43,746.52 / 1.1193 ECB) and Paylab's monthly figures count 14 payments (sqrt(1,619 x 4,739) x 14).
    expect(result.market!.sources.map((row) => row.yearly.median)).toEqual([39084, 38780]);
    expect(result.market!.yearly.median).toBeGreaterThanOrEqual(34_000);
    expect(result.market!.yearly.median).toBeLessThanOrEqual(55_000);
    expect(result.market!.monthly.median).toBe(Math.round(result.market!.yearly.median / 14));
    expect(result.market!.sampleCount).toBe(73);
    expect(result.recommended).toEqual({ yearly: 35_000, monthly: 2_500, currency: "EUR", belowPercent: 10, rule: "10% below the market median (EUR 38,932 a year), rounded down" });
    expect(result.recommended!.yearly).toBeLessThan(result.market!.yearly.median);
    expect(result).toMatchObject({ confidence: "medium", askOperator: false, postingRange: null, cached: false });
    expect(requested).not.toContain("https://www.payscale.com/research/GR/Job=Software_Engineer/Salary");
  });

  it("answers below a Greenhouse posting's stated range, never under its minimum", async () => {
    const posting = "https://job-boards.greenhouse.io/discord/jobs/8806482002";
    const { service, requested } = await research({ "https://boards-api.greenhouse.io/v1/boards/discord/jobs/8806482002?pay_transparency=true": "greenhouse-discord-job.json" });
    const result = await service.research({ title: "Commercial Policy Lead", city: "San Francisco", country: "US", postingUrl: posting }, 10);

    expect(result.postingRange).toEqual({ currency: "USD", period: "YEAR", min: 192_000, max: 216_000, source: "greenhouse", url: posting, yearly: { min: 192_000, max: 216_000 } });
    expect(result.recommended!.yearly).toBeLessThan((192_000 + 216_000) / 2);
    expect(result.recommended).toMatchObject({ yearly: 192_000, monthly: 16_000, currency: "USD" });
    expect(result.recommended!.rule).toContain("posting range midpoint (USD 192,000-216,000 a year)");
    // No market page for this title: the posting alone is medium confidence; nothing needed an exchange rate.
    expect(result).toMatchObject({ market: null, confidence: "medium", askOperator: false });
    expect(requested).not.toContain(ECB);
  });

  it("answers a EUR posting range in euros even when the query asks USD (Solaris Senior SRE, Berlin, 2026-10-26)", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-job-salary-"));
    roots.push(root);
    const posting = "https://jobs.solaris.example/senior-sre-berlin";
    const page = `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", baseSalary: { currency: "EUR", value: { minValue: 75_000, maxValue: 95_000, unitText: "YEAR" } } })}</script>`;
    const ecb = await fixture("ecb-eurofxref-daily.xml");
    const service = createSalaryResearch({ cacheFile: join(root, "cache.json"), now: () => new Date("2026-10-26T08:00:00Z"),
      fetch: async (url) => url === posting ? { status: 200, text: page } : url === ECB ? { status: 200, text: ecb } : { status: 404, text: "" } });
    const result = await service.research({ title: "Senior SRE", city: "Berlin", country: "Germany", currency: "USD", postingUrl: posting }, 10);

    expect(result.postingRange).toMatchObject({ currency: "EUR", min: 75_000, max: 95_000, yearly: { min: 75_000, max: 95_000 } });
    // 10% below the EUR 85,000 midpoint is 76,500, rounded down to 76,000 (was "USD 85,000" from the converted range).
    expect(result.recommended).toMatchObject({ yearly: 76_000, monthly: 6_300, currency: "EUR" });
    expect(result.recommended!.rule).toContain("posting range midpoint (EUR 75,000-95,000 a year)");
  });

  it("combines a LinkedIn posting with Payscale's city page, and a wider range keeps 10% below its midpoint", async () => {
    const { service } = await research({
      "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4464104608": "linkedin-guest-posting.html",
      [PAYSCALE_US]: "payscale-us-senior-software-engineer.html", [PAYSCALE_SF]: "payscale-us-senior-software-engineer-san-francisco.html"
    });
    const result = await service.research({ title: "Senior Software Engineer", city: "San Francisco", country: "United States",
      postingUrl: "https://www.linkedin.com/jobs/view/senior-software-engineer-at-acme-4464104608" }, 10);

    expect(result.postingRange).toMatchObject({ source: "linkedin", currency: "USD", period: "YEAR", min: 195_000, max: 255_000 });
    expect(result.market!.sources).toHaveLength(1);
    expect(result.market!.sources[0]).toMatchObject({ source: "payscale", scope: "city", url: PAYSCALE_SF, matched: "Senior Software Engineer (San Francisco, California)" });
    expect(result.recommended).toMatchObject({ yearly: 200_000, monthly: 16_500 });
    expect(result.confidence).toBe("high");
    expect(result.skipped.map((entry) => [entry.source, entry.reason])).toEqual([["paylab", "no page for this query"]]);
  });

  it("invents nothing without data: low confidence, no figure, the walled sources named", async () => {
    const { service, cacheFile } = await research({});
    const result = await service.research({ title: "Software Engineer", seniority: "Senior", city: "Athens", country: "GR", postingUrl: "https://boards.greenhouse.io/acme/jobs/123456" }, 10);

    expect(result).toMatchObject({ market: null, postingRange: null, recommended: null, confidence: "low", askOperator: true });
    expect(result.skipped.map((entry) => entry.source).sort()).toEqual(["paylab", "payscale", "posting"]);
    await expect(readFile(cacheFile, "utf8")).rejects.toThrow();
  });

  it("caches the market for 30 days per title, seniority and city; refresh reads the pages again", async () => {
    const { service, requested } = await research({ [PAYSCALE_GR]: "payscale-gr-senior-software-engineer.html", [PAYLAB_GR]: "paylab-gr-information-technology.html", [ECB]: "ecb-eurofxref-daily.xml" });
    const query = { title: "Software Engineer", seniority: "senior", city: "Athens", country: "GR" };
    await service.research(query, 10);
    const marketRequests = () => requested.filter((url) => url.includes("payscale") || url.includes("paylab")).length;
    expect(marketRequests()).toBe(2);

    const again = await service.research({ ...query, title: "senior software engineer", seniority: undefined }, 20);
    expect(again.cached).toBe(true);
    expect(marketRequests()).toBe(2);
    expect(again.recommended).toMatchObject({ belowPercent: 20, yearly: 31_000 });

    await service.research({ ...query, refresh: true }, 10);
    expect(marketRequests()).toBe(4);
  });

  it("reads salary ranges from posting text and schema.org JobPosting data", async () => {
    expect(salaryRangeFromText("Base Salary $192,000 — $216,000 USD Why Discord?")).toEqual({ currency: "USD", period: "YEAR", min: 192_000, max: 216_000 });
    expect(salaryRangeFromText("The range is $116,000.00 - $195,000.00 depending on level")).toEqual({ currency: "USD", period: "YEAR", min: 116_000, max: 195_000 });
    expect(salaryRangeFromText("Gross salary €3.000 - €4.000 per month, 14 payments")).toEqual({ currency: "EUR", period: "MONTH", min: 3_000, max: 4_000 });
    expect(salaryRangeFromText("We pay €50-60k a year")).toEqual({ currency: "EUR", period: "YEAR", min: 50_000, max: 60_000 });
    expect(salaryRangeFromText("Raised $5 - $10 million; 2,000 - 3,000 users")).toBeNull();
    expect(salaryRangeFromJsonLd(await fixture("ashby-ramp-posting.html"))).toEqual({ currency: "USD", period: "YEAR", min: 211_400, max: 290_600 });
  });

  it("matches Paylab positions by their words and resolves countries by name or code", async () => {
    const positions = parsePaylabCategory(await fixture("paylab-gr-information-technology.html"));
    expect(positions.find((position) => position.slug === "software-engineer")).toEqual({ slug: "software-engineer", name: "Software Engineer", currency: "EUR", p10: 1619, p90: 4739 });
    expect(matchPosition("Senior Software Engineer", positions)?.name).toBe("Software Engineer");
    expect(matchPosition("Senior Backend Engineer (Payments)", positions)?.name).toBe("Backend developer");
    expect(matchPosition("Head Chef", positions)).toBeNull();
    expect([countryCode("Greece"), countryCode("gr"), countryCode("UK"), countryCode("United Kingdom"), countryCode("Atlantis")]).toEqual(["GR", "GR", "GB", "GB", null]);
  });
});
