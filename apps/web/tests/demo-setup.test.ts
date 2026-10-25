import { describe, expect, it } from "vitest";
import { DemoStore } from "../src/demo/DemoStore.js";

describe("DemoStore setup contract", () => {
  it("returns the complete onboarding response after an owner claim", async () => {
    const store = new DemoStore();

    await expect(store.api.claimSetup({
      token: "demo-setup-token-with-at-least-thirty-two-characters",
      email: "owner@example.com",
      password: "abc123ABCxyz"
    })).resolves.toMatchObject({
      isAuthenticated: true,
      isSetupRequired: false,
      onboardingVersion: 1,
      isOnboardingComplete: true,
      starterRoomId: expect.any(String)
    });
  });

  it("simulates the 16-CLI catalog and durable partial check progress", async () => {
    const store = new DemoStore();

    await expect(store.api.setupOverview()).resolves.toMatchObject({
      summary: {
        total: 16,
        functional: 15,
        liveVerified: 4,
        needsSetup: 1
      }
    });

    const started = await store.api.startSetupConnectionChecks();
    const partial = await store.api.getSetupConnectionCheckReplay(started.id);
    expect(partial.run).toMatchObject({
      status: "RUNNING",
      completedCount: 4,
      totalCount: 16
    });
    expect(
      partial.events
        .filter((event) => event.connectionId === "cli:codex")
        .map((event) => event.stage)
    ).toEqual([
      "Detecting CLI",
      "Checking saved credential",
      "Sending live provider challenge",
      "Confirming credential identity",
      "Saving result",
      "Verified"
    ]);

    await store.api.getSetupConnectionCheckReplay(started.id, partial.events.at(-1)?.sequence);
    const third = await store.api.getSetupConnectionCheckReplay(started.id);
    expect(third.run).toMatchObject({ status: "RUNNING", completedCount: 12, totalCount: 16 });
    const completed = await store.api.getSetupConnectionCheckReplay(started.id);
    expect(completed.run).toMatchObject({
      status: "COMPLETED",
      completedCount: 16,
      totalCount: 16
    });
    expect(new Set(completed.run.connectionIds).size).toBe(16);
    const replay = await store.api.getSetupConnectionCheckReplay(started.id, completed.events.at(-1)?.sequence);
    expect(replay.events).toEqual([]);
    expect(replay.run).toEqual(completed.run);
    expect(completed.overview.summary).toEqual({
      total: 16,
      functional: 15,
      liveVerified: 4,
      needsSetup: 1
    });
  });
});
