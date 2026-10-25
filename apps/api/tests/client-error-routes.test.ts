import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, csrfHeaderName, signSession } from "../src/auth.js";
import { clientErrorReportSchema } from "../src/client-error-routes.js";
import { getApiConfig } from "../src/config.js";

const sessionSecret = "client-error-routes-test-secret";
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function appWithLog() {
  const lines: Array<Record<string, unknown>> = [];
  const app = await createApp({
    store: new InMemorySpaceStore(),
    config: getApiConfig({}),
    auth: { sessionSecret, devLogin: false, secureCookies: false }
  });
  apps.push(app);
  app.addHook("preHandler", async (request) => {
    request.log.warn = ((object: Record<string, unknown>) => { lines.push(object); }) as typeof request.log.warn;
  });
  return { app, lines };
}

function authHeaders() {
  const session = signSession({ id: "user:operator", email: "operator@space.local", role: "OPERATOR" }, sessionSecret);
  return { cookie: `space_session=${session}`, [csrfHeaderName]: createCsrfToken(session, sessionSecret)! };
}

const report = {
  kind: "error",
  name: "TypeError",
  locations: [{ file: "/assets/index-Ab12.js", line: 10, column: 4 }]
};

describe("POST /api/client-errors", () => {
  it("logs one bounded event per report for signed-in users", async () => {
    const { app, lines } = await appWithLog();
    const response = await app.inject({ method: "POST", url: "/api/client-errors", headers: authHeaders(), payload: report });
    expect(response.statusCode).toBe(204);
    expect(lines).toEqual([{ event: "client.error", ...report, repeats: 1, role: "OPERATOR" }]);
  });

  it("refuses anonymous reports", async () => {
    const { app, lines } = await appWithLog();
    const response = await app.inject({ method: "POST", url: "/api/client-errors", payload: report });
    expect(response.statusCode).toBe(401);
    expect(lines).toEqual([]);
  });

  it("rejects messages, stack text, foreign URLs and extra fields", async () => {
    const { app, lines } = await appWithLog();
    for (const payload of [
      { ...report, message: "the user typed this" },
      { ...report, name: "Error: the user typed this" },
      { ...report, locations: [{ file: "https://evil.example/x.js?token=1", line: 1 }] },
      { ...report, locations: Array.from({ length: 6 }, (_, line) => ({ file: "/assets/a.js", line: line + 1 })) }
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/client-errors", headers: authHeaders(), payload });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
    }
    expect(lines).toEqual([]);
  });

  it("accepts the reporter's own fallback paths", () => {
    expect(clientErrorReportSchema.parse({ kind: "rejection", name: "UnhandledRejection", locations: [{ file: "/external", line: 1 }], repeats: 3 }).repeats).toBe(3);
  });
});
