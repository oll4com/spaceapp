import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "a web address with no user name or password in it" (https only, or http too) is one rule six contracts
// repeated. This pins what each answers before and after it moved into one helper, so the move changes nothing.
const throws = (run: () => unknown) => { try { run(); return null; } catch (error) { return (error as Error).message; } };

describe("web addresses without credentials", () => {
  it("channel evidence: https on the channel's host only, never with credentials", () => {
    expect(contracts.marketingUrlMatchesChannel("https://x.com/a/status/1", "X")).toBe(true);
    expect(contracts.marketingUrlMatchesChannel("http://x.com/a/status/1", "X")).toBe(false);
    expect(contracts.marketingUrlMatchesChannel("https://u:p@x.com/a", "X")).toBe(false);
    expect(contracts.marketingUrlMatchesChannel("https://u@x.com/a", "X")).toBe(false);
    expect(contracts.freelanceUrlMatchesChannel("https://www.upwork.com/jobs/1", "UPWORK")).toBe(true);
    expect(contracts.freelanceUrlMatchesChannel("http://www.upwork.com/jobs/1", "UPWORK")).toBe(false);
    expect(contracts.freelanceUrlMatchesChannel("https://u:p@www.upwork.com/jobs/1", "UPWORK")).toBe(false);
    expect(contracts.freelanceUrlMatchesChannel("not a url", "UPWORK")).toBe(false);
  });

  it("security advisory pages: https, no credentials, port 443 only", () => {
    expect(contracts.securityAdvisoryUrlAllowed("https://nvd.nist.gov/vuln/detail/CVE-2026-1")).toBe(true);
    expect(contracts.securityAdvisoryUrlAllowed("https://nvd.nist.gov:443/vuln/detail/CVE-2026-1")).toBe(true);
    expect(contracts.securityAdvisoryUrlAllowed("https://nvd.nist.gov:8443/vuln/detail/CVE-2026-1")).toBe(false);
    expect(contracts.securityAdvisoryUrlAllowed("http://nvd.nist.gov/vuln/detail/CVE-2026-1")).toBe(false);
    expect(contracts.securityAdvisoryUrlAllowed("https://u:p@nvd.nist.gov/vuln/detail/CVE-2026-1")).toBe(false);
  });

  it("clone URLs: https, no credentials, no query or fragment, one message", () => {
    const issues = (url: string) => contracts.projectSourceSchema.safeParse({ kind: "git-url", url }).error?.issues.map((issue) => issue.message) ?? [];
    const message = "Use an HTTPS repository URL without credentials or query parameters.";
    expect(issues("https://github.com/o/r.git")).toEqual([]);
    expect(issues("http://github.com/o/r.git")).toEqual([message]);
    expect(issues("https://u:p@github.com/o/r.git")).toEqual([message]);
    expect(issues("https://github.com/o/r.git?x=1")).toEqual([message]);
    expect(issues("https://github.com/o/r.git#main")).toEqual([message]);
  });

  it("site sign-ins and user links: http or https, never with credentials, same errors", () => {
    expect(contracts.siteSigninDomain("https://login.example.co.uk/x")).toBe("example.co.uk");
    expect(contracts.siteSigninDomain("http://example.com")).toBe("example.com");
    expect(throws(() => contracts.siteSigninDomain("https://u:p@example.com"))).toBe("A public site domain is required");
    expect(throws(() => contracts.siteSigninDomain("ftp://example.com"))).toBe("A public site domain is required");
    expect(contracts.canonicalizeUserLinkUrl("http://example.com/a#b")).toBe("http://example.com/a");
    expect(contracts.canonicalizeUserLinkUrl("https://example.com/a")).toBe("https://example.com/a");
    const refused = "Link URL must use HTTP or HTTPS and must not contain credentials.";
    expect(throws(() => contracts.canonicalizeUserLinkUrl("https://u:p@example.com/"))).toBe(refused);
    expect(throws(() => contracts.canonicalizeUserLinkUrl("ftp://example.com/"))).toBe(refused);
  });
});
