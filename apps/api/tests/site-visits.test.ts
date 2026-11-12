import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSiteVisits, summarizeSiteVisits } from "../src/site-visits.js";

// spaceapp.dev's anonymous page views (plan clipboard:hGoTZ_XwCuXn): the last send per view, internal apart, every row kept.
const line = (record: Record<string, unknown>) => JSON.stringify({ t: "2026-11-12T10:00:00Z", w: "desktop", n: 1, ...record });
const LOG = [
  line({ p: "/", id: "aaaaaaaa", n: 1, sec: "hero:3", last: "hero" }),
  line({ p: "/", id: "aaaaaaaa", n: 2, act: 20000, sc: 80, sec: "hero:5,install:12", ck: "install:2", last: "install", ev: "install_copy,github", out: "ext:github.com", r: "news.ycombinator.com", c: "GR" }),
  line({ p: "/", id: "bbbbbbbb", act: 4000, sc: 20, sec: "hero:4", last: "hero", out: "in:/docs/", src: "hn", w: "mobile", c: "US" }),
  line({ p: "/docs/", id: "cccccccc", act: 10000, fp: "/", ev: "github" }),
  line({ p: "/", id: "dddddddd", internal: true, sec: "hero:9" }),
  line({ p: "/", id: "eeeeeeee", t: "2026-08-01T00:00:00Z" }),
  "not json"
].join("\n");

describe("site visits", () => {
  it("summarizes the period's views", () => {
    const site = summarizeSiteVisits(LOG, "2026-11-01T00:00:00.000Z");
    expect(site).toMatchObject({ views: 3, internal: 1 });
    expect(site.sections).toEqual([
      { id: "hero", reached: 2, medianSeconds: 5, exits: 0, clicks: 0 },
      { id: "install", reached: 1, medianSeconds: 12, exits: 1, clicks: 2 }
    ]);
    expect(site.pages).toEqual([
      { key: "/", views: 2, medianSeconds: 12, medianDepth: 50, leftSite: 1 },
      { key: "/docs/", views: 1, medianSeconds: 10, medianDepth: null, leftSite: 1 }
    ]);
    expect(site.actions).toEqual([{ key: "github", views: 2, medianSeconds: null }, { key: "install_copy", views: 1, medianSeconds: null }]);
    expect(site.next).toEqual([{ key: "/ → /docs/", views: 1, medianSeconds: null }]);
    expect(site.referrers.map((row) => row.key)).toEqual(["news.ycombinator.com"]);
    expect(site.sources.map((row) => row.key)).toEqual(["hn"]);
    expect(site.countries.map((row) => row.key)).toEqual(["GR", "US"]);
    expect(site.screens.map((row) => row.key)).toEqual(["desktop", "mobile"]);
  });

  it("reads only the period's day files and answers null before the first sync", async () => {
    const dir = await mkdtemp(join(tmpdir(), "site-visits-"));
    await writeFile(join(dir, "2026-11-12.log"), LOG);
    await writeFile(join(dir, "2026-10-01.log"), line({ p: "/old", id: "ffffffff", t: "2026-10-01T00:00:00Z" }));
    const site = await readSiteVisits("2026-11-01T00:00:00.000Z", dir);
    expect(site?.views).toBe(3);
    expect(site?.updatedAt).toEqual(expect.any(String));
    expect(await readSiteVisits("2026-11-01T00:00:00.000Z", join(dir, "missing"))).toBeNull();
  });
});
