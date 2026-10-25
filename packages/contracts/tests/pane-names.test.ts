import { describe, expect, it } from "vitest";
import {
  PANE_NAMES,
  PANE_NAME_ALIASES,
  normalizePaneName,
  pickNextAvailablePaneName,
  resolvePaneByName
} from "../src/pane-names.js";

describe("pane-names", () => {
  it("defines exactly 16 distinct canonical pane names matching the plan", () => {
    expect(PANE_NAMES).toHaveLength(16);
    expect(new Set(PANE_NAMES).size).toBe(16);
    expect(PANE_NAMES).toEqual([
      "Andy",
      "Bob",
      "Cody",
      "Dana",
      "Emma",
      "Finn",
      "Hugo",
      "Iris",
      "Jack",
      "Kate",
      "Leo",
      "Max",
      "Nik",
      "Oscar",
      "Paul",
      "Zoe"
    ]);
  });

  it("strictly excludes mathue / matthew and includes nik", () => {
    expect(PANE_NAMES).not.toContain("mathue");
    expect(PANE_NAMES).not.toContain("Mathue");
    expect(PANE_NAMES).not.toContain("Matthew");
    expect(PANE_NAMES).toContain("Nik");
    expect(normalizePaneName("mathue")).toBeNull();
    expect(normalizePaneName("matthew")).toBeNull();
    expect(normalizePaneName("nik")).toBe("Nik");
    expect(normalizePaneName("νικ")).toBe("Nik");
    expect(normalizePaneName("Νικ")).toBe("Nik");
  });

  it("normalizes case-insensitively and handles Greek transliterations and accents", () => {
    expect(normalizePaneName("andy")).toBe("Andy");
    expect(normalizePaneName("ANDY")).toBe("Andy");
    expect(normalizePaneName("άντι")).toBe("Andy");
    expect(normalizePaneName("αντι")).toBe("Andy");
    expect(normalizePaneName("Άντι")).toBe("Andy");

    expect(normalizePaneName("μπομπ")).toBe("Bob");
    expect(normalizePaneName("Μπομπ")).toBe("Bob");
    expect(normalizePaneName("κοντι")).toBe("Cody");
    expect(normalizePaneName("κόντι")).toBe("Cody");
    expect(normalizePaneName("ντανα")).toBe("Dana");
    expect(normalizePaneName("ντάνα")).toBe("Dana");
    expect(normalizePaneName("εμμα")).toBe("Emma");
    expect(normalizePaneName("έμμα")).toBe("Emma");
    expect(normalizePaneName("φιν")).toBe("Finn");
    expect(normalizePaneName("ουγκο")).toBe("Hugo");
    expect(normalizePaneName("ούγκο")).toBe("Hugo");
    expect(normalizePaneName("ιρις")).toBe("Iris");
    expect(normalizePaneName("ίρις")).toBe("Iris");
    expect(normalizePaneName("τζακ")).toBe("Jack");
    expect(normalizePaneName("κειτ")).toBe("Kate");
    expect(normalizePaneName("κέιτ")).toBe("Kate");
    expect(normalizePaneName("λιο")).toBe("Leo");
    expect(normalizePaneName("λίο")).toBe("Leo");
    expect(normalizePaneName("μαξ")).toBe("Max");
    expect(normalizePaneName("οσκαρ")).toBe("Oscar");
    expect(normalizePaneName("όσκαρ")).toBe("Oscar");
    expect(normalizePaneName("πολ")).toBe("Paul");
    expect(normalizePaneName("ζοι")).toBe("Zoe");
    expect(normalizePaneName("ζόι")).toBe("Zoe");

    expect(normalizePaneName("nonexistent")).toBeNull();
  });

  it("allocates the first free name in sequential order", () => {
    expect(pickNextAvailablePaneName([])).toBe("Andy");
    expect(pickNextAvailablePaneName(["Andy"])).toBe("Bob");
    expect(pickNextAvailablePaneName(["andy", "bob"])).toBe("Cody");
    expect(pickNextAvailablePaneName(["Andy", "Bob", "Cody"])).toBe("Dana");
    // Reuse when earlier is closed / not in usedNames
    expect(pickNextAvailablePaneName(["Bob", "Cody"])).toBe("Andy");
  });

  it("resolves open panes by canonical or alias name and ignores closed panes", () => {
    const panes = [
      { id: "p1", paneName: "Andy", isClosed: false },
      { id: "p2", paneName: "Bob", isClosed: true },
      { id: "p3", paneName: "Nik", isClosed: false }
    ];
    expect(resolvePaneByName(panes, "Andy")?.id).toBe("p1");
    expect(resolvePaneByName(panes, "άντι")?.id).toBe("p1");
    expect(resolvePaneByName(panes, "Bob")).toBeNull(); // closed
    expect(resolvePaneByName(panes, "νικ")?.id).toBe("p3");
    expect(resolvePaneByName(panes, "Nik")?.id).toBe("p3");
    expect(resolvePaneByName(panes, "Zoe")).toBeNull();
  });
});
