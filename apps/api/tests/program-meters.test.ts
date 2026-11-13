import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProgramMeters, readProgramMeters, type ProgramMeterDocument } from "../src/nous/program-meters.js";

const day = (leftUsd: number, readAt: string) => JSON.stringify({ readAt,
  credit: { leftUsd, leftEur: 4036.45, expires: "2027-08-04", burnEurPerDay: 43.78, runsOutOn: "2027-02-13", outlastsExpiry: false } });
async function azureDir() {
  const dir = await mkdtemp(join(tmpdir(), "program-meters-"));
  await writeFile(join(dir, "2026-11-12.json"), day(4600, "2026-11-12T12:00:00.000Z"));
  await writeFile(join(dir, "2026-11-13.json"), day(4496.4, "2026-11-13T12:00:00.000Z"));
  await writeFile(join(dir, "notes.txt"), "not a reading");
  return dir;
}
const murfAnswer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const now = () => Date.parse("2026-11-13T13:00:00.000Z");

describe("startup program meters", () => {
  it("reads the newest Azure check and Murf's balance as measured Used", async () => {
    const fetcher = murfAnswer(200, { remainingCharacterCount: 50_000_000 });
    const document = await readProgramMeters({ azureDir: await azureDir(), keys: async () => ({ murf: "test-key" }), fetch: fetcher, now });
    const [azure, murf] = document.entries;
    expect(azure).toMatchObject({ id: "microsoft-for-startups", benefits: [{ what: "Azure credits", used: { value: 503.6, currency: "USD" },
      remaining: { value: 4496.4 }, total: { value: 5000 }, usageAt: "2026-11-13T12:00:00.000Z", validUntil: "2027-08-04" }] });
    expect(azure!.benefits[0]!.notes).toContain("runs out on 2027-02-13");
    // 333,143 characters at $0.03 per 1,000.
    expect(murf).toMatchObject({ id: "murf-startup-incubator", benefits: [{ used: { value: 9.99, text: "$9.99" }, remaining: { value: 1490.01 }, validUntil: "2027-02-03" }] });
    expect(vi.mocked(fetcher).mock.calls[0]![1]!.headers).toMatchObject({ "api-key": "test-key" });
  });

  it("leaves out a meter that failed, warns, and keeps the others; no key, no call", async () => {
    const warn = vi.fn();
    const failed = await readProgramMeters({ azureDir: await azureDir(), keys: async () => ({ murf: "test-key" }), fetch: murfAnswer(401, { error: "no" }), now, warn });
    expect(failed.entries.map((entry) => entry.id)).toEqual(["microsoft-for-startups"]);
    expect(String(warn.mock.calls[0]![0])).toContain("HTTP 401");
    const fetcher = murfAnswer(200, {});
    const keyless = await readProgramMeters({ azureDir: join(tmpdir(), "program-meters-none"), keys: async () => ({}), fetch: fetcher, now });
    expect(keyless.entries).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads every 6 hours and lays its lines on again after a data file rewrote them", async () => {
    let at = 0;
    const document: ProgramMeterDocument = { generatedAt: "2026-11-13T00:00:00.000Z", entries: [] };
    const read = vi.fn(async () => document);
    const importUsage = vi.fn(async () => ({ problems: [] as string[] }));
    const lay = createProgramMeters({ importUsage, read, now: () => at });
    await lay([]);
    expect([read.mock.calls.length, importUsage.mock.calls.length]).toEqual([1, 1]);
    at = 60_000; await lay([{ page: "usage" }]);
    expect([read.mock.calls.length, importUsage.mock.calls.length]).toEqual([1, 1]);
    at = 120_000; await lay([{ page: "approved" }, { page: "usage" }]);
    expect([read.mock.calls.length, importUsage.mock.calls.length]).toEqual([1, 2]);
    at = 6 * 3_600_000; await lay([]);
    expect([read.mock.calls.length, importUsage.mock.calls.length]).toEqual([2, 3]);
  });
});
