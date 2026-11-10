import { afterEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemoryNousSharedMemoryRepository } from "@space/db";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession, signSessionWithTtl } from "../src/auth.js";
import { createNousService } from "../src/nous/service.js";
import { InMemoryNousRepository } from "@space/db";
import { createSharedMemory, renderSharedMemory } from "../src/nous/shared-memory.js";
import { createNousTools, nousToolDefinitions } from "../src/nous/tools.js";
import { NOUS_SUBAGENT_EXCLUDED } from "../src/nous/subagents.js";
import { sharedMemorySeed } from "@space/contracts";
import { getApiConfig } from "../src/config.js";

const secret = "nous-shared-memory-test-session-secret";
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const headers = (id = "user:operator", role: "ADMIN" | "USER" = "ADMIN", extra: object = {}) => {
  const user = { id, role, email: "space@space.local", ...extra };
  const token = id === "user:operator-proof" ? signSessionWithTtl(user, secret, 120) : signSession(user, secret);
  return { cookie: `space_session=${token}`, "x-space-csrf-token": createCsrfToken(token, secret)! };
};
it("allows team-member reads and ADMIN-person writes; screens activation and detects stale edits", async () => {
  const app = await createApp({ store: new InMemorySpaceStore(), config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CLI_ENABLED: "false", SPACE_BROWSER_SESSIONS_ENABLED: "false" }), auth: { sessionSecret: secret, devLogin: false, secureCookies: false } }); apps.push(app);
  const url = "/api/nous/shared-memory";
  expect((await app.inject({ url })).statusCode).toBe(401);
  expect((await app.inject({ url, headers: headers("user:member", "USER") })).statusCode).toBe(200);
  for (const auth of [headers("user:member", "USER"), headers("user:operator-proof"), headers("user:operator", "ADMIN", { brokerScope: "ADMIN_ACTION:clipboard" })]) {
    expect((await app.inject({ method: "POST", url, headers: auth, payload: { title: "Evidence", body: "Verify the result.", tags: [] } })).statusCode).toBe(403);
  }
  expect((await app.inject({ method: "POST", url, headers: headers(), payload: { title: "Evidence", body: "Ask Alice.", tags: [] } })).statusCode).toBe(422);
  const created = await app.inject({ method: "POST", url, headers: headers(), payload: { title: "Evidence", body: "Verify the result.", tags: ["working"] } });
  expect(created.statusCode).toBe(201); const { entry } = created.json();
  const retired = await app.inject({ method: "PATCH", url: `${url}/${entry.id}`, headers: headers(), payload: { revision: entry.revision, status: "RETIRED" } });
  expect(retired.statusCode).toBe(200);
  expect(retired.json().entry.tags).toEqual(["working"]);
  expect((await app.inject({ method: "PATCH", url: `${url}/${entry.id}`, headers: headers(), payload: { revision: entry.revision, status: "ACTIVE" } })).statusCode).toBe(409);
  expect((await app.inject({ method: "DELETE", url: `${url}/${entry.id}`, headers: headers(), payload: { revision: retired.json().entry.revision } })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url, headers: headers(), payload: { title: "Evidence", body: "Verify the result.", tags: ["working"] } })).statusCode).toBe(409);

});
it("shares within an installation team, proposes without approval, deduplicates and curates once daily", async () => {
  const repository = new InMemoryNousSharedMemoryRepository();
  let notices = 0;
  const shared = createSharedMemory({ repository, multiUser: true, notice: async (_owner, _key, _text, done) => { notices++; await done(); } });
  await shared.propose("user:a", { title: "Evidence", body: "Verify the result.", tags: [] });
  expect((await shared.list("user:b")).filter((entry) => entry.source === "NOUS")).toHaveLength(1);
  expect((await shared.list("user:b")).find((entry) => entry.source === "NOUS")?.status).toBe("PROPOSED");
  expect(await shared.world("user:b")).not.toContain("Verify the result.");
  await shared.daily("user:a", "2026-10-29"); await shared.daily("user:b", "2026-10-29"); expect(notices).toBe(1);
  const privateTeam = createSharedMemory({ repository, multiUser: false });
  expect(await privateTeam.list("user:a")).not.toContainEqual(expect.objectContaining({ source: "NOUS" }));
  const tools = createNousTools({ sharedMemory: shared } as never);
  const ctx = { owner: "user:b", turnId: "turn:shared", callId: "call:shared", traceId: "trace:shared" };
  expect((await tools.execute("space_shared_memory_propose", { title: "Evidence", body: "Verify the result.", tags: [] }, ctx)).ok).toBe(true);
  // W45 step 2 (2/11: 4 privacy refusals stored FAILED): a hold, worded as final for the same words.
  expect(await tools.execute("space_shared_memory_propose", { title: "Evidence", body: "Verify the result, then ask Zorro.", tags: [] }, ctx)).toMatchObject({
    ok: false, refused: true, result: expect.stringMatching(/body word 6 "Zorro" reads as a name\..* Nothing proposed\. Do not call it again with the same words/) });
  expect(nousToolDefinitions({ copilots: false }).some((tool) => tool.name === "space_shared_memory_propose")).toBe(true);
  expect(NOUS_SUBAGENT_EXCLUDED.has("space_shared_memory_propose")).toBe(true);
});
// 4/11 Bruno/Kate: a 6,000-character cap walked entries in id order and hid 17 of 33 active ones, five SEED rules among them.
it("renders every active entry: identity, SEED, then the turn's relevant ones, with no cap of its own", () => {
  const entry = (id: string, title: string, body: string, seedKey: string | null = null) => ({ id, status: "ACTIVE", title, body, tags: [], seedKey, deleted: false });
  const filler = Array.from({ length: 20 }, (_, index) => entry(`nous_shared:${index.toString(16).padStart(2, "0")}`, "Evidence", "Verify the result. ".repeat(100)));
  const entries = [...filler, entry("nous_shared:ff-seed", "Goals", "Keep every goal moving.", "goals"),
    entry("nous_shared:fe-mail", "mail triage", "classify a mail by the sentence that asks for something."),
    entry("nous_shared:zz-identity", "Identity", "I am Nous.", "identity")] as never;
  const text = renderSharedMemory(entries, "Triage this mail from the job board");
  expect(text.length).toBeGreaterThan(6_000);
  expect(text).toContain("reference knowledge");
  const at = (id: string) => text.indexOf(`[${id}]`);
  expect(at("nous_shared:zz-identity")).toBeGreaterThan(0);
  expect(at("nous_shared:zz-identity")).toBeLessThan(at("nous_shared:ff-seed"));
  expect(at("nous_shared:ff-seed")).toBeLessThan(at("nous_shared:fe-mail"));
  expect(at("nous_shared:fe-mail")).toBeLessThan(at("nous_shared:00"));
  for (const row of filler) expect(text).toContain(`[${row.id}]`);
});

it("imports the shipped identity on the first read and merges new seed entries without replacing admin edits", async () => {
  const repository = new InMemoryNousSharedMemoryRepository();
  const shared = createSharedMemory({ repository, multiUser: true });
  expect(await shared.world("user:first")).toContain("I am Nous, from the Greek Νους (mind), the mind of SpaceApp");
  const identity = (await shared.list("user:first")).find((entry) => entry.seedKey === "identity")!;
  await shared.update("user:first", identity.id, identity.revision, { body: "I am Nous, working with care." });
  const restart = createSharedMemory({ repository, multiUser: true });
  expect(await restart.world("user:second")).toContain("working with care");
  expect((await restart.list("user:second")).filter((entry) => entry.seedKey !== null)).toHaveLength(sharedMemorySeed.entries.length);
});

it("reads every active entry through bounded tool pages", async () => {
  const shared = createSharedMemory({ repository: new InMemoryNousSharedMemoryRepository(), multiUser: true });
  for (let index = 0; index < 9; index++) await shared.create("user:a", { title: "Evidence", body: "Verify the result. ".repeat(90) + index, tags: [] });
  const tools = createNousTools({ sharedMemory: shared } as never);
  const expected = (await shared.list("user:a")).filter((entry) => entry.status === "ACTIVE").map((entry) => entry.id).sort();
  const seen: string[] = []; let offset: number | null = 0;
  do {
    const reply = await tools.execute("space_shared_memory_read", { offset }, { owner: "user:a", turnId: "turn:shared", callId: "call:shared", traceId: "trace:shared" });
    expect(reply.ok).toBe(true); expect(reply.result!.length).toBeLessThanOrEqual(6_000);
    const page = JSON.parse(reply.result!); seen.push(...page.entries.map((entry: { id: string }) => entry.id)); offset = page.nextOffset;
  } while (offset !== null);
  expect(seen.sort()).toEqual(expected);
});

it("retries failed or disabled daily inbox work without restarting and receipts only successful work", async () => {
  let enabled = true; let mode: "fail" | "stop" | "success" = "fail"; let calls = 0;
  const service = createNousService({ repository: new InMemoryNousRepository(),
    runner: async (_input, signal) => { calls++; if (mode === "fail") throw new Error("synthetic failure"); if (mode === "stop") await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })); return { text: "No new generic lesson.", isError: false }; },
    tools: { execute: async () => ({ ok: true, display: "ok", result: "ok" }) },
    world: async () => ({ text: "", overview: { plans: [], needsHands: [], trains: "", planMap: null } }),
    settings: async () => ({ enabled, maxTurnsPerHour: 20 }), saveSettings: async (_owner, value) => value,
    notifications: { raise: async () => ({}), resolve: async () => {} } as never, executeAction: async () => "ok",
    limits: { inboxDebounceMs: 1, retryMs: 60_000 }
  });
  const shared = createSharedMemory({ repository: new InMemoryNousSharedMemoryRepository(), multiUser: true,
    notice: (owner, key, text, done, discarded) => service.notice(owner, key, text, done, { soonMs: 1, onDiscard: discarded }) });
  const settle = async () => { for (let index = 0; index < 100; index++) { await new Promise((resolve) => setTimeout(resolve, 5)); const state = await service.state("user:a"); if (!state.inbox && state.status !== "THINKING") return; } throw new Error("Daily work did not settle"); };
  try {
    await shared.daily("user:a", "2026-10-29"); await settle(); expect(calls).toBe(1);
    expect((await shared.policy("user:a")).lastDailyDay).toBeNull();
    mode = "stop"; await shared.daily("user:a", "2026-10-29");
    for (let index = 0; calls < 2 && index < 100; index++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(service.stop("user:a")).toBe(true); await settle();
    enabled = false; await shared.daily("user:a", "2026-10-29"); enabled = true;
    mode = "success"; await shared.daily("user:a", "2026-10-29"); await settle(); expect(calls).toBe(3);
    expect((await shared.policy("user:a")).lastDailyDay).toBe("2026-10-29");
    await shared.daily("user:a", "2026-10-29"); expect(calls).toBe(3);
  } finally { service.stopAll(); }
});

it("keeps daily work retryable when its completion receipt cannot be saved", async () => {
  const repository = new InMemoryNousSharedMemoryRepository(); const claim = repository.claimDay.bind(repository); let fail = true;
  repository.claimDay = async (team, day) => { if (fail) { fail = false; throw new Error("synthetic receipt failure"); } return claim(team, day); };
  const shared = createSharedMemory({ repository, multiUser: true, notice: async (_owner, _key, _text, done) => done() });
  await expect(shared.daily("user:a", "2026-10-29")).rejects.toThrow("synthetic receipt failure");
  await shared.daily("user:a", "2026-10-29"); expect((await shared.policy("user:a")).lastDailyDay).toBe("2026-10-29");
});
