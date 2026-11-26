import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { NousMessage } from "@space/contracts";
import { createNousLive, NOUS_LIVE_CONTEXT_CHARS, NOUS_LIVE_SILENCE_CLOSE_MS, type NousLiveDeps } from "../src/nous/live/service.js";
import { NOUS_LIVE_POOLS } from "../src/nous/space-provider.js";

const keyFile = join(mkdtempSync(join(tmpdir(), "nous-live-")), "key");
writeFileSync(keyFile, "test-key\n");
const caller = { owner: "user:1", device: "dev:1", mobile: { device: "dev:1", scopes: ["nous:act"] } };
const ok = (message: unknown) => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
const timeout = () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));

function setup(answers: Array<(body: { model: string; messages: Array<{ role: string; content: string | null }> }, url: string) => Response | Promise<Response>>, extra: Partial<NousLiveDeps> = {}) {
  const calls: Array<{ url: string; body: { model: string; messages: Array<{ role: string; content: string | null }> } }> = [];
  const messages: NousMessage[] = [];
  const deps = {
    gatewayUrl: "http://gw", keyFile,
    fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); calls.push({ url: String(url), body });
      const answer = answers.shift();
      if (!answer) throw new Error("no answer scripted");
      return answer(body, String(url));
    }) as unknown as typeof fetch,
    timeZone: async () => "Asia/Bangkok", language: async () => "en" as const,
    board: async () => "pane A: builds the web app", openDecisions: async () => [], needsYou: async () => [],
    inbox: async () => ({ badge: 2, threads: [{ title: "Invoice from Acme" }] }),
    recentMessages: async () => messages,
    addMessage: vi.fn(async (input) => { const message = { id: `m${messages.length + 1}`, ...input, createdAt: new Date().toISOString() } as unknown as NousMessage; messages.push(message); return message; }),
    send: vi.fn(async () => ({ id: "handoff:1" }) as unknown as NousMessage),
    saveNote: vi.fn(async () => undefined),
    audit: vi.fn(async () => undefined), warn: vi.fn(),
    ...extra
  } satisfies NousLiveDeps;
  return { live: createNousLive(deps), deps, calls, messages };
}

describe("Nous Live (plan clipboard:f5TgJ4IIJF1m)", () => {
  it("tries each free pool once in order: a 429 or a timeout moves on, never retries the same pool", async () => {
    const { live, calls, deps } = setup([() => new Response("{}", { status: 429 }), timeout, () => ok({ content: "Two panes are working." })]);
    const { sessionId } = live.start(caller);
    const result = await live.turn(caller, { sessionId, text: "What is happening?" });
    expect(calls.map((call) => `${call.url} ${call.body.model}`)).toEqual([
      "http://gw/pools/gemini/v1/chat/completions gemini-3-flash-preview", "http://gw/pools/gemini/v1/chat/completions gemini-3.5-flash-lite",
      "http://gw/pools/groq/v1/chat/completions openai/gpt-oss-120b"]);
    expect(result).toMatchObject({ text: "Two panes are working.", pool: "groq:openai/gpt-oss-120b", handoff: null });
    // The audit carries result codes only, never the provider's or the operator's text.
    expect(deps.audit).toHaveBeenCalledWith("user:1", sessionId, { codes: ["gemini:gemini-3-flash-preview_429", "gemini:gemini-3.5-flash-lite_timeout", "groq:openai/gpt-oss-120b_200"],
      pool: "groq:openai/gpt-oss-120b", tools: [], handoff: false });
  });

  it("answers the failure line when every pool fails, and still writes both lines with via live", async () => {
    const { live, calls, messages } = setup(NOUS_LIVE_POOLS.map(() => timeout));
    const { sessionId } = live.start(caller);
    const result = await live.turn(caller, { sessionId, text: "Hello", clientId: "c1" });
    expect(calls).toHaveLength(NOUS_LIVE_POOLS.length);
    expect(result).toMatchObject({ text: "I can't answer right now. Shall I send it to Nous?", pool: null });
    expect(messages.map((message) => [message.kind, message.content, message.meta])).toEqual([
      ["OPERATOR", "Hello", { person: true, via: "live", liveSession: sessionId, mobile: caller.mobile, clientId: "c1" }],
      ["ANSWER", result.text, expect.objectContaining({ via: "live", liveSession: sessionId, replyTo: ["m1"], beside: true })]]);
  });

  it("moves on when a pool answers 200 with no text and no tool call (S6 probe 16/11: groq gpt-oss)", async () => {
    const { live, deps } = setup([timeout, timeout, () => ok({ content: "" }), () => ok({ content: "It is 9 in Bangkok." })]);
    const { sessionId } = live.start(caller);
    expect(await live.turn(caller, { sessionId, text: "What time is it?" })).toMatchObject({ text: "It is 9 in Bangkok.", pool: "inception:mercury-3" });
    expect(deps.audit).toHaveBeenCalledWith("user:1", sessionId, expect.objectContaining({ codes: expect.arrayContaining(["groq:openai/gpt-oss-120b_empty", "inception:mercury-3_200"]) }));
  });

  it("answers the failure line with no key, calling no pool", async () => {
    const { live, calls } = setup([], { keyFile: join(tmpdir(), "nous-live-missing-key") });
    const { sessionId } = live.start(caller);
    expect((await live.turn(caller, { sessionId, text: "Hi" })).pool).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("never runs a tool outside the six, and lists signed decisions instead of answering them", async () => {
    const saveNote = vi.fn(async () => undefined);
    const { live, calls } = setup([
      () => ok({ content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "answer_decision", arguments: "{\"id\":\"d1\",\"approve\":true}" } }] }),
      () => ok({ content: "That needs your signature." })], {
      saveNote, openDecisions: async () => [{ id: "d1", title: "Ship 2.0", category: "RELEASE" }, { id: "d2", title: "Pick a name", category: "CHOICE" },
        { id: "d3", title: "Send the offer", category: "EXTERNAL" }] as never });
    const { sessionId } = live.start(caller);
    const result = await live.turn(caller, { sessionId, text: "Approve the release" });
    expect(result.needsSignature).toEqual(["d1", "d3"]);
    expect(result.toolEvents).toEqual([]);
    expect(calls[1]!.body.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining("There is no tool") });
  });

  it("hands real work to Nous as the phone's person", async () => {
    const { live, deps } = setup([() => ok({ content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "ask_nous", arguments: "{\"task\":\"Deploy the fix\"}" } }] })]);
    const { sessionId } = live.start(caller);
    const result = await live.turn(caller, { sessionId, text: "Deploy the fix", clientId: "c2" });
    expect(result.handoff).toEqual({ messageId: "handoff:1" });
    expect(result.text).toBe("I'm passing this to Nous.");
    expect(deps.send).toHaveBeenCalledWith("user:1", expect.stringContaining("Deploy the fix"), { person: true, mobile: caller.mobile, clientId: "c2:handoff" });
  });

  it("keeps the context within its named budget and redacts secrets before any pool sees them", async () => {
    const stripe = `sk_live_${"a1B2".repeat(8)}`;
    const { live, calls } = setup([() => ok({ content: "Noted." })], {
      board: async () => `pane: ${"x".repeat(20_000)}`,
      recall: async () => Array.from({ length: 400 }, (_, index) => ({ title: `fact ${index}`, body: "y".repeat(200) }))
    });
    const { sessionId } = live.start(caller);
    await live.turn(caller, { sessionId, text: `My key is ${stripe}` });
    const sent = JSON.stringify(calls[0]!.body);
    expect(sent).not.toContain(stripe);
    const budget = Object.values(NOUS_LIVE_CONTEXT_CHARS).reduce((sum, chars) => sum + chars, 0);
    expect(calls[0]!.body.messages[0]!.content!.length).toBeLessThan(budget + 2_000);
  });

  it("keeps one session per device and closes it after the silence bound", async () => {
    let at = 1_000_000;
    const { live } = setup([() => ok({ content: "Hi." })], { now: () => at });
    const first = live.start(caller);
    const second = live.start(caller);
    await expect(live.turn(caller, { sessionId: first.sessionId, text: "Hi" })).rejects.toMatchObject({ statusCode: 409 });
    at += NOUS_LIVE_SILENCE_CLOSE_MS + 1;
    await expect(live.turn(caller, { sessionId: second.sessionId, text: "Hi" })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("Nous Live's realtime voice (nous_msg:7f739948)", () => {
  const google = { provider: "GOOGLE_AI" as const, status: "ACTIVE" as const, statusReason: null, primaryWindow: { usedPercent: null, windowMinutes: null, resetAt: null } };
  const token = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("lists the device voice and every Live pane provider, ready only where there is room, and says why the others are not", async () => {
    const { live } = setup([], { gatewayAccounts: async () => [google] as never, apiAccounts: () => [{ id: "openai", providerId: "openai", label: "OpenAI", status: "EXHAUSTED", sampledAt: null }] });
    const options = await live.voiceOptions("user:1");
    // Nothing saved: the free Gemini voice, never a paid one; the device voice when no free one has room.
    expect(options.choice).toEqual({ provider: "google" });
    expect(options.providers[0]).toMatchObject({ id: "device", label: "Device voice (free)", ready: true });
    const gemini = options.providers.find((provider) => provider.id === "google")!;
    expect(gemini).toMatchObject({ ready: true, free: true, state: expect.stringMatching(/free tier/) });
    // Only Google's bidirectional Live models; the Live pane's aliases stay out.
    expect(gemini.models.every((model) => /live|native-audio/.test(model.id))).toBe(true);
    expect(gemini.models.map((model) => model.id)).not.toContain("gemini-2.5-flash");
    const openai = options.providers.find((provider) => provider.id === "openai")!;
    expect(openai).toMatchObject({ ready: false, free: false, state: expect.stringMatching(/No balance/) });
    expect(options.providers.filter((provider) => provider.ready).map((provider) => provider.id)).toEqual(["device", "google"]);
    expect(options.providers.some((provider) => ["fish", "cartesia", "murf", "livekit", "assemblyai"].includes(provider.id))).toBe(false);

    const limited = setup([], { gatewayAccounts: async () => [{ ...google, status: "RATE_LIMITED", primaryWindow: { ...google.primaryWindow, resetAt: "2026-11-17T00:00:00.000Z" } }] as never });
    expect((await limited.live.voiceOptions("user:1")).providers.find((provider) => provider.id === "google")).toMatchObject({ ready: false, state: "Free quota used up; back 2026-11-17 00:00 UTC. Picked, Live starts the next voice with room." });
    expect((await limited.live.voiceOptions("user:1")).choice).toEqual({ provider: "device" });
  });

  it("starts a realtime session only on a ready provider, with Nous Live's context and six tools locked into the gateway's one-use token", async () => {
    const choice = { provider: "google", model: "gemini-3.1-flash-live-preview", voice: "Kore", language: "el" as const };
    const { live, calls } = setup([(_body, url) => {
      expect(url).toBe("http://gw/pools/gemini/v1/live/token");
      return token({ token: "auth_tokens/x", websocketUrl: "wss://google/ws?access_token=auth_tokens%2Fx", expiresAt: "2026-11-16T05:00:00.000Z" });
    }], { gatewayAccounts: async () => [google] as never, voiceChoice: async () => choice });
    const session = await live.realtime(caller);
    expect(session).toMatchObject({ provider: "google", model: "gemini-3.1-flash-live-preview", voice: "Kore", protocol: "gemini-live", websocketUrl: "wss://google/ws?access_token=auth_tokens%2Fx" });
    const setupBody = (calls[0]!.body as unknown as { setup: { model: string; systemInstruction: { parts: Array<{ text: string }> }; tools: Array<{ functionDeclarations: Array<{ name: string; parameters?: unknown }> }> } }).setup;
    expect(setupBody.model).toBe("models/gemini-3.1-flash-live-preview");
    expect(setupBody.systemInstruction.parts[0]!.text).toMatch(/You are Nous Live[\s\S]*in Greek[\s\S]*# Now/);
    expect(setupBody.tools[0]!.functionDeclarations.map((tool) => tool.name)).toEqual(["time_now", "nous_now", "inbox_summary", "memory_recall", "create_note", "ask_nous"]);
    expect(setupBody.tools[0]!.functionDeclarations.find((tool) => tool.name === "time_now")!.parameters).toBeUndefined();

    const device = setup([], { voiceChoice: async () => ({ provider: "device" }) });
    await expect(device.live.realtime(caller)).rejects.toMatchObject({ statusCode: 409 });
    // Nothing with room: the error names every reason, and no provider is called.
    const paid = setup([], { voiceChoice: async () => ({ provider: "openai" }), gatewayAccounts: async () => [{ ...google, status: "RATE_LIMITED" }] as never });
    await expect(paid.live.realtime(caller)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/OpenAI/) });
    expect(paid.calls).toHaveLength(0);
  });

  const relayed = [{ id: "vercel", configured: true }, { id: "local", configured: true }, { id: "openai", configured: true }, { id: "amazon", configured: false, missingReason: "Amazon Nova 2 Sonic credentials not configured on Space." }];

  it("makes every row selectable: OpenAI, Vercel and the Local PC through Space's relay, the others with their reason (nous_msg:85541f3e)", async () => {
    const { live } = setup([], { gatewayAccounts: async () => [{ ...google, status: "RATE_LIMITED" }] as never, relayProviders: async () => relayed,
      relay: vi.fn(), apiAccounts: () => [{ id: "openai", providerId: "openai", label: "OpenAI", status: "EXHAUSTED", sampledAt: null }] });
    const rows = Object.fromEntries((await live.voiceOptions("user:1")).providers.map((row) => [row.id, row]));
    expect(Object.keys(rows).sort()).toEqual(["amazon", "device", "google", "local", "openai", "vercel"]);
    expect(Object.values(rows).some((row) => /Live pane only/.test(row.state))).toBe(false);
    expect(rows.vercel).toMatchObject({ ready: true, state: "Through Space's relay.", defaultModel: "openai/gpt-realtime-2.1", defaultVoice: "alloy" });
    expect(rows.vercel!.models.map((model) => model.id)).not.toContain("openai/gpt-live-1");
    expect(rows.local).toMatchObject({ ready: true, state: expect.stringMatching(/Local PC/) });
    expect(rows.amazon).toMatchObject({ ready: false, state: expect.stringMatching(/credentials not configured[\s\S]*Picked, Live starts the next voice/) });
    expect(rows.openai).toMatchObject({ ready: false, state: expect.stringMatching(/^No balance[\s\S]*Picked, Live starts the next voice/) });
    // OpenAI's own key through the relay: only the realtime GA models its protocol speaks.
    expect(rows.openai!.models.map((model) => model.id).every((id) => id.startsWith("gpt-realtime"))).toBe(true);
    const funded = setup([], { relayProviders: async () => relayed, relay: vi.fn() });
    expect((await funded.live.voiceOptions("user:1")).providers.find((row) => row.id === "openai")).toMatchObject({ ready: true, state: "Through Space's relay." });
    expect(rows.google).toMatchObject({ ready: false, state: expect.stringMatching(/^Free quota used up[\s\S]*Picked/) });
    // Without the relay (a public install) the relayed rows say so instead.
    const bare = setup([], { relayProviders: async () => relayed });
    expect((await bare.live.voiceOptions("user:1")).providers.find((row) => row.id === "vercel")).toMatchObject({ ready: false, state: expect.stringMatching(/relay is not set up/) });
  });

  it("starts a relayed provider with the session's context and tools held by the server", async () => {
    const relay = vi.fn(async () => ({ websocketUrl: "/api/nous/live/relay/abc", expiresAt: "2026-11-21T06:00:00.000Z" }));
    const { live, calls } = setup([], { relayProviders: async () => relayed, relay, voiceChoice: async () => ({ provider: "vercel", language: "el" as const }) });
    const session = await live.realtime(caller);
    expect(session).toMatchObject({ provider: "vercel", model: "openai/gpt-realtime-2.1", voice: "alloy", protocol: "gemini-live", websocketUrl: "/api/nous/live/relay/abc", setup: {} });
    expect(session.fallback).toBeUndefined();
    expect(calls).toHaveLength(0);
    const plan = (relay.mock.calls[0] as unknown as [string, { language: string; instructions: string; tools: Array<{ name: string }> }])[1];
    expect(plan).toMatchObject({ provider: "vercel", language: "el", instructions: expect.stringMatching(/You are Nous Live[\s\S]*in Greek/) });
    expect(plan.tools.map((tool) => tool.name)).toEqual(["time_now", "nous_now", "inbox_summary", "memory_recall", "create_note", "ask_nous"]);
  });

  it("falls back from a provider without room or that fails, free first, and says why", async () => {
    const gateway = () => token({ websocketUrl: "wss://google/ws", expiresAt: "2026-11-21T06:00:00.000Z" });
    const noBalance = setup([gateway], { gatewayAccounts: async () => [google] as never, voiceChoice: async () => ({ provider: "openai" }),
      apiAccounts: () => [{ id: "openai", providerId: "openai", label: "OpenAI", status: "EXHAUSTED", sampledAt: null }] });
    expect(await noBalance.live.realtime(caller)).toMatchObject({ provider: "google", fallback: { from: "OpenAI", reason: expect.stringMatching(/No balance/) } });

    const relay = vi.fn(async (_owner: string, plan: { provider: string }) => {
      if (plan.provider === "local") throw new Error("Local provider returned HTTP 502.");
      return { websocketUrl: "/api/nous/live/relay/v", expiresAt: "2026-11-21T06:00:00.000Z" };
    });
    const down = setup([], { relayProviders: async () => relayed, relay, voiceChoice: async () => ({ provider: "local" }), gatewayAccounts: async () => [{ ...google, status: "RATE_LIMITED" }] as never });
    expect(await down.live.realtime(caller)).toMatchObject({ provider: "openai", fallback: { from: "Local PC (Qwen3 Greek)", reason: expect.stringMatching(/could not start: Local provider returned HTTP 502/) } });
    expect(down.deps.audit).toHaveBeenCalledWith("user:1", "none", expect.objectContaining({ codes: ["local:local-qwen3-greek_error"] }));

    const none = setup([], { relayProviders: async () => relayed, relay: vi.fn(async () => { throw new Error("upstream down"); }), voiceChoice: async () => ({ provider: "vercel" }),
      gatewayAccounts: async () => [{ ...google, status: "RATE_LIMITED" }] as never });
    await expect(none.live.realtime(caller)).rejects.toMatchObject({ statusCode: 502, message: expect.stringMatching(/Vercel AI Gateway could not start: upstream down[\s\S]*Local PC/) });
  });

  it("names a refused token in the picker until a session works again", async () => {
    const { live } = setup([() => new Response(JSON.stringify({ error: { message: "Quota exceeded for the free tier." } }), { status: 429 })],
      { gatewayAccounts: async () => [google] as never, voiceChoice: async () => ({ provider: "google" }) });
    await expect(live.realtime(caller)).rejects.toMatchObject({ statusCode: 502, message: expect.stringMatching(/Quota exceeded/) });
    expect((await live.voiceOptions("user:1")).providers.find((provider) => provider.id === "google")!.state).toMatch(/Last session failed: Quota exceeded/);
  });

  it("runs the realtime model's tool calls with the text turn's rules, hands off to Nous, and writes each exchange like a turn", async () => {
    const { live, deps, messages } = setup([() => token({ token: "t", websocketUrl: "wss://x" })], {
      gatewayAccounts: async () => [google] as never, voiceChoice: async () => ({ provider: "google" }),
      openDecisions: async () => [{ id: "dec:1", title: "Ship 0.6.1", category: "RELEASE" }] });
    const { sessionId } = await live.realtime(caller);
    expect(await live.realtimeTool(caller, { sessionId, name: "create_note", args: { text: "Buy milk" } })).toMatchObject({ output: "Saved.", event: { tool: "create_note", ok: true, detail: "Buy milk" }, handoff: null, needsSignature: ["dec:1"] });
    const exchange = await live.realtimeExchange(caller, { sessionId, heard: "Deploy the fix", said: "I'm passing this to Nous.", firstAudioMs: 640, clientId: "c1" });
    expect(messages.map((message) => [message.kind, message.content])).toEqual([["OPERATOR", "Deploy the fix"], ["ANSWER", "I'm passing this to Nous."]]);
    expect(exchange).toMatchObject({ userMessageId: "m1", answerMessageId: "m2", needsSignature: ["dec:1"] });
    expect(deps.audit).toHaveBeenCalledWith("user:1", sessionId, expect.objectContaining({ firstAudioMs: 640, realtime: true }));
    const handoff = await live.realtimeTool(caller, { sessionId, name: "ask_nous", args: { task: "Deploy the fix" }, clientId: "c2" });
    expect(handoff).toMatchObject({ handoff: { messageId: "handoff:1" }, event: { tool: "ask_nous", ok: true } });
    expect(deps.send).toHaveBeenCalledWith("user:1", expect.stringContaining("Operator: Deploy the fix"), expect.objectContaining({ person: true, clientId: "c2:handoff" }));
    await expect(live.realtimeTool(caller, { sessionId: "nous_live:other", name: "time_now" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("saves the chosen voice through setVoiceChoice and rejects unknown providers", async () => {
    let saved: unknown = null;
    const { live } = setup([], { saveVoiceChoice: async (_owner, choice) => { saved = choice; } });
    await expect(live.setVoiceChoice("user:1", { provider: "unknown" as never })).rejects.toMatchObject({ statusCode: 400 });
    const choice = await live.setVoiceChoice("user:1", { provider: "device" });
    expect(choice).toEqual({ provider: "device" });
    expect(saved).toEqual({ provider: "device" });
  });
});
