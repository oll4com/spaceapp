import { describe, expect, it } from "vitest";
import { InMemoryMonitoringCopilotRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import type { NotificationRaiseInput } from "@space/contracts";
import type { MonitoringCollector } from "../src/monitoring-copilot/collector.js";
import { MONITORING_SENTRY_READ_MS, createMonitoringCopilotService } from "../src/monitoring-copilot/service.js";
import { renderDailyReview } from "../src/nous/daily-review.js";
import { sentryReleaseLines, sentryReleasesDeployedSince, sentryUnresolvedIssues, type SentryIssue } from "../src/sentry-api.js";

const issue = (id: string, substatus: string): SentryIssue => ({ id, shortId: `SPACEAPP-API-${id}`, title: "TypeError: [Filtered]", culprit: "app:///apps/api/dist/x.js",
  project: "spaceapp-api", level: "error", substatus, count: 3, firstSeen: "2026-11-05T03:00:00Z", lastSeen: "2026-11-05T03:10:00Z", permalink: `https://spaceapp-u9.sentry.io/issues/${id}/` });

function fixture(read: () => Promise<SentryIssue[] | null>) {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Monitoring", initialPaneCount: 0 });
  (room as { ownerUserId?: string }).ownerUserId = "user:operator";
  store.createPane({ roomId: room.id, title: "Monitoring Copilot", mode: "MONITORING_COPILOT", terminalRuntimeId: "cli:claude" });
  let clock = Date.parse("2026-11-05T04:00:00Z"), reads = 0;
  const raised: NotificationRaiseInput[] = [], resolved: string[] = [];
  const open = () => [...new Map(raised.map((input) => [input.dedupeKey, input])).values()].filter((input) => !resolved.includes(input.dedupeKey!))
    .map((input) => ({ ...input, ownerUserId: "user:operator" }));
  const repository = new InMemoryMonitoringCopilotRepository(() => new Date(clock).toISOString());
  const service = createMonitoringCopilotService({
    repository, collector: {} as MonitoringCollector, collectorConfig: { network: null, defaults: null }, now: () => clock,
    store: { updateMonitoringCopilotMetadata: (paneId, metadata) => store.updateMonitoringCopilotMetadata(paneId, metadata), listRooms: () => [room], listPanes: (roomId, closed) => store.listPanes(roomId, closed) },
    notifications: { raise: async (input) => { raised.push(input as NotificationRaiseInput); return {} as never; }, resolve: async (_owner, key) => { resolved.push(key); return 1; }, unresolvedBySource: async () => open() as never },
    sentry: { issues: async () => { reads += 1; return read(); } }
  });
  return { service, raised, resolved, repository, reads: () => reads, tick: (ms: number) => { clock += ms; } };
}

describe("Sentry issues in the Monitoring Copilot watch", () => {
  it("reads nothing without a read token and raises nothing", async () => {
    const f = fixture(async () => null);
    await f.service.watch();
    expect([f.reads(), f.raised.length]).toEqual([1, 0]);
  });

  it("raises one card per new, regressed or escalating issue, reads at most every 5 minutes, and closes the card when the issue is resolved", async () => {
    let issues = [issue("1", "new"), issue("2", "ongoing"), issue("3", "regressed")];
    const f = fixture(async () => issues);
    await f.service.watch();
    expect(f.raised.map((card) => [card.kind, card.severity, card.dedupeKey])).toEqual([["MONITORING_SENTRY", "ATTENTION", "monitoring:sentry:1"], ["MONITORING_SENTRY", "ATTENTION", "monitoring:sentry:3"]]);
    expect(f.raised[0]!.title).toBe("Sentry new: TypeError: [Filtered] (spaceapp-api)");
    expect(f.raised[0]!.body).toContain("https://spaceapp-u9.sentry.io/issues/1/");
    await f.service.watch();
    expect(f.reads()).toBe(1);
    f.tick(MONITORING_SENTRY_READ_MS);
    issues = [issue("3", "regressed")];
    await f.service.watch();
    expect([f.reads(), f.raised.length, f.resolved]).toEqual([2, 2, ["monitoring:sentry:1"]]);
    f.tick(MONITORING_SENTRY_READ_MS);
    const failing = fixture(async () => { throw new Error("Sentry answered HTTP 502"); });
    await failing.service.watch();
    expect(failing.resolved).toEqual([]);
  });
});

describe("Sentry web API reading", () => {
  const page = (body: unknown, next?: string) => ({ ok: true, status: 200, json: async () => body,
    headers: new Headers(next ? { link: `<${next}>; rel="next"; results="true"; cursor="1:0:0"` } : {}) }) as unknown as Response;

  it("follows every page of unresolved issues and keeps only the fields it shows", async () => {
    const calls: string[] = [];
    const answers = [page([{ id: 1, shortId: "A-1", title: "Error: [Filtered]", project: { slug: "spaceapp-web" }, substatus: "new", count: "4", user: { ip: "192.0.2.1" } }],
      "https://sentry.io/api/0/organizations/spaceapp-u9/issues/?cursor=1:0:0"), page([{ id: 2, substatus: "escalating" }])];
    const issues = await sentryUnresolvedIssues("tok", (async (url: string) => { calls.push(url); return answers.shift()!; }) as typeof fetch);
    expect(calls).toEqual(["https://sentry.io/api/0/organizations/spaceapp-u9/issues/?query=is%3Aunresolved&limit=100", "https://sentry.io/api/0/organizations/spaceapp-u9/issues/?cursor=1:0:0"]);
    expect(issues.map((item) => [item.id, item.project, item.substatus, item.count])).toEqual([["1", "spaceapp-web", "new", 4], ["2", "?", "escalating", 0]]);
    expect(JSON.stringify(issues)).not.toContain("192.0.2.1");
  });

  it("lists the releases deployed since then with their new issues, and says why it could not", async () => {
    const rows = [{ version: "a".repeat(40), dateCreated: "2026-11-05T03:00:00Z", newGroups: 2, lastDeploy: { environment: "dev", dateFinished: "2026-11-05T03:41:00Z" } },
      { version: "b".repeat(40), dateCreated: "2026-11-05T01:00:00Z", newGroups: 0, lastDeploy: null },
      { version: "c".repeat(40), dateCreated: "2026-11-03T01:00:00Z", newGroups: 9, lastDeploy: { environment: "stable", dateFinished: "2026-11-03T01:00:00Z" } }];
    const releases = await sentryReleasesDeployedSince("tok", "2026-11-04T04:00:00Z", (async () => page(rows)) as typeof fetch);
    expect(sentryReleaseLines(releases)).toEqual([`- ${"a".repeat(10)} dev, deployed 2026-11-05 03:41 UTC: 2 new issues`]);
    expect(sentryReleaseLines([])).toEqual(["- No release was deployed since then."]);
    expect(sentryReleaseLines(null)[0]).toContain("no Sentry token file");
    expect(renderDailyReview({ facts: [], decisions: [], sentry: sentryReleaseLines([]), since: "2026-11-04T03:00:00.000Z", day: "2026-11-05", hour: 3 }))
      .toContain("## Sentry: new issues per release deployed since then");
    expect(renderDailyReview({ facts: [], decisions: [], since: "2026-11-04T03:00:00.000Z", day: "2026-11-05", hour: 3 })).not.toContain("## Sentry");
    await expect(sentryReleasesDeployedSince("tok", "x", (async () => ({ ok: false, status: 403 })) as unknown as typeof fetch)).rejects.toThrow("HTTP 403");
  });
});
