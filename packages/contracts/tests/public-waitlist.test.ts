import { describe, expect, it } from "vitest";
import {
  publicWaitlistRequestSchema,
  publicWaitlistResponseSchema
} from "../src/index.js";

describe("public waitlist contracts", () => {
  it("normalizes email and defaults the bounded source", () => {
    expect(
      publicWaitlistRequestSchema.parse({
        email: "  Person@Example.COM  ",
        consent: true
      })
    ).toEqual({
      email: "person@example.com",
      consent: true,
      source: "HOMEPAGE"
    });
  });

  it("requires a valid bounded email and explicit consent", () => {
    expect(publicWaitlistRequestSchema.safeParse({ email: "not-an-email", consent: true }).success).toBe(false);
    expect(publicWaitlistRequestSchema.safeParse({ email: "person@example.com", consent: false }).success).toBe(false);
    expect(
      publicWaitlistRequestSchema.safeParse({
        email: `${"a".repeat(250)}@example.com`,
        consent: true
      }).success
    ).toBe(false);
  });

  it("keeps the body strict and fixes source to HOMEPAGE", () => {
    expect(
      publicWaitlistRequestSchema.safeParse({
        email: "person@example.com",
        consent: true,
        source: "PARTNER"
      }).success
    ).toBe(false);
    expect(
      publicWaitlistRequestSchema.safeParse({
        email: "person@example.com",
        consent: true,
        campaign: "forged"
      }).success
    ).toBe(false);
  });

  it("accepts a bounded honeypot value without exposing it in the response contract", () => {
    expect(
      publicWaitlistRequestSchema.parse({
        email: "person@example.com",
        consent: true,
        website: "https://spam.example"
      }).website
    ).toBe("https://spam.example");
    expect(
      publicWaitlistRequestSchema.safeParse({
        email: "person@example.com",
        consent: true,
        website: "x".repeat(201)
      }).success
    ).toBe(false);
    expect(publicWaitlistResponseSchema.parse({ status: "ACCEPTED" })).toEqual({ status: "ACCEPTED" });
    expect(() => publicWaitlistResponseSchema.parse({ status: "ACCEPTED", outcome: "CREATED" })).toThrow();
  });
});
