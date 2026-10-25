import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseMemorySourceRecords } from "../src/index.js";

const path = "/opt/spaceapp/docs/gemini_history_2026-09.md";
const parse = (content: string) => parseMemorySourceRecords({ path, kind: "MONTHLY", content });
const legacyFallbackId = (heading: string) =>
  `memory:${createHash("sha256").update(`${path}\n${heading}\n${heading}`).digest("hex").slice(0, 24)}`;

describe("hand-written history headings", () => {
  it.each([
    ["2026-09-28 ~10:28 EEST — Zen bridge", "2026-09-28T07:28:00.000Z", "Zen bridge"],
    ["2026-09-16 (β') — Oh My Pi CLI", "2026-09-15T21:00:00.000Z", "Oh My Pi CLI"],
    ["2026-09-29: Watchdog fix", "2026-09-28T21:00:00.000Z", "Watchdog fix"],
    ["2026-09-02 (OpenWrt DNS restored)", "2026-09-01T21:00:00.000Z", "OpenWrt DNS restored"],
    ["2026-09-08 CRM support target", "2026-09-07T21:00:00.000Z", "CRM support target"],
    ["2026-09-01 / 2026-09-02: Range note", "2026-08-31T21:00:00.000Z", "Range note"],
    ["2026-09-04", "2026-09-03T21:00:00.000Z", "2026-09-04"]
  ])("dates %s", (heading, createdAt, title) => {
    const [record] = parse(`## ${heading}\n\n- body\n`);
    expect(record).toMatchObject({ createdAt, title });
  });

  it("keeps the ids the original parser produced", () => {
    for (const heading of ["2026-09-28 ~10:28 EEST — Zen bridge", "2026-09-04", "Verification"]) {
      expect(parse(`## ${heading}\n\n- body\n`)[0]?.id).toBe(legacyFallbackId(heading));
    }
  });

  it("falls back to the first day of the file month instead of 1970", () => {
    expect(parse("## Verification\n\n- body\n")[0]?.createdAt).toBe("2026-08-31T21:00:00.000Z");
    expect(parse("## 2026-02-31 broken\n\n- body\n")[0]?.createdAt).toBe("2026-08-31T21:00:00.000Z");
  });

  it("keeps every repeated heading reachable under a distinct id", () => {
    const records = parse("## 2026-09-04\n\n- first\n\n## 2026-09-04\n\n- second\n\n## 2026-09-04\n\n- first\n");
    expect(records.map(r => r.body.split("\n").pop())).toEqual(["- first", "- second"]);
    expect(records[0]?.id).toBe(legacyFallbackId("2026-09-04"));
    expect(new Set(records.map(r => r.id)).size).toBe(2);
  });
});
