import { describe, expect, it } from "vitest";
import { nextReadMark, readRows } from "../src/features/nous/nous-read-mark.js";

// Five 100px rows from 0 to 500; the view shows 200px of them.
const ats = ["t1", "t2", "t3", "t4", "t5"];
const box = (index: number) => ({ top: index * 100, bottom: index * 100 + 100 });

describe("Nous last-read mark", () => {
  it("starts at the last row the view shows whole", () => {
    expect(nextReadMark(ats, box, null, { top: 0, bottom: 250 }, new Set())).toBe("t2");
  });
  it("follows the operator reading down from it", () => {
    expect(nextReadMark(ats, box, "t2", { top: 150, bottom: 400 }, new Set())).toBe("t4");
  });
  it("stays where they left off when the view jumped past it (open at the newest)", () => {
    expect(nextReadMark(ats, box, "t1", { top: 300, bottom: 500 }, new Set())).toBe("t1");
  });
  it("keeps following when the first unread row shifted above the view after it was seen (operator 27/11)", () => {
    const seen = new Set<string>();
    expect(nextReadMark(ats, box, "t1", { top: 100, bottom: 300 }, seen)).toBe("t3");
    // The rows above took their real height: t2 and t3 moved up out of view before the mark was saved, then the operator reads on.
    expect(nextReadMark(ats, box, "t1", { top: 300, bottom: 500 }, seen)).toBe("t5");
  });
  it("never moves back while they read older messages", () => {
    expect(nextReadMark(ats, box, "t4", { top: 0, bottom: 200 }, new Set())).toBe("t4");
  });
  it("counts the rows the band covers, none for a mark older than the loaded rows", () => {
    expect(readRows(ats, "t3")).toBe(3);
    expect(readRows(ats, "t0")).toBe(0);
    expect(readRows(ats, null)).toBe(0);
  });
});
