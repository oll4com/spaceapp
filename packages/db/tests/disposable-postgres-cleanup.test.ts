import { describe, expect, it } from "vitest";
import {
  cleanupActiveContainersSync,
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

  it("sweepDeadTestContainers safely executes sweep without error", () => {
    const swept = sweepDeadTestContainers({ maxAgeMs: 15 * 60_000, now: Date.now() });
    expect(Array.isArray(swept)).toBe(true);
  });
});
