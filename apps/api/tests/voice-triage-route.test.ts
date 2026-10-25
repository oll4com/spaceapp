import { createLiveIntentClassifier } from "../src/live-intent-classifier.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function fixture(result: unknown) {
  const store = new InMemorySpaceStore();
  const triagePrompt = vi.fn(async () => result as never);
  const app = await createApp({
    store,
    decisionsService: { classifyLiveIntent: createLiveIntentClassifier(triagePrompt) } as never,
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false }
  });
  apps.push(app);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  return { app, cookie, csrf: csrf.json().csrfToken as string, triagePrompt };
}

describe("Jev voice triage boundary", () => {
  it("returns only an allowlisted route and bounded ambiguity score", async () => {
    const { app, cookie, csrf, triagePrompt } = await fixture({
      available: true, model: "typesafe/jev-1.13", latencyMs: 4,
      usage: { inputTokens: 3, outputTokens: 2, cost: 0.000001 },
      answers: { intent: { choice: "other" }, complexity: { choice: "complex" }, tool_family: { choice: "none" }, route: { type: "choice", choice: "clarify" }, is_ambiguous: { type: "noul", noul: 4 } }
    });
    const response = await app.inject({ method: "POST", url: "/api/voice/realtime/triage",
      headers: { cookie, "x-space-csrf-token": csrf }, payload: { query: "κάνε κάτι" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ available: true, route: "clarify", ambiguous: 1, model: "typesafe/jev-1.13" });
    expect(response.json().answers).toBeUndefined();
    expect(triagePrompt).toHaveBeenCalledWith(expect.objectContaining({ state: expect.objectContaining({ query: "κάνε κάτι", ownerId: "user:dev-operator" }) }), expect.any(AbortSignal));
  });
  it("fails open without exposing the model result when Jev is unavailable", async () => {
    const { app, cookie, csrf } = await fixture({ available: false, degraded: true, reason: "not configured" });
    const response = await app.inject({ method: "POST", url: "/api/voice/realtime/triage",
      headers: { cookie, "x-space-csrf-token": csrf }, payload: { query: "άνοιξε το pane" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ available: false, degraded: true, reason: "not configured" });
  });
  it("requires an authenticated interactive owner", async () => {
    const { app } = await fixture({ available: false, degraded: true, reason: "not configured" });
    const response = await app.inject({ method: "POST", url: "/api/voice/realtime/triage", payload: { query: "test" } });
    expect(response.statusCode).toBe(401);
  });
});
