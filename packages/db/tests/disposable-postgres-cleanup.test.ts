import { describe, expect, it } from "vitest";
import {
  cleanupActiveContainersSync,
  isSweepableTestContainer,
  sweepDeadTestContainers,
  trackDisposableContainer
} from "./support/disposable-postgres.js";

describe("disposable test container cleanup", () => {
  it("tracks and synchronously cleans up active containers on exit/signal", () => {
    const testName = "space-test-unit-tracking-check";
    const untrack = trackDisposableContainer(testName);

    // Calling cleanupActiveContainersSync attempts force rm and empties the set
    const cleaned = cleanupActiveContainersSync();
    expect(cleaned).toContain(testName);

    // After cleanup, active set is empty
    const secondPass = cleanupActiveContainersSync();
    expect(secondPass).not.toContain(testName);

    // Calling untrack on already-cleaned container is safe
    expect(() => untrack()).not.toThrow();
  });

  it("untrack removes the container from the active cleanup set", () => {
    const testName = "space-test-unit-untrack-check";
    const untrack = trackDisposableContainer(testName);
    untrack();

    const cleaned = cleanupActiveContainersSync();
    expect(cleaned).not.toContain(testName);
  });

  it("never sweeps a restartable container that is exited mid crash restart, only one past the orphan age", () => {
    const maxAgeMs = 15 * 60_000;
    expect(isSweepableTestContainer({ state: "exited", ageMs: 5_000, restartable: true, maxAgeMs })).toBe(false);
    expect(isSweepableTestContainer({ state: "exited", ageMs: maxAgeMs + 1, restartable: true, maxAgeMs })).toBe(true);
    expect(isSweepableTestContainer({ state: "exited", ageMs: 5_000, restartable: false, maxAgeMs })).toBe(true);
    expect(isSweepableTestContainer({ state: "dead", ageMs: 5_000, restartable: false, maxAgeMs })).toBe(true);
    expect(isSweepableTestContainer({ state: "created", ageMs: 30_000, restartable: false, maxAgeMs })).toBe(false);
    expect(isSweepableTestContainer({ state: "created", ageMs: 61_000, restartable: true, maxAgeMs })).toBe(true);
    expect(isSweepableTestContainer({ state: "running", ageMs: 5_000, restartable: false, maxAgeMs })).toBe(false);
    expect(isSweepableTestContainer({ state: "running", ageMs: maxAgeMs + 1, restartable: true, maxAgeMs })).toBe(true);
  });

  it("sweepDeadTestContainers safely executes sweep without error", () => {
    const swept = sweepDeadTestContainers({ maxAgeMs: 15 * 60_000, now: Date.now() });
    expect(Array.isArray(swept)).toBe(true);
  });
});
