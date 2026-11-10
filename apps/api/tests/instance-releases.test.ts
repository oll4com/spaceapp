import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { readReleases } from "../src/instance-releases.js";
import { cleanupReleaseFixtures, fixture } from "./support/instance-releases-fixture.js";

afterEach(cleanupReleaseFixtures);

describe("instance releases", () => {
  it("lists what dev has that stable lacks, the last promotion and hotfixes waiting for approval", async () => {
    const f = fixture();
    const report = await readReleases(f.options);
    expect(report.available).toBe(true);
    expect(report.defaultTarget).toBe("dev");
    expect(report.dev).toMatchObject({ commit: f.devHead, verifiedCommit: f.devHead, url: "https://dev.test" });
    expect(report.pending.map((change) => [change.ticketId, change.summary])).toEqual([
      ["q-20261012-092000-cccc", "Feature B"],
      ["q-20261012-090000-aaaa", "Feature A"]
    ]);
    expect(report.pendingCount).toBe(2);
    expect(report.promotion?.id).toBe("q-20261012-080000-1111");
    expect(report.hotfixes.map((hotfix) => hotfix.status)).toEqual(["AWAITING_APPROVAL"]);
  });

  it("reports an unavailable dev instance without failing", async () => {
    const f = fixture();
    const report = await readReleases({ ...f.options, devRepo: join(f.root, "missing") });
    expect(report.available).toBe(false);
    expect(report.dev.commit).toBeNull();
  });

  // Promotion and approval through the merge queue's grant script (not in the public tree): instance-releases-queue.test.ts.

  it("lets only an ADMIN read releases and refuses promotion on the dev instance", async () => {
    const f = fixture();
    const app = await createApp({
      config: getApiConfig({ SPACE_INSTANCE: "dev" }),
      releasesOptions: f.options,
      auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false }
    });
    try {
      const anonymous = await app.inject({ method: "GET", url: "/api/admin/releases" });
      expect(anonymous.statusCode).toBe(401);
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
      const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
      const csrf = (await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } })).json().csrfToken as string;
      const report = await app.inject({ method: "GET", url: "/api/admin/releases", headers: { cookie } });
      expect(report.statusCode).toBe(200);
      expect(report.json()).toMatchObject({ managedHere: false, pendingCount: 2 });
      const promote = await app.inject({ method: "POST", url: "/api/admin/releases/promote", headers: { cookie, "x-space-csrf-token": csrf } });
      expect(promote.statusCode).toBe(409);
      expect(promote.json().message ?? JSON.stringify(promote.json())).toMatch(/stable instance/);
    } finally {
      await app.close();
    }
  });
});
