import { createHmac, generateKeyPairSync, createSign } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSlackEnvelope, verifySlackSignature } from "../src/channel-slack.js";
import { createBotFrameworkVerifier, parseTeamsActivity } from "../src/channel-teams.js";
import { registerDotChannelRoutes, type DotChannelService } from "../src/dot-channels.js";

const secret = "slack-signing-secret";
const sign = (body: string, timestamp: number, key = secret) => `v0=${createHmac("sha256", key).update(`v0:${timestamp}:${body}`).digest("hex")}`;

describe("Slack requests", () => {
  it("accepts only a fresh v0 signature over the exact body", () => {
    const now = 1_760_000_000_000, ts = Math.floor(now / 1000), body = '{"type":"event_callback"}';
    expect(verifySlackSignature({ rawBody: body, timestamp: String(ts), signature: sign(body, ts), signingSecret: secret, nowMs: now })).toBe(true);
    expect(verifySlackSignature({ rawBody: `${body} `, timestamp: String(ts), signature: sign(body, ts), signingSecret: secret, nowMs: now })).toBe(false);
    expect(verifySlackSignature({ rawBody: body, timestamp: String(ts), signature: sign(body, ts, "other"), signingSecret: secret, nowMs: now })).toBe(false);
    expect(verifySlackSignature({ rawBody: body, timestamp: String(ts - 301), signature: sign(body, ts - 301), signingSecret: secret, nowMs: now })).toBe(false);
    expect(verifySlackSignature({ rawBody: body, timestamp: undefined, signature: sign(body, ts), signingSecret: secret, nowMs: now })).toBe(false);
    expect(verifySlackSignature({ rawBody: body, timestamp: String(ts), signature: "v0=short", signingSecret: secret, nowMs: now })).toBe(false);
  });

  it("reads direct messages and mentions, and ignores bots, edits and ordinary channel talk", () => {
    expect(parseSlackEnvelope(JSON.stringify({ type: "url_verification", challenge: "abc" }))).toEqual({ kind: "challenge", challenge: "abc" });
    const event = (extra: Record<string, unknown>) => JSON.stringify({ type: "event_callback", event_id: "Ev1", team_id: "T1",
      event: { type: "message", channel: "D1", channel_type: "im", user: "U1", ts: "1.1", text: "Orbit: hello", ...extra } });
    expect(parseSlackEnvelope(event({}))).toMatchObject({ kind: "message", message: { provider: "SLACK", tenantId: "T1", eventId: "Ev1", conversationId: "D1",
      threadKey: "direct", conversationKind: "DIRECT", externalUserId: "U1", replyAddress: "U1", text: "Orbit: hello" } });
    expect(parseSlackEnvelope(event({ thread_ts: "0.9" }))).toMatchObject({ message: { threadKey: "0.9" } });
    expect(parseSlackEnvelope(event({ type: "app_mention", channel: "C1", channel_type: "channel", text: "<@B1> Nova: plan" })))
      .toMatchObject({ message: { conversationKind: "GROUP", threadKey: "1.1", text: "Nova: plan" } });
    expect(parseSlackEnvelope(event({ channel: "C1", channel_type: "channel" }))).toMatchObject({ kind: "ignored", reason: "not addressed" });
    expect(parseSlackEnvelope(event({ bot_id: "B1" }))).toMatchObject({ kind: "ignored" });
    expect(parseSlackEnvelope(event({ subtype: "message_changed" }))).toMatchObject({ kind: "ignored" });
  });
});

describe("Teams requests", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", endorsements: ["msteams"] };
  const token = (claims: Record<string, unknown>, kid = "key-1") => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey).toString("base64url");
    return `Bearer ${header}.${payload}.${signature}`;
  };
  const now = 1_760_000_000_000;
  const claims = { iss: "https://api.botframework.com", aud: "app-1", exp: now / 1000 + 600, nbf: now / 1000 - 10, serviceurl: "https://smba.trafficmanager.net/emea/" };
  const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("openidconfiguration")
    ? { jwks_uri: "https://login.botframework.com/v1/.well-known/keys" } : { keys: [jwk] })));

  it("accepts only Bot Framework tokens for this app, in time, for the activity's service", async () => {
    const verify = createBotFrameworkVerifier({ appId: "app-1", fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: () => now });
    const service = "https://smba.trafficmanager.net/emea";
    expect(await verify(token(claims), service)).toBe(true);
    expect(await verify(token({ ...claims, aud: "app-2" }), service)).toBe(false);
    expect(await verify(token({ ...claims, iss: "https://evil.example" }), service)).toBe(false);
    expect(await verify(token({ ...claims, exp: now / 1000 - 400 }), service)).toBe(false);
    expect(await verify(token(claims), "https://other.example")).toBe(false);
    expect(await verify(token({ ...claims, serviceurl: undefined }), service)).toBe(false);
    expect(await verify(token({ ...claims, serviceurl: "https://evil.example/" }), "https://evil.example")).toBe(false);
    expect(await verify(token(claims, "unknown"), service)).toBe(false);
    expect(await verify("Bearer nonsense", service)).toBe(false);
    expect(await verify(undefined, service)).toBe(false);
    const tampered = token(claims).replace(/\.([A-Za-z0-9_-]+)\./, (_m, p) => `.${Buffer.from(JSON.stringify({ ...claims, aud: "app-1", extra: 1 })).toString("base64url")}.`);
    expect(await verify(tampered, service)).toBe(false);
  });

  it("reads personal and channel messages without the bot mention", () => {
    const activity = { type: "message", channelId: "msteams", id: "a1", serviceUrl: "https://smba.trafficmanager.net/emea/", text: "<at>Space</at> Orbit: hi",
      conversation: { id: "19:abc@thread.tacv2;messageid=123", conversationType: "channel", tenantId: "t1" }, from: { id: "29:x", aadObjectId: "aad-1", name: "Maria" } };
    expect(parseTeamsActivity(activity)).toMatchObject({ provider: "TEAMS", tenantId: "t1", conversationId: "19:abc@thread.tacv2;messageid=123",
      threadKey: "19:abc@thread.tacv2;messageid=123", conversationKind: "GROUP", externalUserId: "aad-1", replyAddress: "29:x", text: "Orbit: hi", displayName: "Maria" });
    expect(parseTeamsActivity({ ...activity, conversation: { id: "a:1", conversationType: "personal", tenantId: "t1" } })?.conversationKind).toBe("DIRECT");
    expect(parseTeamsActivity({ ...activity, type: "conversationUpdate" })).toBeNull();
    expect(parseTeamsActivity({ ...activity, serviceUrl: "http://insecure" })).toBeNull();
    expect(parseTeamsActivity({ ...activity, serviceUrl: "https://attacker.example/" })).toBeNull();
    expect(parseTeamsActivity({ ...activity, channelId: "webchat" })).toBeNull();
    expect(parseTeamsActivity({ ...activity, conversation: { id: "a:1", conversationType: "personal" }, channelData: { tenant: { id: "t1" } } })).toBeNull();
  });
});

describe("channel routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
  it("verifies the raw body, answers Slack's challenge and acknowledges events before the Dot works", async () => {
    const app = Fastify(); apps.push(app);
    const handleInbound = vi.fn(async () => undefined);
    registerDotChannelRoutes(app, { handleInbound } as unknown as DotChannelService, { routeOptions: {}, authenticatedOwner: async () => "user:1",
      verifySlack: (input) => verifySlackSignature({ ...input, signingSecret: secret }), parseSlack: parseSlackEnvelope,
      verifyTeams: async (authorization) => authorization === "Bearer good", parseTeams: parseTeamsActivity, log: vi.fn() });
    const ts = Math.floor(Date.now() / 1000);
    const challenge = '{"type":"url_verification","challenge":"xyz"}';
    const post = (body: string, signature = sign(body, ts)) => app.inject({ method: "POST", url: "/api/channels/slack/events", payload: body,
      headers: { "content-type": "application/json", "x-slack-request-timestamp": String(ts), "x-slack-signature": signature } });
    expect((await post(challenge)).json()).toEqual({ challenge: "xyz" });
    expect((await post(challenge, sign(challenge, ts, "wrong"))).statusCode).toBe(401);
    const event = JSON.stringify({ type: "event_callback", event_id: "Ev9", team_id: "T1", event: { type: "message", channel: "D1", channel_type: "im", user: "U1", ts: "1.1", text: "hello" } });
    expect((await post(event)).statusCode).toBe(200);
    expect(handleInbound).toHaveBeenCalledWith(expect.objectContaining({ eventId: "Ev9", text: "hello" }));
    const teams = (authorization: string) => app.inject({ method: "POST", url: "/api/channels/teams/messages", headers: { authorization, "content-type": "application/json" },
      payload: { type: "message", channelId: "msteams", id: "a1", serviceUrl: "https://smba.trafficmanager.net/emea/", text: "hi", conversation: { id: "a:1", conversationType: "personal", tenantId: "t1" },
        from: { id: "29:x", aadObjectId: "aad-1" } } });
    expect((await teams("Bearer bad")).statusCode).toBe(401);
    expect((await teams("Bearer good")).statusCode).toBe(200);
    expect(handleInbound).toHaveBeenCalledTimes(2);
  });
});
