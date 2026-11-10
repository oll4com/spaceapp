import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { afterWrite, createMakeWebhooks, emitMakeEvent, setMakeWebhooks } from "../src/make-webhooks.js";

const hook = "https://hook.eu1.make.com/abc123";
let dir = "";
afterEach(async () => { setMakeWebhooks(null); vi.unstubAllEnvs(); if (dir) await rm(dir, { recursive: true, force: true }); });

async function setup(files: Record<string, string>, statuses: number[]) {
  dir = await mkdtemp(join(tmpdir(), "make-webhooks-"));
  for (const [name, value] of Object.entries(files)) await writeFile(join(dir, name), `${value}\n`);
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const waits: number[] = [];
  const emit = createMakeWebhooks({
    instance: "dev", dir, allow: async (owner) => owner === "user:operator", sleep: async (ms) => { waits.push(ms); },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      const status = statuses.shift() ?? 200;
      if (status === 0) throw new Error("ECONNRESET");
      return new Response(null, { status });
    }) as typeof fetch
  });
  return { emit, calls, waits };
}

describe("Make outbound webhooks", () => {
  it("signs the body with the Vault secret and sends each event once", async () => {
    const { emit, calls } = await setup({ "make-webhook-jobs.url": hook, "make-webhook.secret": "s3cret" }, []);
    await emit("user:operator", "job_application.status", "job:1:APPLIED", { id: "job:1", status: "APPLIED" });
    await emit("user:operator", "job_application.status", "job:1:APPLIED", { id: "job:1", status: "APPLIED" });
    expect(calls).toHaveLength(1);
    const { url, headers, body } = calls[0]!;
    expect(url).toBe(hook);
    expect(JSON.parse(body)).toMatchObject({ event: "job_application.status", instance: "dev", data: { id: "job:1", status: "APPLIED" } });
    const expected = createHmac("sha256", "s3cret").update(`${headers["x-space-timestamp"]}.${body}`).digest("hex");
    expect(headers["x-space-signature"]).toBe(`sha256=${expected}`);
    expect(headers["x-space-delivery"]).toBe(JSON.parse(body).id);
  });

  it("retries network errors, 429 and 5xx with backoff, and never retries another 4xx", async () => {
    const retried = await setup({ "make-webhook-push.url": hook, "make-webhook.secret": "s" }, [0, 503, 429, 200]);
    await retried.emit("user:operator", "done", "n1", {});
    expect(retried.calls).toHaveLength(4);
    expect(retried.waits).toEqual([2_000, 10_000, 60_000]);
    await rm(dir, { recursive: true, force: true });
    const refused = await setup({ "make-webhook-push.url": hook, "make-webhook.secret": "s" }, [400]);
    await refused.emit("user:operator", "done", "n2", {});
    expect(refused.calls).toHaveLength(1);
    expect(refused.waits).toEqual([]);
  });

  it("sends nothing without its files, to a non-Make address, or for another account", async () => {
    const { emit, calls } = await setup({ "make-webhook-push.url": "https://evil.example/hook", "make-webhook.secret": "s" }, []);
    await emit("user:operator", "done", "a", {}); // not a Make hook host
    await emit("user:operator", "program.approved", "b", {}); // no programs URL installed
    await writeFile(join(dir, "make-webhook-programs.url"), hook);
    await emit("user:someone", "program.approved", "c", {}); // not the operator
    expect(calls).toEqual([]);
  });

  it("is off by default: no sender set leaves writers untouched and emits nothing", async () => {
    const repo = { async save(owner: string) { return owner; } };
    const original = repo.save;
    afterWrite(repo, "save", () => { throw new Error("unreachable"); });
    expect(repo.save).toBe(original);
    expect(() => emitMakeEvent("user:operator", "done", "x", {})).not.toThrow();
  });

  it("reports what a wrapped writer returned, and a reporting failure never fails the write", async () => {
    vi.stubEnv("SPACE_MAKE_WEBHOOKS_ENABLED", "true");
    const seen: string[] = [];
    const repo = { async save(owner: string, id: string) { return `${owner}/${id}`; } };
    afterWrite(repo, "save", (result, [owner]) => { seen.push(`${owner} ${result}`); throw new Error("report broke"); });
    await expect(repo.save("user:operator", "a")).resolves.toBe("user:operator/a");
    expect(seen).toEqual(["user:operator user:operator/a"]);
  });
});
