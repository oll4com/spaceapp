import { describe, expect, it } from "vitest";
import { shortTmpRoot } from "./support/short-tmp.js";

describe("shortTmpRoot (socket dirs under a deep CI TMPDIR)", () => {
  it("keeps a short TMPDIR and moves a deep one to /tmp", () => {
    expect(shortTmpRoot("/tmp")).toBe("/tmp");
    const deep = `/home/runner/work/${"x".repeat(60)}/tmp`;
    expect(shortTmpRoot(deep)).toBe(process.platform === "win32" ? deep : "/tmp");
  });
});
