import Fastify from "fastify";
import { expect, it } from "vitest";
import { createHttpObservability } from "../src/observability.js";

it("bounds unmatched-route metrics and never exports raw paths or query data", async () => {
  const app = Fastify();
  const metrics = createHttpObservability({ serviceName: "space-api" });
  app.addHook("onRequest", async request => { metrics.onRequest(request); });
  app.addHook("onResponse", async (request, reply) => { metrics.onResponse(request, reply); });
  try {
    for (let index = 0; index < 300; index++) {
      await app.inject(`/missing/private-path-${index}?token=fixture-secret`);
    }
    const output = metrics.renderPrometheus();
    expect(output).not.toContain("private-path-");
    expect(output).not.toContain("fixture-secret");
    expect(output.split("\n").filter(line => line.startsWith("space_http_requests_total{"))).toHaveLength(1);
    expect(metrics.snapshot().totals.requestCount).toBe(300);
    expect(metrics.snapshot().endpoints).toHaveLength(1);
  } finally { await app.close(); }
});

it("keeps registered route templates and status classes useful", async () => {
  const app = Fastify();
  const metrics = createHttpObservability({ serviceName: "space-api" });
  app.addHook("onRequest", async request => { metrics.onRequest(request); });
  app.addHook("onResponse", async (request, reply) => { metrics.onResponse(request, reply); });
  app.get("/items/:id", async () => ({ ok: true }));
  try {
    await app.inject("/items/private-first");
    await app.inject("/items/private-second");
    expect(metrics.snapshot().endpoints).toEqual([expect.objectContaining({ route: "/items/:id", statusClass: "2xx", requestCount: 2 })]);
    expect(metrics.renderPrometheus()).not.toContain("private-");
  } finally { await app.close(); }
});
