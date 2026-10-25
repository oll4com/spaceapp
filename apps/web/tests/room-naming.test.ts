import { describe, expect, it } from "vitest";
import { nextGeneratedRoomName } from "../src/room-naming.js";

describe("nextGeneratedRoomName", () => {
  it("allocates sequential room names starting with Alex", () => {
    expect(nextGeneratedRoomName([])).toBe("Alex");
    expect(nextGeneratedRoomName(["Alex"])).toBe("Bruno");
    expect(nextGeneratedRoomName(["Alex", "Bruno"])).toBe("Cleo");
    expect(nextGeneratedRoomName(["Alex", "Bruno", "Cleo"])).toBe("Dino");
  });

  it("handles default or custom non-canonical room names gracefully", () => {
    expect(nextGeneratedRoomName(["Getting Started"])).toBe("Alex");
    expect(nextGeneratedRoomName(["Space"])).toBe("Alex");
    expect(nextGeneratedRoomName(["Getting Started", "Alex"])).toBe("Bruno");
  });

  it("reuses the first freed name when earlier rooms are deleted", () => {
    expect(nextGeneratedRoomName(["Alex", "Cleo"])).toBe("Bruno");
    expect(nextGeneratedRoomName(["Bruno", "Cleo"])).toBe("Alex");
  });

  it("respects Greek transliterations and case-insensitivity of existing rooms", () => {
    expect(nextGeneratedRoomName(["άλεξ"])).toBe("Bruno");
    expect(nextGeneratedRoomName(["alex", "Μπρούνο"])).toBe("Cleo");
  });
});
