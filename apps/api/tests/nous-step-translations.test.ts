import { describe, expect, it, vi } from "vitest";
import type { NousMessage } from "@space/contracts";
import { createStepTranslations } from "../src/nous/step-translations.js";
import Fastify from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCardTranslator } from "../src/notifications/translate.js";
import { registerNousRoutes } from "../src/nous/routes.js";
import type { NousService } from "../src/nous/service.js";

const row = (id: string, kind: NousMessage["kind"], content: string) =>
  ({ id, ownerUserId: "user:operator", turnId: "turn:1", kind, status: "DONE", content, meta: {}, createdAt: "2026-11-02T02:47:00.000Z" }) as NousMessage;

// Operator 2/11 09:51 BKK: the conversation's folded rows read English («6 steps Checked Cody in Alex: ok working»); he reads it in Greek.
describe("Nous conversation steps in the agents' language", () => {
  const page = [row("m1", "TOOL", "Read Zoe's reports"), row("m2", "TOOL", "Checked Cody in Alex: ok working"), row("m3", "ANSWER", "Η Dana τελείωσε."),
    row("m4", "TOOL", "Updated goal \"πρεπει να βρουμε\": waits on THIRD_PARTY"), row("m5", "TOOL", "Ελέγχθηκε")];

  it("carries the messages request's server id to the translation Gateway call, omitting absent or oversized ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "step-translation-id-"));
    const keyFile = join(root, "gateway.key");
    const calls: Headers[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push(new Headers(init?.headers));
      const texts = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      return Response.json({ choices: [{ message: { content: JSON.stringify(texts) } }] });
    });
    const app = Fastify({ genReqId: () => "req:translation-server" });
    app.addHook("onRequest", async (request) => { request.requestIdForSpace = request.id; });
    try {
      await writeFile(keyFile, "test-gateway-key");
      const makeSteps = () => createStepTranslations({
        translate: createCardTranslator({ baseUrl: "http://gateway.test/v1", keyFile, fetchImpl }), language: async () => "el", warn: vi.fn()
      });
      for (const traceId of [undefined, "x".repeat(121)]) {
        await makeSteps()("user:operator", page, traceId);
        await vi.waitFor(() => expect(calls).toHaveLength(traceId ? 2 : 1));
        expect(calls.at(-1)!.get("x-request-id")).toBeNull();
      }
      registerNousRoutes(app, { messagePage: async () => ({ messages: page, hasMore: false }) } as unknown as NousService, {
        routeOptions: {}, owner: async () => "user:operator", parseQuery: (schema, query) => schema.parse(query), stepTranslations: makeSteps()
      } as Parameters<typeof registerNousRoutes>[2]);
      expect((await app.inject({ url: "/api/nous/messages", headers: { "x-request-id": "untrusted" } })).statusCode).toBe(200);
      await vi.waitFor(() => expect(calls).toHaveLength(3));
      expect(calls.at(-1)!.get("x-request-id")).toBe("req:translation-server");
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("translates a page's steps in the background, the folded rows' last steps first, and the next read carries them", async () => {
    const translate = vi.fn(async (texts: string[]) => texts.map((text) => `el:${text}`));
    const steps = createStepTranslations({ translate, language: async () => "el", warn: vi.fn() });
    expect((await steps("user:operator", page)).some((message) => message.meta.translation)).toBe(false);
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
    // Greek already (m5, the last of its run) is never asked; the runs' last steps (m2) come before the rest, newest first.
    expect(translate.mock.calls[0]![0]).toEqual(["Checked Cody in Alex: ok working", "Updated goal \"πρεπει να βρουμε\": waits on THIRD_PARTY", "Read Zoe's reports"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const read = await steps("user:operator", page);
    expect(read.find((message) => message.id === "m2")!.meta.translation).toEqual({ language: "el", text: "el:Checked Cody in Alex: ok working" });
    expect(read.find((message) => message.id === "m3")!.meta.translation).toBeUndefined();
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it("leaves an English operator's page alone and waits 10 minutes after a failed batch", async () => {
    const english = vi.fn(async (texts: string[]) => texts);
    expect(await createStepTranslations({ translate: english, language: async () => "en", warn: vi.fn() })("user:operator", page)).toBe(page);
    expect(english).not.toHaveBeenCalled();
    let now = 0;
    const warn = vi.fn();
    const failing = vi.fn(async () => { throw new Error("HTTP 502"); });
    const steps = createStepTranslations({ translate: failing, language: async () => "el", warn, now: () => now });
    await steps("user:operator", page);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    await steps("user:operator", page);
    expect(failing).toHaveBeenCalledTimes(1);
    now += 10 * 60_000 + 1;
    await steps("user:operator", page);
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
