import { describe, expect, it } from "vitest";
import { sanitize } from "../asteroids-director.js";

describe("asteroids director sanitize", () => {
  it("clamps ranges and rejects bad taunts", () => {
    expect(sanitize({ event: "ambush", threat: 5, spawnRate: 9, taunt: "Hold the line." })).toEqual({
      event: "ambush", threat: 1, spawnRate: 1.5, taunt: "Hold the line.",
    });
    expect(sanitize({ event: "nope", threat: 0.5, spawnRate: 1, taunt: "" }).event).toBe("none");
    expect(sanitize({ event: "storm", threat: 0.5, spawnRate: 1, taunt: "α" }).taunt).toBe("");
    expect(sanitize({ event: "calm", threat: 0.2, spawnRate: 1, taunt: "x".repeat(61) }).taunt).toBe("");
    expect(sanitize(null).event).toBe("none");
  });
});
