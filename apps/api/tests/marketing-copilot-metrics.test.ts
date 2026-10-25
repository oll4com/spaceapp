import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultMarketingCopilotPaneMetadata, type Pane, type Room } from "@space/contracts";
import { InMemoryMarketingCopilotRepository } from "@space/db";
import { createMarketingCopilotMetrics, fetchPublicMetrics } from "../src/marketing-copilot/metrics.js";
import { createMarketingCopilotService } from "../src/marketing-copilot/service.js";

const owner = "user:operator";
const pane = { id: "pane:mkt000001", roomId: "room:mkt000001", mode: "MARKETING_COPILOT", title: "Marketing Copilot", isClosed: false, marketingCopilotMetadata: defaultMarketingCopilotPaneMetadata() } as Pane;
const room = { id: pane.roomId, ownerUserId: owner } as Room;

function publicApis(stars: number, failNpm = false) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/oll4com/spaceapp") return Response.json({ stargazers_count: stars, forks_count: 12, subscribers_count: 5, open_issues_count: 3 });
    if (url === "https://api.github.com/repos/oll4com/spaceapp/releases?per_page=100") return Response.json([{ assets: [{ download_count: 10 }, { download_count: 5 }] }, { assets: [{ download_count: 1 }] }]);
    if (url.startsWith("https://api.npmjs.org/downloads/point/")) return failNpm ? new Response("busy", { status: 503 }) : Response.json({ downloads: url.includes("last-day") ? 40 : 210 });
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

describe("marketing copilot analytics", () => {
  it("reads GitHub and npm public numbers and keeps the others when one source fails", async () => {
    expect(await fetchPublicMetrics("2026-10-14", publicApis(120))).toEqual({ errors: [], metrics: expect.arrayContaining([
      { day: "2026-10-14", source: "GITHUB", key: "stars", value: 120 }, { day: "2026-10-14", source: "GITHUB", key: "release_downloads", value: 16 },
      { day: "2026-10-14", source: "NPM", key: "downloads_day", value: 40 }, { day: "2026-10-14", source: "NPM", key: "downloads_week", value: 210 }
    ]) });
    const partial = await fetchPublicMetrics("2026-10-14", publicApis(120, true));
    expect(partial.errors).toHaveLength(2);
    expect(partial.metrics.some((metric) => metric.source === "NPM")).toBe(false);
    expect(partial.metrics.some((metric) => metric.key === "stars")).toBe(true);
  });

  it("records the repository's traffic with the token, for the operator's pane only", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const apis = publicApis(120);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/traffic/views")) return Response.json({ count: 42, uniques: 9, views: [] });
      if (url.endsWith("/traffic/clones")) return Response.json({ count: 300, uniques: 51, clones: [] });
      if (url.endsWith("/traffic/popular/referrers")) return Response.json([{ referrer: "github.com", count: 20, uniques: 4 }, ...Array.from({ length: 6 }, (_, index) => ({ referrer: `site${index}.example`, count: 1, uniques: 1 }))]);
      return apis(input, init);
    }) as unknown as typeof fetch;
    const today = new Date("2026-10-16T09:00:00.000Z");
    const repository = new InMemoryMarketingCopilotRepository(() => today.toISOString());
    const service = createMarketingCopilotService({ repository, now: () => today.toISOString() });
    const otherPane = { ...pane, id: "pane:mkt000002", roomId: "room:other001" } as Pane;
    const store = { listRooms: () => [room, { id: "room:other001", ownerUserId: "user:other" } as Room], listPanes: (roomId: string) => roomId === room.id ? [pane] : [otherPane] };
    const installPingsPath = join(await mkdtemp(join(tmpdir(), "mk-traffic-")), "missing.log");
    const job = (githubTrafficToken?: string) => createMarketingCopilotMetrics({ service, store, fetchImpl, log: { warn: vi.fn() }, now: () => today, installPingsPath, githubTrafficToken });
    await job("token-test").tick();
    const traffic = (await service.analytics(owner)).metrics.filter((metric) => metric.source.startsWith("GITHUB_"));
    expect(traffic).toEqual(expect.arrayContaining([
      { day: "2026-10-16", source: "GITHUB_TRAFFIC", key: "views_14d", value: 42 }, { day: "2026-10-16", source: "GITHUB_TRAFFIC", key: "visitors_14d", value: 9 },
      { day: "2026-10-16", source: "GITHUB_TRAFFIC", key: "clones_14d", value: 300 }, { day: "2026-10-16", source: "GITHUB_TRAFFIC", key: "cloners_14d", value: 51 },
      { day: "2026-10-16", source: "GITHUB_REFERRERS", key: "github.com", value: 20 }
    ]));
    expect(traffic.filter((metric) => metric.source === "GITHUB_REFERRERS")).toHaveLength(5);
    // The token goes only to the traffic API; another owner's pane records no traffic.
    expect(calls.filter((call) => call.url.includes("/traffic/")).map((call) => call.auth)).toEqual(Array(3).fill("Bearer token-test"));
    expect(calls.filter((call) => !call.url.includes("/traffic/")).every((call) => call.auth === null)).toBe(true);
    expect((await service.analytics("user:other")).metrics.some((metric) => metric.source.startsWith("GITHUB_"))).toBe(false);
    calls.length = 0;
    await job().tick();
    expect(calls.some((call) => call.url.includes("/traffic/"))).toBe(false);
  });

  it("records a day per owner with a Marketing Copilot pane and posts one weekly digest to its Activity", async () => {
    let today = new Date("2026-10-07T09:00:00.000Z");
    const repository = new InMemoryMarketingCopilotRepository(() => today.toISOString());
    const service = createMarketingCopilotService({ repository, now: () => today.toISOString() });
    let stars = 100;
    const installPingsPath = join(await mkdtemp(join(tmpdir(), "mk-install-pings-")), "install-pings.log");
    const pings = (...lines: Array<[string, string, boolean?]>) => writeFile(installPingsPath, lines.map(([t, id, internal]) => JSON.stringify({ t, uid: `uid-${id}-${t}`, event: "active", install_id: id, ...(internal ? { internal } : {}) })).join("\n"));
    const otherPane = { ...pane, id: "pane:mkt000002", roomId: "room:other001" } as Pane;
    const job = () => createMarketingCopilotMetrics({ service, store: { listRooms: () => [room, { id: "room:other001", ownerUserId: "user:other" } as Room], listPanes: (roomId) => roomId === room.id ? [pane] : [otherPane] },
      fetchImpl: publicApis(stars), log: { warn: vi.fn() }, now: () => today, installPingsPath });
    await pings(["2026-10-06T10:00:00Z", "installA1"]);
    expect(await job().tick()).toEqual({ owners: 2, metrics: 7 });
    today = new Date("2026-10-14T09:00:00.000Z");
    stars = 107;
    // installA1 went quiet; two new installations were active this week; the project's own lab VM never counts.
    await pings(["2026-10-06T10:00:00Z", "installA1"], ["2026-10-13T10:00:00Z", "installB1"], ["2026-10-13T11:00:00Z", "installC1"], ["2026-10-13T12:00:00Z", "installLab", true]);
    await job().tick();
    const digests = (await repository.listEvents(owner, { types: ["METRICS"], limit: 10 })).map((event) => event.message);
    expect(digests).toEqual(["This week: GitHub stars 107 (+7 this week), forks 12 (+0 this week), npm downloads last week 210, active self-hosted installs 2 (+1 this week)", "This week: GitHub stars 100, forks 12, npm downloads last week 210, active self-hosted installs 1"]);
    // Install pings are ADMIN data: another owner's pane records only the public numbers.
    expect((await service.analytics("user:other")).metrics.some((metric) => metric.source === "INSTALLS")).toBe(false);
    await job().tick();
    expect(await repository.listEvents(owner, { types: ["METRICS"], limit: 10 })).toHaveLength(2);
    expect((await service.analytics(owner)).metrics.filter((metric) => metric.key === "stars").map((metric) => metric.value)).toEqual([100, 107]);
  });

  it("asks the agent to read a post's engagement a day and a week after publication", async () => {
    let at = Date.parse("2026-10-01T10:00:00.000Z");
    const now = () => new Date(at).toISOString();
    const repository = new InMemoryMarketingCopilotRepository(now);
    const service = createMarketingCopilotService({ repository, now });
    const full = { ...pane, marketingCopilotMetadata: { ...defaultMarketingCopilotPaneMetadata(), settings: { ...defaultMarketingCopilotPaneMetadata().settings, autonomy: "FULL" as const } } };
    const { post } = await service.createPost(owner, full, { channel: "X", kind: "POST", body: "SpaceApp runs your AI coding CLIs side by side.", assets: [] });
    await service.beginPublish(owner, full, post.id);
    await service.finishPublish(owner, full, { postId: post.id, url: "https://x.com/spaceapp/status/1" });
    await expect(service.recordPostMetrics(owner, full, { postId: "mktpost:missing", metrics: { likes: 1 } })).rejects.toThrow();
    expect(await service.postsToMeasure(owner)).toEqual([]);
    at += 25 * 3_600_000;
    await service.startRun(owner, full.id);
    expect(await service.nextItem(owner, full, { waitMs: 0 })).toMatchObject({ kind: "MEASURE", post: { id: post.id } });
    await service.recordPostMetrics(owner, full, { postId: post.id, metrics: { likes: 12, reposts: 3 } });
    expect(await service.postsToMeasure(owner)).toEqual([]);
    at += 7 * 86_400_000;
    expect((await service.postsToMeasure(owner)).map((entry) => entry.id)).toEqual([post.id]);
    const measured = await service.recordPostMetrics(owner, full, { postId: post.id, metrics: { likes: 30 } });
    expect(measured.metrics).toEqual({ likes: 30, reposts: 3 });
    expect((await service.analytics(owner)).topPosts.map((entry) => entry.id)).toEqual([post.id]);
  });
});
