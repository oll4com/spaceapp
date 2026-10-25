import { describe, expect, it, vi } from "vitest";
import { createLiveReadClassifier } from "../src/live-jev-read-classifier.js";
import type { JevDecideResult } from "@space/contracts";
const input = { ownerId: "user:owned", roomId: "room:owned", query: "Ποια tasks τρέχουν τώρα;", context: null, contextRevision: "1", policyRevision: "1" };
const answer = (choice = "TASKS", confidence = 0.95): JevDecideResult => ({ available: true, answers: { safe_read: { choice, confidence } }, model: "owned", latencyMs: 1 });
describe("Concurrent Jev read shortcut", () => {
  it.each(["δείξε την κατάσταση της αποστολής", "Τώρα δείξε την κατάσταση της αποστολής", "Show mission status", "List missions"])("delegates mission scope normally: %s", async query => {
    const decide = vi.fn(async () => answer());
    expect(await createLiveReadClassifier(decide)({ ...input, query })).toMatchObject({ available: false });
    expect(decide).not.toHaveBeenCalled();
  });
  it("keeps explicit model overrides on the ordinary delegation path", async () => {
    const decide = vi.fn(async () => answer());
    expect(await createLiveReadClassifier(decide)({ ...input, explicitModel: "requested" })).toMatchObject({ available: false });
    expect(decide).not.toHaveBeenCalled();
  });
  it.each([answer("NONE"), answer("invented"), answer("TASKS", 0.79), answer("TASKS", Number.NaN)])("rejects an unsafe or unsupported classification", async raw => {
    expect(await createLiveReadClassifier(async () => raw)(input)).toMatchObject({ available: false });
  });
  it("aborts a stuck classifier at its deadline without delaying an independent fallback", async () => {
    vi.useFakeTimers();
    try {
      let signal!: AbortSignal;
      const pending = createLiveReadClassifier((_input, s) => { signal = s; return new Promise(() => {}); })(input);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await pending).toMatchObject({ available: false });
      expect(signal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("returns the declared room-wide section while keeping all action parameters outside Jev", async () => {
    expect(await createLiveReadClassifier(async () => answer())(input)).toMatchObject({ available: true, readSection: "TASKS", intent: "inspect", route: "shell" });
  });
});
