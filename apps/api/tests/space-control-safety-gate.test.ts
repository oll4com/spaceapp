import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { createDecisionsService } from "../src/decisions-service.js";

const secret = "space-control-safety-test-secret";
const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.useRealTimers();
});

const headers = (role: "ADMIN" | "OPERATOR" = "ADMIN", csrf = true) => {
  const session = signSession({ id: `user:${role}`, role, email: "control@space.local" }, secret);
  return {
    cookie: `space_session=${session}`,
    ...(csrf ? { "x-space-csrf-token": createCsrfToken(session, secret)! } : {})
  };
};

async function fixture(mockDecisionsFetch?: typeof fetch) {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Safety Gate Test", initialPaneCount: 0, kind: "AGENT_PROOF" });
  store.upsertUser({ id: "user:ADMIN", role: "ADMIN", email: "control@space.local" });

  const decisionsService = createDecisionsService({
    tokenFile: "/mock/token",
    readFileImpl: async () => "mock-token",
    fetch: mockDecisionsFetch ?? (((async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: "typesafe/jev-1.13",
        answers: {
          is_destructive: { type: "noul", noul: 0.95 },
          touches_production: { type: "noul", noul: 0.90 }
        }
      })
    })) as unknown) as typeof fetch)
  });

  const app = await createApp({
    store,
    decisionsService,
    config: getApiConfig({ SPACE_INTERNAL_API_TOKEN: secret, SPACE_LOG_LEVEL: "silent" }),
    auth: { sessionSecret: secret, devLogin: false, secureCookies: false }
  });
  apps.push(app);
  return { app, store, room, decisionsService };
}

describe("Space Control Jev Safety Gate & Silent Failure Check", () => {
  it("holds destructive operations when not explicitly authorized by operator", async () => {
    const { app, room } = await fixture();

    const response = await app.inject({
      method: "POST",
      url: "/api/control/v1/commands",
      headers: headers(),
      payload: {
        roomId: room.id,
        requestId: "req-destructive-test-1",
        actions: [
          {
            kind: "room",
            operation: "rename",
            name: "rm -rf /opt/spaceapp/data && drop table users"
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("FAILED");
    expect(body.results[0].status).toBe("FAILED");
    expect(body.results[0].error).toBe("DESTRUCTIVE_OPERATION_HELD");
    expect(body.results[0].detail).toContain("Execution held by Jev Safety Guard");
    expect(body.results[0].evidence.safetyGuard.isDestructive).toBe(true);
  });

  it("bypasses destructive hold when userExplicitlyAuthorized is true", async () => {
    const { app, room } = await fixture();

    const response = await app.inject({
      method: "POST",
      url: "/api/control/v1/commands",
      headers: headers(),
      payload: {
        roomId: room.id,
        requestId: "req-authorized-test-2",
        userExplicitlyAuthorized: true,
        actions: [
          {
            kind: "room",
            operation: "rename",
            name: "Allowed Renamed Room"
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("COMPLETED");
    expect(body.results[0].status).toBe("COMPLETED");
  });

  it("flags silent failure in completed actions when unhandled error is detected in output", async () => {
    const mockFetch = ((async (url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.questions.has_silent_failure) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: "typesafe/jev-1.13",
            answers: {
              has_silent_failure: { type: "noul", noul: 0.95 }
            }
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: "typesafe/jev-1.13",
          answers: {
            is_destructive: { type: "noul", noul: 0.05 },
            touches_production: { type: "noul", noul: 0.05 }
          }
        })
      };
    }) as unknown) as typeof fetch;

    const { app, room } = await fixture(mockFetch);

    // Create command that returns a long detail containing error logs
    const response = await app.inject({
      method: "POST",
      url: "/api/control/v1/commands",
      headers: headers(),
      payload: {
        roomId: room.id,
        requestId: "req-silent-fail-test-3",
        actions: [
          {
            kind: "room",
            operation: "rename",
            // Rename to something long with a traceback snippet to trigger silent failure detector
            name: "Traceback (most recent call last): Connection refused on port 5432. 0 items synced successfully."
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("FAILED");
    expect(body.results[0].status).toBe("FAILED");
    expect(body.results[0].error).toBe("SILENT_FAILURE_DETECTED");
    expect(body.results[0].detail).toContain("Jev Silent Failure Detector identified unhandled error in output");
  });
});
