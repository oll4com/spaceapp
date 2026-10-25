import { describe, expect, it } from "vitest";
import { shouldLogRequest, SLOW_REQUEST_LOG_MS } from "../src/request-log-policy.js";

describe("request log policy", () => {
  it("skips fast successful requests and keeps errors and slow ones", () => {
    expect(shouldLogRequest(200, 12)).toBe(false);
    expect(shouldLogRequest(304, 3)).toBe(false);
    expect(shouldLogRequest(404, 3)).toBe(true);
    expect(shouldLogRequest(503, 3)).toBe(true);
    expect(shouldLogRequest(200, SLOW_REQUEST_LOG_MS)).toBe(true);
    // The deploy continuity check needs every delete in the journal.
    expect(shouldLogRequest(200, 12, "DELETE")).toBe(true);
    expect(shouldLogRequest(200, 12, "POST")).toBe(false);
  });
});

describe("quiet request log controller", () => {
  it("logs only failing, slow or delete requests, with request fields, and keeps error-handler logs", async () => {
    const { default: Fastify } = await import("fastify");
    const { QuietRequestLogController } = await import("../src/request-log-policy.js");
    const lines: Array<Record<string, any>> = [];
    const app = Fastify({ logController: new QuietRequestLogController(), logger: { level: "info", stream: { write: (line: string) => lines.push(JSON.parse(line)) } } });
    app.get("/ok", async () => ({ ok: true }));
    app.get("/missing", async (_request, reply) => reply.code(404).send({}));
    app.get("/broken", async () => { throw new Error("boom"); });
    app.delete("/api/rooms/:id", async (_request, reply) => reply.code(202).send({}));
    await app.inject("/ok");
    await app.inject("/missing");
    await app.inject("/broken");
    await app.inject({ method: "DELETE", url: "/api/rooms/room%3Aproof" });
    await app.close();
    const completed = lines.filter((line) => line.msg === "request completed");
    expect(lines.some((line) => line.msg === "incoming request")).toBe(false);
    expect(completed.map((line) => [line.req?.method, line.req?.url, line.res?.statusCode, line.level])).toEqual([
      ["GET", "/missing", 404, 30], ["GET", "/broken", 500, 30], ["DELETE", "/api/rooms/room%3Aproof", 202, 30]
    ]);
    expect(lines.some((line) => line.msg === "boom" && line.level === 50)).toBe(true);
  });
});
