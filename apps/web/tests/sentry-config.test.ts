import { expect, it } from "vitest";
import { webSentryConfig } from "../sentry-config.mjs";

it("gives a public install's browsers a DSN only after its owner's choice, labelled public", () => {
  const own = "https://own@example.invalid/1", shared = "https://spaceapp@example.invalid/2";
  expect(webSentryConfig({ SENTRY_DSN_WEB: own, SPACE_INSTANCE: "dev" }, undefined)).toEqual({ dsn: own, release: undefined, environment: "dev" });
  const pub = { SPACE_PUBLIC_DISTRIBUTION: "true", SENTRY_DSN_WEB: own, SPACEAPP_SENTRY_DSN_WEB: shared };
  expect(webSentryConfig(pub, undefined)).toBeUndefined();
  expect(webSentryConfig({ ...pub, SPACE_ERROR_REPORTS: "own" }, undefined)).toMatchObject({ dsn: own, environment: "public" });
  expect(webSentryConfig({ ...pub, SPACE_ERROR_REPORTS: "share" }, undefined)).toMatchObject({ dsn: shared, environment: "public" });
  expect(webSentryConfig({ SPACE_PUBLIC_DISTRIBUTION: "true", SPACE_ERROR_REPORTS: "own", SENTRY_DSN: shared }, undefined)).toMatchObject({ dsn: shared });
});
