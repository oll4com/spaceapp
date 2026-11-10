import {describe, expect, it} from "vitest";
import {siteSigninDomain, siteSigninRecordSchema} from "../src/site-signins.js";
describe("shared site sign-in contracts", () => {
  it("joins subdomains using public suffixes and keeps private tenant sites separate", () => {
    expect(siteSigninDomain("https://auth.jobs.example.co.uk/login")).toBe("example.co.uk");
    expect(siteSigninDomain("www.UPWORK.com")).toBe("upwork.com");
    expect(siteSigninDomain("tenant.github.io")).toBe("tenant.github.io");
    expect(() => siteSigninDomain("http://localhost/")).toThrow();
    expect(() => siteSigninDomain("https://someone:secret@example.com")).toThrow();
  });
  it("accepts metadata and opaque handles, refuses credential fields, invalid methods and unbounded notes", () => {
    expect(siteSigninRecordSchema.parse({site:"www.upwork.com", outcome:"SUCCESS", vaultHandle:"vault_key:opaque"})).toMatchObject({site:"upwork.com", accountLabel:"main"});
    for (const patch of [{password:"secret"}, {vaultHandle:"secret"}, {method:"PASSWORD"}, {notes:"x".repeat(501)}])
      expect(siteSigninRecordSchema.safeParse({site:"example.com", outcome:"CHANGED", ...patch}).success).toBe(false);
  });
});
