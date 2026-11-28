import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backgroundOnce } from "../src/nous/wiring.js";

// Daily Nous errors 28/11 (nous_turn:ea14e6f3): the world's planMap step awaited planNeedsYou.sync, which a Postgres fsync stall held 33 minutes.
describe("Nous world writes", () => {
  it("never waits for a write, runs one per key at a time, and reports its failure", async () => {
    const running = new Map<string, Promise<void>>();
    let release!: () => void;
    let started = 0;
    const errors: unknown[] = [];
    const hung = () => { started++; return new Promise<void>((resolve) => { release = resolve; }); };
    backgroundOnce(running, "user:a", hung, (error) => errors.push(error));
    backgroundOnce(running, "user:a", hung, (error) => errors.push(error));
    await Promise.resolve();
    expect(started).toBe(1);
    release();
    await running.get("user:a");
    expect(running.size).toBe(0);
    backgroundOnce(running, "user:a", () => { throw new Error("disk"); }, (error) => errors.push(error));
    await running.get("user:a");
    expect(errors).toEqual([new Error("disk")]);
    expect(running.size).toBe(0);
  });

  it("is how planMapOf starts the Needs you sync and the plan-hold notices", () => {
    const source = readFileSync(new URL("../src/nous/wiring.ts", import.meta.url), "utf8");
    const planMapOf = source.slice(source.indexOf("async function planMapOf("), source.indexOf("async function ownerPanes("));
    expect(planMapOf).toContain("backgroundOnce(worldWrites, owner, () => planNeedsYou.sync(owner)");
    expect(planMapOf).not.toMatch(/^\s+await [^\n]*planNeedsYou\.sync/m);
    expect(planMapOf).toContain("void (async () => { for (const item of items) await late.service?.notice(");
  });
});
