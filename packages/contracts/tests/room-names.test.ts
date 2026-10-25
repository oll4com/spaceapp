import { describe, expect, it } from "vitest";
import { PANE_NAMES } from "../src/pane-names.js";
import {
  MAX_ROOMS,
  ROOM_NAMES,
  ROOM_NAME_ALIASES,
  normalizeRoomName,
  pickNextAvailableRoomName,
  resolveRoomByName
} from "../src/room-names.js";

describe("room-names", () => {
  it("defines MAX_ROOMS as 6", () => {
    expect(MAX_ROOMS).toBe(6);
  });

  it("defines exactly 16 distinct canonical room names matching the plan", () => {
    expect(ROOM_NAMES).toHaveLength(16);
    expect(new Set(ROOM_NAMES).size).toBe(16);
    expect(ROOM_NAMES).toEqual([
      "Alex",
      "Bruno",
      "Cleo",
      "Dino",
      "Eva",
      "Felix",
      "Gina",
      "Hector",
      "Ivan",
      "Luna",
      "Milo",
      "Nova",
      "Otto",
      "Rio",
      "Sam",
      "Tara"
    ]);
  });

  it("has zero intersection between PANE_NAMES and ROOM_NAMES", () => {
    const paneSet = new Set(PANE_NAMES.map((name) => name.toLowerCase()));
    for (const roomName of ROOM_NAMES) {
      expect(paneSet.has(roomName.toLowerCase())).toBe(false);
    }
  });

  it("normalizes case-insensitively and handles Greek transliterations and accents", () => {
    expect(normalizeRoomName("alex")).toBe("Alex");
    expect(normalizeRoomName("ALEX")).toBe("Alex");
    expect(normalizeRoomName("άλεξ")).toBe("Alex");
    expect(normalizeRoomName("αλεξ")).toBe("Alex");
    expect(normalizeRoomName("Άλεξ")).toBe("Alex");

    expect(normalizeRoomName("bruno")).toBe("Bruno");
    expect(normalizeRoomName("μπρούνο")).toBe("Bruno");
    expect(normalizeRoomName("μπρουνο")).toBe("Bruno");
    expect(normalizeRoomName("Μπρούνο")).toBe("Bruno");

    expect(normalizeRoomName("cleo")).toBe("Cleo");
    expect(normalizeRoomName("κλέο")).toBe("Cleo");
    expect(normalizeRoomName("κλεο")).toBe("Cleo");
    expect(normalizeRoomName("κλειώ")).toBe("Cleo");
    expect(normalizeRoomName("κλειω")).toBe("Cleo");

    expect(normalizeRoomName("dino")).toBe("Dino");
    expect(normalizeRoomName("ντίνο")).toBe("Dino");
    expect(normalizeRoomName("ντινο")).toBe("Dino");

    expect(normalizeRoomName("eva")).toBe("Eva");
    expect(normalizeRoomName("εύα")).toBe("Eva");
    expect(normalizeRoomName("ευα")).toBe("Eva");
    expect(normalizeRoomName("έβα")).toBe("Eva");
    expect(normalizeRoomName("εβα")).toBe("Eva");

    expect(normalizeRoomName("felix")).toBe("Felix");
    expect(normalizeRoomName("φέλιξ")).toBe("Felix");
    expect(normalizeRoomName("φελιξ")).toBe("Felix");

    expect(normalizeRoomName("gina")).toBe("Gina");
    expect(normalizeRoomName("τζίνα")).toBe("Gina");
    expect(normalizeRoomName("hector")).toBe("Hector");
    expect(normalizeRoomName("έκτορας")).toBe("Hector");
    expect(normalizeRoomName("ivan")).toBe("Ivan");
    expect(normalizeRoomName("ιβάν")).toBe("Ivan");
    expect(normalizeRoomName("luna")).toBe("Luna");
    expect(normalizeRoomName("λούνα")).toBe("Luna");
    expect(normalizeRoomName("milo")).toBe("Milo");
    expect(normalizeRoomName("μίλο")).toBe("Milo");
    expect(normalizeRoomName("nova")).toBe("Nova");
    expect(normalizeRoomName("νόβα")).toBe("Nova");
    expect(normalizeRoomName("otto")).toBe("Otto");
    expect(normalizeRoomName("όττο")).toBe("Otto");
    expect(normalizeRoomName("rio")).toBe("Rio");
    expect(normalizeRoomName("ρίο")).toBe("Rio");
    expect(normalizeRoomName("sam")).toBe("Sam");
    expect(normalizeRoomName("σαμ")).toBe("Sam");
    expect(normalizeRoomName("tara")).toBe("Tara");
    expect(normalizeRoomName("τάρα")).toBe("Tara");

    expect(normalizeRoomName("nonexistent")).toBeNull();
  });

  it("allocates the first free name in sequential order", () => {
    expect(pickNextAvailableRoomName([])).toBe("Alex");
    expect(pickNextAvailableRoomName(["Alex"])).toBe("Bruno");
    expect(pickNextAvailableRoomName(["alex", "bruno"])).toBe("Cleo");
    expect(pickNextAvailableRoomName(["Alex", "Bruno", "Cleo"])).toBe("Dino");
    // Reuse when earlier is closed / not in usedNames
    expect(pickNextAvailableRoomName(["Bruno", "Cleo"])).toBe("Alex");
    expect(pickNextAvailableRoomName(["Alex", "Cleo"])).toBe("Bruno");
    // Starter room name like "Getting Started" or "Space" doesn't collide with sequential pool
    expect(pickNextAvailableRoomName(["Getting Started"])).toBe("Alex");
  });

  it("falls back to Room N when all 16 are used", () => {
    const allNames = [...ROOM_NAMES];
    expect(pickNextAvailableRoomName(allNames)).toBe("Room 17");
  });

  it("resolves rooms by canonical or alias name", () => {
    const rooms = [
      { id: "r1", name: "Alex" },
      { id: "r2", name: "Bruno" },
      { id: "r3", name: "Getting Started" }
    ];
    expect(resolveRoomByName(rooms, "Alex")?.id).toBe("r1");
    expect(resolveRoomByName(rooms, "άλεξ")?.id).toBe("r1");
    expect(resolveRoomByName(rooms, "Bruno")?.id).toBe("r2");
    expect(resolveRoomByName(rooms, "μπρούνο")?.id).toBe("r2");
    expect(resolveRoomByName(rooms, "Getting Started")?.id).toBe("r3");
    expect(resolveRoomByName(rooms, "Cleo")).toBeNull();
  });
});
