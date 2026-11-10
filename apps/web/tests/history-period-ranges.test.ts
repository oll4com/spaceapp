import { describe, expect, it } from "vitest";
import { rangeFits } from "../src/features/history-period/use-history-period.js";
import { fetchEveryPage } from "../src/paged.js";

// Range pickers offer nothing longer than the History period (plan clipboard:8riKjb1krKyL); paged docks count the rows they show.
describe("history period in the web", () => {
  it("fits a range to the period", () => {
    expect(["1m", "10m", "24h", "7d", "30d", "all"].filter((range) => rangeFits(range, 7))).toEqual(["1m", "10m", "24h", "7d", "all"]);
    expect(rangeFits("30d", 30)).toBe(true);
  });

  it("counts every page's rows, not the server's total", async () => {
    const pages = [{ data: [1, 2], pagination: { totalItems: 5, totalPages: 2 } }, { data: [3], pagination: { totalItems: 5, totalPages: 2 } }];
    expect(await fetchEveryPage(async (page) => pages[page - 1]!)).toEqual({ data: [1, 2, 3], totalItems: 3 });
  });
});
