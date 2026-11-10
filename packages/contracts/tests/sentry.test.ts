import { describe, expect, it, vi } from "vitest";
import { initSpaceSentry, scrubSentryBreadcrumb, scrubSentryEvent, spaceSentryOptions, sentryDsnFor, sentryEnvironmentFor } from "../src/sentry.js";

const dsn = "https://public@example.invalid/123";
const release = "a".repeat(40);

describe("Space Sentry privacy boundary", () => {
  it("drops credentials, Vault values, mail, prompts, IPs and unknown fields without mutating the event", () => {
    const secrets = ["opaque-vault-value", "Bearer token-value", "session=cookie-value", "private mail body", "private prompt", "192.0.2.45", "2001:db8::45"];
    const privateData = { Authorization: secrets[1], Cookie: secrets[2], vault: secrets[0], mailBody: secrets[3], prompt: secrets[4], ip: secrets[5], ipv6: secrets[6] };
    const event = {
      event_id: "b".repeat(32), level: "error", timestamp: 123,
      request: { headers: privateData, data: privateData, cookies: privateData },
      user: { ip_address: secrets[5] }, contexts: privateData, extra: privateData,
      tags: privateData, futureSdkField: privateData, server_name: secrets[5],
      message: secrets.join(" "), logentry: { message: secrets[3] }, transaction: secrets[4], fingerprint: secrets,
      exception: { values: [{ type: "TypeError", value: secrets.join(" "), stacktrace: { frames: [{
        filename: "https://user:pass@192.0.2.45/assets/index-abc.js?token=token-value#private",
        lineno: 12, colno: 4, in_app: true, function: secrets[0], vars: privateData,
        pre_context: secrets, context_line: secrets[4], post_context: secrets
      }] }, mechanism: { type: secrets[0], handled: false, data: privateData } }] },
      breadcrumbs: [{ category: "http", message: secrets.join(" "), data: { ...privateData, method: "POST", status_code: 500 } }, { category: "console", message: secrets[0] }]
    };
    const original = JSON.stringify(event);
    const hint = { attachments: [{ filename: "private.txt", data: secrets[0] }] };
    const clean = spaceSentryOptions({ dsn, release, environment: "dev", service: "api" })!.beforeSend(event, hint);
    for (const secret of secrets) expect(JSON.stringify(clean)).not.toContain(secret);
    expect(JSON.stringify(event)).toBe(original);
    expect(hint.attachments).toEqual([]);
    expect(clean.exception.values[0]).toEqual({ type: "TypeError", value: "[Filtered]", mechanism: { type: "generic", handled: false }, stacktrace: { frames: [{ filename: "app:///assets/index-abc.js", lineno: 12, colno: 4, in_app: true }] } });
    expect(clean.breadcrumbs).toEqual([{ category: "http", data: { method: "POST", status_code: 500 } }]);
    expect(clean).toMatchObject({ release, environment: "dev", tags: { service: "api" } });
    expect(clean).not.toHaveProperty("request");
    expect(clean).not.toHaveProperty("user");
  });

  it("discards free text in standalone breadcrumbs, unknown error types, source locals and arbitrary file paths", () => {
    expect(scrubSentryBreadcrumb({ category: "console", message: "secret" })).toBeNull();
    expect(scrubSentryBreadcrumb({ category: "ui.click", message: "secret", data: { target: "private mail" } })).toEqual({ category: "ui.click", data: {} });
    const clean = scrubSentryEvent({ exception: { values: [{ type: "prompt text", value: "Vault value", stacktrace: { frames: [{ filename: "/home/private/secret.js", lineno: 2 }] } }] } });
    expect(clean.exception.values[0]).toEqual({ type: "Error", value: "[Filtered]", stacktrace: { frames: [{ lineno: 2 }] } });
    const cyclic: Record<string, unknown> = {}; cyclic.extra = cyclic;
    expect(scrubSentryEvent(cyclic)).toEqual({ message: "[Filtered]" });
  });

  it("keeps a packaged desktop's code locations, version and process-gone reason, nothing else", () => {
    const clean = scrubSentryEvent({ dist: "0.1.27", tags: { reason: "oom", path: "C:/Users/private" }, exception: { values: [{ type: "RenderProcessGone", value: "secret",
      stacktrace: { frames: [{ filename: "C:\\Users\\private\\AppData/Local/SpaceApp/resources/app.asar/dist/main/index.js", lineno: 9 },
        { filename: "/opt/SpaceApp/resources/app.asar/../../secret.js", lineno: 1 }] } }] } });
    expect(clean).toMatchObject({ dist: "0.1.27", tags: { reason: "oom" }, exception: { values: [{ type: "RenderProcessGone", value: "[Filtered]",
      stacktrace: { frames: [{ filename: "app:///apps/desktop/dist/main/index.js", lineno: 9 }, { lineno: 1 }] } }] } });
    expect(JSON.stringify(clean)).not.toContain("private");
    expect(scrubSentryEvent({ dist: "../x", tags: { reason: "private prompt" } })).toEqual({ message: "[Filtered]" });
    const options = spaceSentryOptions({ dsn, release, service: "desktop", dist: "0.1.27" })!;
    expect(options.dist).toBe("0.1.27");
    expect(options.beforeSend({ tags: { reason: "crashed" } })).toMatchObject({ tags: { reason: "crashed", service: "desktop" } });
    expect(spaceSentryOptions({ dsn, service: "desktop", dist: "beta" })).not.toHaveProperty("dist");
  });

  it("sends nothing from a public install unless its owner chose their own Sentry or sharing with SpaceApp", () => {
    const own = "https://own@example.invalid/1", shared = "https://spaceapp@example.invalid/2", any = "https://any@example.invalid/3";
    expect(sentryDsnFor("API", { SENTRY_DSN_API: own })).toBe(own);
    const pub = { SPACE_PUBLIC_DISTRIBUTION: "true", SENTRY_DSN_API: own, SENTRY_DSN: any, SPACEAPP_SENTRY_DSN_API: shared };
    for (const mode of [undefined, "", "off", "yes"]) expect(sentryDsnFor("API", { ...pub, SPACE_ERROR_REPORTS: mode })).toBeUndefined();
    expect(sentryDsnFor("API", { ...pub, SPACE_ERROR_REPORTS: "own" })).toBe(own);
    expect(sentryDsnFor("WORKER", { ...pub, SPACE_ERROR_REPORTS: " Own " })).toBe(any);
    expect(sentryDsnFor("API", { ...pub, SPACE_ERROR_REPORTS: "share" })).toBe(shared);
    expect([sentryEnvironmentFor(pub), sentryEnvironmentFor({ SPACE_INSTANCE: "dev" }), sentryEnvironmentFor({})]).toEqual(["public", "dev", "stable"]);
    expect(spaceSentryOptions({ dsn, service: "api", environment: "public" })!.environment).toBe("public");
  });

  it("does not initialize for absent, blank or malformed DSNs", () => {
    const initialize = vi.fn();
    for (const value of [undefined, "", " ", "not-a-dsn", "https://example.invalid/1", "https://key:secret@example.invalid/1"])
      expect(initSpaceSentry(initialize, { dsn: value, service: "web" })).toBe(false);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("initializes only explicitly configured SDKs with privacy defaults", () => {
    const initialize = vi.fn();
    expect(initSpaceSentry(initialize, { dsn, release, service: "worker", environment: "stable" })).toBe(true);
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ dsn, release, environment: "stable", sendDefaultPii: false, defaultIntegrations: false, tracesSampleRate: 0, enableLogs: false, autoSessionTracking: false, sendClientReports: false }));
    expect(spaceSentryOptions({ dsn, service: "api", release: "private branch" })!.release).toBeUndefined();
    expect(initialize.mock.calls[0]![0].beforeSendTransaction({ secret: "private" })).toBeNull();
  });
});
