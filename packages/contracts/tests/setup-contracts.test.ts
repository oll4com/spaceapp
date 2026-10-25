import { describe, expect, it } from "vitest";
import {
  setupClaimInputSchema,
  setupClaimResponseSchema,
  setupStatusSchema
} from "../src/index.js";

describe("owner setup contracts", () => {
  it("accepts a strong one-time claim and rejects short credentials or extra fields", () => {
    expect(setupClaimInputSchema.parse({
      token: "t".repeat(43),
      email: "owner@example.com",
      password: "correct horse battery staple"
    })).toEqual({
      token: "t".repeat(43),
      email: "owner@example.com",
      password: "correct horse battery staple"
    });
    expect(() => setupClaimInputSchema.parse({
      token: "short",
      email: "owner@example.com",
      password: "too-short"
    })).toThrow();
    expect(() => setupClaimInputSchema.parse({
      token: "t".repeat(43),
      email: "owner@example.com",
      password: "correct horse battery staple",
      role: "ADMIN"
    })).toThrow();
  });

  it("keeps setup status minimal and returns the claimed owner's onboarding identity", () => {
    expect(setupStatusSchema.parse({
      setupRequired: true,
      expiresAt: "2026-07-23T12:15:00.000Z"
    })).toBeTruthy();
    expect(setupClaimResponseSchema.parse({
      user: { id: "user:owner", email: "owner@example.com", role: "ADMIN" },
      isAuthenticated: true,
      isSetupRequired: false,
      onboardingVersion: 1,
      isOnboardingComplete: false,
      starterRoomId: "room:getting-started"
    })).toBeTruthy();
  });
});
