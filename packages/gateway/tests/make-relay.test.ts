import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import type { GatewayTrafficClass } from "@space/contracts";
import { generateGatewayApiKey } from "../src/api-keys.js";
import { makeRelayInput, registerMakeRelayRoutes } from "../src/providers/make/make-relay.js";
import { RequestLogWriter } from "../src/request-log-writer.js";
import { createGatewayServer } from "../src/server.js";

// A local stand-in for the space-ai-relay webhook: no request ever leaves the machine.
type Relay = (body: { token?: string; input?: string }, res: ServerResponse) => void;
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function mockRelay(handler: Relay) {
  const bodies: Array<{ token?: string; input?: string }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => { const body = JSON.parse(raw); bodies.push(body); handler(body, res); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, bodies };
}

const answer: Relay = (body, res) => body.token === "relay-token"
  ? res.writeHead(200, { "x-make-input-tokens": "4520", "x-make-output-tokens": "753" }).end("Hello from Make")
  : res.writeHead(401).end("Unauthorized");

async function setup(relay: Relay, opts: { model?: string | null; trafficClass?: GatewayTrafficClass; allowedModels?: string[]; dailyCredits?: number; used?: number } = {}) {
  const { url, bodies } = await mockRelay(relay);
  const repository = new InMemoryGatewayRepository();
  const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
  await repository.createApiKey({ keyId: `gw_key:${"e".repeat(32)}`, name: "Make job", keyHash, keyPrefix, trafficClass: opts.trafficClass ?? "BACKGROUND",
    allowedModels: opts.allowedModels ?? ["make/gpt-5.6-luna"], enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [],
    compressionOverride: null, limits: [], expiresAt: null, createdBy: null });
  const logs = new RequestLogWriter(repository, { intervalMs: 1 });
  const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => true,
    routes: (app, helpers) => registerMakeRelayRoutes(app, helpers, { model: opts.model === undefined ? "gpt-5.6-luna" : opts.model, logs,
      dailyCredits: opts.dailyCredits, usedTokens: async () => ({ inputTokens: opts.used ?? 0, outputTokens: 0 }),
      credentials: async () => ({ url, token: "relay-token" }) }) });
  closers.push(() => server.app.close());
  const chat = (payload: Record<string, unknown> = { model: "make/gpt-5.6-luna", messages: [{ role: "user", content: "Hi" }] }, headers: Record<string, string> = {}) =>
    server.app.inject({ method: "POST", url: "/pools/make/v1/chat/completions", headers: { authorization: `Bearer ${plainKey}`, ...headers }, payload });
  const logged = async () => { await logs.flush(); return repository.listRequestLogs({ limit: 10 }); };
  return { chat, bodies, logged };
}

describe("Make AI relay provider", () => {
  it("answers with the relay's text and the usage from its X-Make headers, and logs the tokens", async () => {
    const make = await setup(answer);
    const response = await make.chat();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ object: "chat.completion", model: "make/gpt-5.6-luna",
      choices: [{ message: { role: "assistant", content: "Hello from Make" } }], usage: { prompt_tokens: 4520, completion_tokens: 753 } });
    expect(make.bodies).toEqual([{ token: "relay-token", input: "Hi" }]);
    expect((await make.logged())[0]).toMatchObject({ provider: "MAKE", status: "success", inputTokens: 4520, outputTokens: 753 });
  });

  it("names a 401 refused, a 503 Make AI unavailable and a 200 without the usage headers no answer", async () => {
    for (const [relay, status, code] of [
      [(_b, res) => res.writeHead(401).end("Unauthorized"), 502, "make_relay_refused"],
      [(_b, res) => res.writeHead(503).end("Service Unavailable"), 503, "make_ai_unavailable"],
      // Scenario 8387703 off: Make queues the call and answers 200 "Accepted".
      [(_b, res) => res.writeHead(200).end("Accepted"), 503, "make_relay_no_answer"],
      [(_b, res) => res.writeHead(200, { "x-make-input-tokens": "12" }).end("half"), 503, "make_relay_no_answer"]
    ] as Array<[Relay, number, string]>) {
      const make = await setup(relay);
      const response = await make.chat();
      expect([response.statusCode, response.json().error.code]).toEqual([status, code]);
      expect((await make.logged())[0]).toMatchObject({ provider: "MAKE", status: "error", errorCode: code });
    }
  });

  it("serves only BACKGROUND keys that name the model, never Claude Code or another coding agent", async () => {
    const refused = async (opts: Parameters<typeof setup>[1], headers: Record<string, string> = {}) => {
      const make = await setup(answer, opts);
      const response = await make.chat(undefined, headers);
      expect(make.bodies).toEqual([]);
      return [response.statusCode, response.json().error.code];
    };
    expect(await refused({ trafficClass: "INTERACTIVE" })).toEqual([403, "key_not_allowed"]);
    // Nous's and the free-pool keys allow any model (an empty list): they never reach Make.
    expect(await refused({ allowedModels: [] })).toEqual([403, "key_not_allowed"]);
    expect(await refused({}, { "user-agent": "claude-cli/2.1.0 (external, cli)" })).toEqual([403, "client_not_allowed"]);
    expect(await refused({}, { "user-agent": "codex_cli_rs/0.99.0" })).toEqual([403, "client_not_allowed"]);
    const make = await setup(answer);
    expect((await make.chat({ model: "make/gpt-5.6-luna", messages: [{ role: "user", content: "Hi" }], stream: true })).statusCode).toBe(400);
    expect((await make.chat({ model: "make/large", messages: [{ role: "user", content: "Hi" }] })).json().error.code).toBe("model_not_listed");
    expect(make.bodies).toEqual([]);
  });

  it("ships off: without SPACE_GATEWAY_MAKE_MODEL it refuses and calls nothing", async () => {
    const make = await setup(answer, { model: null });
    const response = await make.chat();
    expect([response.statusCode, response.json().error.code]).toEqual([503, "make_off"]);
    expect(make.bodies).toEqual([]);
  });

  it("stops at the daily credit cap and says when it answers again", async () => {
    // Luna: 4,520 input tokens a credit. 9,040 logged today = 2 credits; one answer (4,520 in + 753 out) adds 2 more.
    const make = await setup(answer, { dailyCredits: 4, used: 9040 });
    expect((await make.chat()).statusCode).toBe(200);
    const exhausted = await make.chat();
    expect([exhausted.statusCode, exhausted.json().error.code]).toEqual([402, "credit_exhausted"]);
    expect(exhausted.json().error.message).toContain("4 credits for today are used up");
    expect(Number(exhausted.headers["retry-after"])).toBeGreaterThan(0);
    expect(make.bodies).toHaveLength(1);
  });

  it("flattens a conversation into the relay's one input text", () => {
    expect(makeRelayInput([{ role: "user", content: [{ type: "text", text: "Hi" }] }])).toBe("Hi");
    expect(makeRelayInput([{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }])).toBe("system: Be brief.\n\nuser: Hi");
  });
});
