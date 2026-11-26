import { describe, expect, it } from "vitest";
import { safeCliFilename, safeOriginalFilename } from "../src/artifact-storage.js";

describe("safeOriginalFilename", () => {
  it("keeps Greek and other Unicode names intact", () => {
    const greek = "Ανάλυση 15 Μεγαλύτερων Ανταγωνιστών unboxexpert.com.md";
    expect(safeOriginalFilename(greek)).toBe(greek);
    expect(safeOriginalFilename("報告 – résumé (v2).pdf")).toBe("報告 – résumé (v2).pdf");
  });

  it("keeps only the leaf of a path, strips control characters and replaces reserved ones", () => {
    expect(safeOriginalFilename("C:\\Users\\x\\Έγγραφα\\σχέδιο.txt")).toBe("σχέδιο.txt");
    expect(safeOriginalFilename("../../etc/Αρχείο.md")).toBe("Αρχείο.md");
    expect(safeOriginalFilename("a\u0000b\u001f\u007fc.txt")).toBe("abc.txt");
    expect(safeOriginalFilename('a<b>c:d"e|f?g*h.txt')).toBe("a_b_c_d_e_f_g_h.txt");
  });

  it("falls back and bounds the length", () => {
    expect(safeOriginalFilename("")).toBe("item");
    expect(safeOriginalFilename("dir/  ")).toBe("item");
    expect(safeOriginalFilename("α".repeat(300))).toHaveLength(220);
  });

  it("leaves the on-disk name ASCII-safe", () => {
    expect(safeCliFilename("Ανάλυση.md")).toMatch(/^[\w .@-]+$/);
  });
});
