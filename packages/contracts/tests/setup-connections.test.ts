import { describe, expect, it } from "vitest";
import {
  setupConnectionCheckEventSchema,
  setupConnectionSchema,
  setupOverviewSchema
} from "../src/schemas.js";

const baseConnection = {
  id: "cli:codex",
  label: "Codex CLI",
  providerName: "Codex",
  category: "AI coding CLI",
  state: "CONNECTED",
  functionalState: "FUNCTIONAL",
  liveVerificationState: "VERIFIED",
  reasonCode: null,
  verifiedAt: "2026-07-29T10:00:00.000Z",
  staleAt: "2026-08-28T10:00:00.000Z",
  actions: ["VERIFY"]
} as const;

describe("setup connection contracts", () => {
  it("keeps the legacy state while exposing functional and live verification independently", () => {
    expect(setupConnectionSchema.parse(baseConnection)).toMatchObject({
      state: "CONNECTED",
      functionalState: "FUNCTIONAL",
      liveVerificationState: "VERIFIED",
      providerName: "Codex"
    });

    expect(setupConnectionSchema.parse({
      ...baseConnection,
      liveVerificationState: "QUOTA_LIMITED",
      reasonCode: "PROVIDER_QUOTA_LIMITED",
      verifiedAt: null,
      staleAt: null
    })).toMatchObject({
      state: "CONNECTED",
      functionalState: "FUNCTIONAL",
      liveVerificationState: "QUOTA_LIMITED"
    });
  });

  it("requires the canonical setup summary", () => {
    expect(setupOverviewSchema.parse({
      onboardingVersion: 1,
      isComplete: false,
      completedAt: null,
      starterRoomId: "room:getting-started",
      summary: {
        total: 11,
        functional: 10,
        liveVerified: 4,
        needsSetup: 1
      },
      connections: [baseConnection]
    }).summary).toEqual({
      total: 11,
      functional: 10,
      liveVerified: 4,
      needsSetup: 1
    });
  });

  it("accepts only the exact durable verification stages and safe result fields", () => {
    const stages = [
      "Detecting CLI",
      "Checking saved credential",
      "Sending live provider challenge",
      "Confirming credential identity",
      "Saving result",
      "Verified",
      "Quota limited",
      "Timed out"
    ] as const;

    for (const [index, stage] of stages.entries()) {
      expect(setupConnectionCheckEventSchema.parse({
        id: `setup-check-event:${index + 1}`,
        runId: "setup-check-run:one",
        sequence: index + 1,
        connectionId: "cli:codex",
        stage,
        state: index < 5 ? "RUNNING" : "COMPLETED",
        functionalState: index < 5 ? null : "FUNCTIONAL",
        liveVerificationState: index < 5 ? null : "VERIFIED",
        reasonCode: null,
        createdAt: "2026-07-29T10:00:00.000Z"
      }).stage).toBe(stage);
    }

    expect(setupConnectionCheckEventSchema.safeParse({
      id: "setup-check-event:unsafe",
      runId: "setup-check-run:one",
      sequence: 9,
      connectionId: "cli:codex",
      stage: "Provider stdout",
      state: "RUNNING",
      functionalState: null,
      liveVerificationState: null,
      reasonCode: "raw provider output",
      createdAt: "2026-07-29T10:00:00.000Z"
    }).success).toBe(false);
  });
});
