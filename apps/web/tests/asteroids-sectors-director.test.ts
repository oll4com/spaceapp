import { describe, expect, it } from "vitest";
import { endlessSector, getSectorDef } from "../src/features/asteroids/sectors.js";
import { emptyDirector, updateDirector, validateLLMModifier } from "../src/features/asteroids/director.js";

describe("sectors 12 + endless", () => {
  it("has 12 tuned sectors with bosses on 5 and 10", () => {
    expect(getSectorDef(1).name).toBe("Launch orbit");
    expect(getSectorDef(5).boss).toBe("sentinel");
    expect(getSectorDef(10).boss).toBe("warden");
    expect(getSectorDef(12).boss).toBe("hive");
  });
  it("scales endlessly past 12 with boss every 5th", () => {
    const s15 = getSectorDef(15);
    expect(s15.sector).toBe(15);
    expect(["sentinel", "warden", "hive"]).toContain(s15.boss);
    expect(getSectorDef(13).boss).toBe("none");
    expect(endlessSector(30).rocks).toBeLessThanOrEqual(10);
  });
});

describe("local director", () => {
  it("goes calm after deaths, brutal on high accuracy", () => {
    const d = emptyDirector();
    const calm = updateDirector(d, { accuracy: 0.2, deaths: 2, combo: 0, clearTime: 60, dashUses: 0, score: 0, sector: 2 });
    expect(calm.zone).toBe("calm");
    expect(calm.pickupRate).toBeGreaterThan(1);
    const d2 = emptyDirector();
    const brutal = updateDirector(d2, { accuracy: 0.9, deaths: 0, combo: 10, clearTime: 20, dashUses: 5, score: 5000, sector: 6 });
    expect(brutal.zone).toBe("brutal");
    expect(brutal.spawnRate).toBeGreaterThan(1);
  });
});

describe("LLM modifier validation", () => {
  it("accepts valid events and clamps ranges", () => {
    expect(validateLLMModifier({ event: "ambush", threat: 5, spawnRate: 9, taunt: "Hold the line." })?.threat).toBe(1);
    expect(validateLLMModifier({ event: "nope", threat: 0.5, spawnRate: 1, taunt: "" })).toBeNull();
    expect(validateLLMModifier({ event: "storm", threat: 0.5, spawnRate: 1, taunt: "α" })).toBeNull();
    expect(validateLLMModifier({ event: "calm", threat: 0.2, spawnRate: 1, taunt: "x".repeat(61) })).toBeNull();
  });
});
