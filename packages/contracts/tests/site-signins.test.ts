import {describe, expect, it} from "vitest";
import {siteSigninDomain, siteSigninKeySchema, siteSigninRecordSchema} from "../src/site-signins.js";
describe("shared site sign-in contracts", () => {
  it("joins subdomains using public suffixes and keeps private tenant sites separate", () => {
    expect(siteSigninDomain("https://auth.jobs.example.co.uk/login")).toBe("example.co.uk");
    expect(siteSigninDomain("www.UPWORK.com")).toBe("upwork.com");
    expect(siteSigninDomain("tenant.github.io")).toBe("tenant.github.io");
    expect(() => siteSigninDomain("http://localhost/")).toThrow();
    expect(() => siteSigninDomain("https://someone:secret@example.com")).toThrow();
  });
  it("keeps a service on its own port apart from the other sites of its domain", () => {
    const key = (site: string) => siteSigninKeySchema.parse({site}).site;
    // Neutral hosts: the public export rewrites the operator's own (spaceapp.example) to 127.0.0.1, which is no public site.
    expect(key("https://space.example.com:4911/settings")).toBe("space.example.com:4911");
    expect(key("space.example.com:4940")).toBe("space.example.com:4940");
    expect(key("https://panel.example.com/login/")).toBe("example.com");
    expect(key("https://space.example.com:443/api/auth/google/callback")).toBe("example.com");
    expect(key("https://login.gsis.gr/x")).toBe(key("https://oauth2.gsis.gr/y"));
  });
  it("accepts metadata and opaque handles, refuses credential fields, invalid methods and unbounded notes", () => {
    expect(siteSigninRecordSchema.parse({site:"www.upwork.com", outcome:"SUCCESS", vaultHandle:"vault_key:opaque"})).toMatchObject({site:"upwork.com", accountLabel:"main"});
    for (const patch of [{password:"secret"}, {vaultHandle:"secret"}, {method:"PASSWORD"}, {notes:"x".repeat(501)}])
      expect(siteSigninRecordSchema.safeParse({site:"example.com", outcome:"CHANGED", ...patch}).success).toBe(false);
  });
});
