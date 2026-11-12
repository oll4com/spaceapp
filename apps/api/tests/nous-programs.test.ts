// Startup programs (operator 3/11 20:09 BKK, plan clipboard:17yLAnH5ZpyF): the data panes' files are imported by id
// (again only when they change, never over a program changed since, mails only added), the Nous page reads the registry through the
// routes (a person writes), and Nous lists, reads, upserts and adds mails with space_programs (helpers read only).
import Fastify from "fastify";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InMemoryNousProgramsRepository } from "@space/db";
import { createNousPrograms, registerNousProgramRoutes } from "../src/nous/programs.js";
import { createOperatorUpdates } from "../src/nous/operator-updates.js";
import type { SpaceNotification } from "@space/contracts";
import { NOUS_SUBAGENT_EXCLUDED } from "../src/nous/subagents.js";
import { createNousTools, nousToolDefinitions } from "../src/nous/tools.js";

const owner = "user:operator";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "nous-programs-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const mail = { date: "2026-10-21T08:00:00Z", direction: "sent", from: "ntheo@spaceapp.dev", to: "inception@nvidia.com", subject: "Inception application",
  gmailAccount: "ntheo@spaceapp.dev", threadId: "19a0b2c3d4" };
const inception = { id: "nvidia-inception", page: "startup", parent: "NVIDIA", program: "NVIDIA Inception", project: "SpaceApp", url: "https://www.nvidia.com/en-us/startups/",
  status: "APPROVED", statusReason: "", appliedAt: "2026-10-20", decidedAt: "2026-10-22T09:00:00Z", expectedReplyBy: null, validUntil: null,
  amount: { text: "$10.000 AWS credits", value: 10000, currency: "USD" }, commitments: "Keep the company profile current", account: "ntheo@spaceapp.dev",
  contacts: ["inception@nvidia.com"], mails: [mail], nextAction: "Claim the AWS credits", reapply: { needed: false, why: null, when: null },
  sources: ["space_memory:abc123"], notes: "", whatItIs: "NVIDIA's program for AI startups", howWeUse: "GPU and AWS credits for SpaceApp's models; nothing from you" };
const google = { id: "google-cloud-startups", page: "startup", parent: "Google", program: "Google for Startups Cloud", status: "REJECTED",
  statusReason: "Founding team not verified", reapply: { needed: true, why: "Appeal #00317095 open", when: "2026-11-10" } };
const write = (name: string, document: unknown) => writeFile(join(dir, name), typeof document === "string" ? document : JSON.stringify(document));

it("imports the data files by id, idempotently, entry by entry, and never over a program changed since", async () => {
  let clock = Date.parse("2026-11-03T13:00:00Z");
  const repository = new InMemoryNousProgramsRepository();
  const warnings: string[] = [];
  const programs = createNousPrograms({ repository, now: () => clock, warn: (_error, message) => warnings.push(message) });
  // A file still being written is skipped until it changes again.
  await write("startup-programs.json", "{\"generatedAt\": \"2026-11-03T12:00:00Z\", \"entries\": [");
  expect(await programs.importFiles(owner, dir, join(dir, "usage.json"))).toEqual([]);
  expect(warnings).toHaveLength(1);
  await write("startup-programs.json", { generatedAt: "2026-11-03T12:00:00Z", entries: [inception, google, { id: "bad entry", status: "MAYBE" }, { id: "lambda" }] });
  await write("oll4-funding.json", { entries: [{ id: "meta-hackathon", parent: "Meta", program: "Llama Impact hackathon", project: "LoopCloser", status: "in progress" }] });
  await utimes(join(dir, "startup-programs.json"), new Date(), new Date(Date.now() + 5_000));
  const first = await programs.importFiles(owner, dir, join(dir, "usage.json"));
  // The removed oll4.com funding page's file (operator 7/11, nous_msg:e9c06cd838de45f4bccda467) is no longer read.
  expect(first.map(({ page, written, problems }) => [page, written, problems.length])).toEqual([["startup", 2, 2]]);
  expect(first[0]!.problems.join("\n")).toMatch(/lambda: a new program needs parent, program and status/);
  const stored = (await programs.get(owner, "nvidia-inception"))!;
  expect(stored).toMatchObject({ page: "startup", status: "APPROVED", statusReason: null, notes: null, appliedAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-11-03T12:00:00.000Z" });
  expect(stored.mails).toEqual([{ ...mail, date: "2026-10-21T08:00:00.000Z", direction: "SENT", to: ["inception@nvidia.com"] }]);
  expect(await programs.get(owner, "meta-hackathon")).toBeNull();
  // Unchanged files are not read again; the same file read again (a restart) writes the same rows.
  expect(await programs.importFiles(owner, dir, join(dir, "usage.json"))).toEqual([]);
  const before = await programs.list(owner);
  await programs.importDocument(owner, "startup", { generatedAt: "2026-11-03T12:00:00Z", entries: [inception, google] }, "2026-11-03T12:00:00Z");
  expect(await programs.list(owner)).toEqual(before);

  // Nous changes Google's program after the file was written: the same file again leaves it, adding only a mail it did not have.
  clock = Date.parse("2026-11-03T14:00:00Z");
  await programs.upsert(owner, { id: "google-cloud-startups", status: "APPLIED", statusReason: "Appeal sent" });
  const reply = { date: "2026-11-02T10:00:00Z", direction: "RECEIVED", from: "cloud-startups@google.com", to: ["ntheo@spaceapp.dev"], subject: "Your application" };
  await programs.importDocument(owner, "startup", { generatedAt: "2026-11-03T12:00:00Z", entries: [{ ...google, mails: [reply] }] }, "2026-11-03T12:00:00Z");
  expect(await programs.get(owner, "google-cloud-startups")).toMatchObject({ status: "APPLIED", statusReason: "Appeal sent", updatedAt: "2026-11-03T14:00:00.000Z",
    mails: [expect.objectContaining({ from: "cloud-startups@google.com", gmailAccount: null, threadId: null })] });
  // A newer file wins over the older change; mails Nous added stay.
  await programs.addMail(owner, "nvidia-inception", { ...mail, date: "2026-10-25T08:00:00Z", subject: "Credits claimed" });
  await programs.importDocument(owner, "startup", { generatedAt: "2026-11-03T15:00:00Z", entries: [{ ...inception, status: "EXPIRED" }] }, "2026-11-03T15:00:00Z");
  const newer = (await programs.get(owner, "nvidia-inception"))!;
  expect(newer.status).toBe("EXPIRED");
  expect(newer.mails.map((entry) => entry.subject)).toEqual(["Inception application", "Credits claimed"]);
  expect(newer.createdAt).toBe(stored.createdAt);
  expect(await programs.list("user:other")).toEqual([]);
});

it("refuses links that are not web addresses and thread ids that would break the Gmail link", async () => {
  const programs = createNousPrograms({ repository: new InMemoryNousProgramsRepository() });
  expect(await programs.upsert(owner, { ...google, id: "x1", url: "javascript:alert(1)" })).toMatchObject({ problem: expect.stringMatching(/url/) });
  expect(await programs.upsert(owner, { ...google, id: "x2", mails: [{ ...mail, threadId: "a/../b" }] })).toMatchObject({ problem: expect.stringMatching(/threadId/) });
  expect(await programs.addMail(owner, "missing", mail)).toEqual({ problem: "No program missing" });
});

it("answers the pages' routes: the list per page, one program, and an upsert only a person makes", async () => {
  const programs = createNousPrograms({ repository: new InMemoryNousProgramsRepository() });
  await programs.upsert(owner, inception);
  // A writer still naming the removed oll4-funding page lands on startup; one naming no page too.
  expect((await programs.upsert(owner, { id: "meta-hackathon", page: "oll4-funding", parent: "Meta", program: "Llama Impact hackathon", status: "APPLIED" }))).toMatchObject({ program: { page: "startup" } });
  expect((await programs.upsert(owner, { id: "loopcloser-grant", parent: "EU", program: "Grant", project: "LoopCloser", status: "DRAFT" }))).toMatchObject({ program: { page: "startup" } });
  const app = Fastify();
  let person = true;
  registerNousProgramRoutes(app, { programs, routeOptions: {}, owner: async () => owner, parseQuery: (schema, value) => schema.parse(value),
    assertPerson: () => { if (!person) throw Object.assign(new Error("Only the operator."), { statusCode: 403 }); } });
  try {
    expect((await app.inject("/api/nous/programs?page=startup")).json().programs.map((row: { id: string }) => row.id)).toEqual(["loopcloser-grant", "meta-hackathon", "nvidia-inception"]);
    expect((await app.inject("/api/nous/programs?page=oll4-funding")).json().programs).toHaveLength(3);
    expect((await app.inject("/api/nous/programs")).json().programs).toHaveLength(3);
    expect((await app.inject("/api/nous/programs/nvidia-inception")).json().program).toMatchObject({ program: "NVIDIA Inception", mails: [expect.objectContaining({ direction: "SENT" })] });
    expect((await app.inject("/api/nous/programs/missing")).statusCode).toBe(404);
    person = false;
    expect((await app.inject({ method: "POST", url: "/api/nous/programs", payload: { id: "nvidia-inception", status: "EXPIRED" } })).statusCode).toBe(403);
    person = true;
    const saved = await app.inject({ method: "POST", url: "/api/nous/programs", payload: { id: "nvidia-inception", status: "EXPIRED" } });
    expect(saved.json()).toMatchObject({ created: false, program: { status: "EXPIRED", amount: inception.amount } });
    expect((await app.inject({ method: "POST", url: "/api/nous/programs", payload: { id: "new-one", status: "APPLIED" } })).statusCode).toBe(400);
    person = false;
    expect((await app.inject({ method: "DELETE", url: "/api/nous/programs/meta-hackathon" })).statusCode).toBe(403);
    person = true;
    expect((await app.inject({ method: "DELETE", url: "/api/nous/programs/meta-hackathon" })).json()).toEqual({ removed: true });
    expect((await app.inject({ method: "DELETE", url: "/api/nous/programs/meta-hackathon" })).statusCode).toBe(404);
  } finally { await app.close(); }
});

it("gives Nous space_programs to list with filters, read, upsert and add mails; helpers only read", async () => {
  const programs = createNousPrograms({ repository: new InMemoryNousProgramsRepository() });
  await programs.upsert(owner, inception);
  await programs.upsert(owner, google);
  const tools = createNousTools({ programs } as never);
  const ctx = { owner, turnId: "turn:programs", callId: "call:programs", traceId: "trace:programs" };
  const all = await tools.execute("space_programs", { action: "list" }, ctx);
  expect(all.result.split("\n")).toHaveLength(2);
  const again = await tools.execute("space_programs", { action: "list", reapply: true }, ctx);
  expect(again.result).toBe("- [google-cloud-startups] Google › Google for Startups Cloud · REJECTED · 0 mails · RE-APPLY: Appeal #00317095 open");
  expect((await tools.execute("space_programs", { action: "list", status: "APPROVED", query: "nvidia spaceapp" }, ctx)).result).toContain("[nvidia-inception]");
  expect((await tools.execute("space_programs", { action: "list", query: "microsoft" }, ctx)).result).toBe("No program matches.");
  // R83: a guessed id is answered with the ids sharing its words.
  expect((await tools.execute("space_programs", { action: "read", id: "nvidia-credits" }, ctx)).result).toContain("Ids with its words: nvidia-inception.");
  const read = await tools.execute("space_programs", { action: "read", id: "nvidia-inception" }, ctx);
  expect(read.result).toContain("https://mail.google.com/mail/u/?authuser=ntheo%40spaceapp.dev#all/19a0b2c3d4");
  expect(read.result).toContain("Commitments: Keep the company profile current");
  const helper = { ...ctx, turn: { reason: "HELPER" } } as never;
  expect((await tools.execute("space_programs", { action: "read", id: "nvidia-inception" }, helper)).ok).toBe(true);
  expect((await tools.execute("space_programs", { action: "upsert", entry: { id: "nvidia-inception", status: "EXPIRED" } }, helper)).ok).toBe(false);
  const added = await tools.execute("space_programs", { action: "upsert", entry: { id: "microsoft-founders-hub", page: "startup", parent: "Microsoft",
    program: "Founders Hub", status: "APPLIED", expectedReplyBy: "2026-11-20" } }, ctx);
  expect(added).toMatchObject({ ok: true, display: "Added Founders Hub" });
  const mailed = await tools.execute("space_programs", { action: "add_mail", id: "microsoft-founders-hub", mail: { ...mail, to: ["foundershub@microsoft.com"] } }, ctx);
  expect(mailed).toMatchObject({ ok: true, display: "Updated Founders Hub" });
  expect((await programs.get(owner, "microsoft-founders-hub"))!.mails).toHaveLength(1);
  expect((await tools.execute("space_programs", { action: "add_mail", id: "microsoft-founders-hub" }, ctx)).ok).toBe(false);
  expect((await tools.execute("space_programs", { action: "delete", id: "google-cloud-startups" }, helper)).ok).toBe(false);
  expect(await tools.execute("space_programs", { action: "delete", id: "google-cloud-startups" }, ctx)).toMatchObject({ ok: true, display: "Deleted the program google-cloud-startups" });
  expect(await programs.get(owner, "google-cloud-startups")).toBeNull();
  expect((await tools.execute("space_programs", { action: "delete", id: "google-cloud-startups" }, ctx)).ok).toBe(false);
  expect(nousToolDefinitions({ copilots: false }).map((tool) => tool.name)).toContain("space_programs");
  expect(NOUS_SUBAGENT_EXCLUDED.has("space_programs")).toBe(false);
});

it("keeps what a program gives as benefit lines and its tiers, replaced whole by an upsert, and shows them to Nous", async () => {
  const programs = createNousPrograms({ repository: new InMemoryNousProgramsRepository() });
  const benefit = { what: "API credits", account: "crew@spaceapp.dev", total: "$1,000", used: { text: "$250", value: 250, currency: "USD" }, usageAt: "2026-11-03",
    status: "active", source: "mail 9/10" };
  await programs.upsert(owner, { ...inception, benefits: [benefit, { what: "Team seat" }], tiers: [{ name: "Registered", status: "reached" }, { name: "Select", status: "next", gives: "Co-sell" }] });
  const stored = (await programs.get(owner, "nvidia-inception"))!;
  expect(stored.benefits[0]).toEqual({ what: "API credits", account: "crew@spaceapp.dev", perMonth: null, total: { text: "$1,000", value: null, currency: null },
    used: { text: "$250", value: 250, currency: "USD" }, remaining: null, usageAt: "2026-11-03T00:00:00.000Z", validUntil: null, status: "ACTIVE", source: "mail 9/10", notes: null, allocations: [] });
  expect(stored.benefits[1]).toMatchObject({ what: "Team seat", status: "NOT_VERIFIED" });
  // Usage written later replaces the lines whole; an upsert that leaves them out keeps them.
  await programs.upsert(owner, { id: "nvidia-inception", benefits: [{ ...benefit, used: { text: "$400", value: 400, currency: "USD" } }] });
  await programs.upsert(owner, { id: "nvidia-inception", status: "APPROVED" });
  expect((await programs.get(owner, "nvidia-inception"))!.benefits.map((line) => line.used?.text)).toEqual(["$400"]);
  expect(await programs.upsert(owner, { id: "nvidia-inception", tiers: [{ name: "Gold", status: "platinum" }] })).toMatchObject({ problem: expect.stringMatching(/tiers/) });
  const read = await createNousTools({ programs } as never).execute("space_programs", { action: "read", id: "nvidia-inception" },
    { owner, turnId: "turn:b", callId: "call:b", traceId: "trace:b" });
  expect(read.result).toContain("- API credits · ACTIVE · crew@spaceapp.dev · total $1,000 · used $400 (usage as of 2026-11-03T00:00:00.000Z) · source mail 9/10");
  expect(read.result).toContain("- Select · NEXT · gives: Co-sell");
});

it("lays the daily usage report on the stored benefit lines, and a data file written later keeps it", async () => {
  const programs = createNousPrograms({ repository: new InMemoryNousProgramsRepository(), now: () => Date.parse("2026-11-03T16:00:00Z") });
  const credits = { what: "API credits", total: { text: "$1,500", value: 1500, currency: "USD" }, status: "ACTIVE" };
  await write("startup-programs.json", { generatedAt: "2026-11-03T12:00:00Z", entries: [{ ...inception, benefits: [credits, { what: "Team seat", account: "dev@spaceapp.dev" }] }] });
  const usage = { generatedAt: "2026-11-03T15:00:00Z", entries: [
    { id: "nvidia-inception", benefits: [{ ...credits, total: "$9", used: { text: "$499.60", value: 499.6, currency: "USD" }, remaining: { text: "$1,000.40", value: 1000.4, currency: "USD" },
      usageAt: "2026-11-03T14:52:31+00:00", notes: "~$184/month reaches 100% by 17/4/2027", validUntil: "2027-10-17", allocations: [{ project: "spaceapp.dev", percent: 75, purpose: "Nous" }, { project: "oll4.com", percent: 25 }] },
      { what: "DLI codes", total: { text: "20 codes", value: 20 }, used: { text: "14 codes", value: 14 }, status: "ACTIVE" }] },
    { id: "nobody", benefits: [] }, { id: "nvidia-inception", benefits: [{ status: "ACTIVE" }] }] };
  await write("usage.json", usage);
  const results = await programs.importFiles(owner, dir, join(dir, "usage.json"));
  expect(results.map(({ page, written, problems }) => [page, written, problems.length])).toEqual([["startup", 1, 0], ["usage", 1, 2]]);
  let stored = (await programs.get(owner, "nvidia-inception"))!;
  // Usage only: the stored total stays, the program's updatedAt stays, a line not stored yet is added.
  expect(stored.benefits.map((line) => [line.what, line.total?.text, line.used?.text, line.allocations.length])).toEqual([
    ["API credits", "$1,500", "$499.60", 2], ["Team seat", undefined, undefined, 0], ["DLI codes", "20 codes", "14 codes", 0]]);
  expect(stored.updatedAt).toBe("2026-11-03T12:00:00.000Z");
  expect(stored.benefits[0]!.notes).toBe("~$184/month reaches 100% by 17/4/2027");
  expect(stored.benefits[0]!.validUntil).toBe("2027-10-17T00:00:00.000Z");
  // The programs file changes again (its lines whole): the measured usage stays on its lines, and the report is laid on again at once.
  await write("startup-programs.json", { generatedAt: "2026-11-03T17:00:00Z", entries: [{ ...inception, benefits: [{ ...credits, validUntil: "2027-04-17" }] }] });
  await utimes(join(dir, "startup-programs.json"), new Date(), new Date(Date.now() + 5_000));
  expect((await programs.importFiles(owner, dir, join(dir, "usage.json"))).map((result) => result.page)).toEqual(["startup", "usage"]);
  stored = (await programs.get(owner, "nvidia-inception"))!;
  expect(stored.benefits.map((line) => [line.what, line.used?.text, line.validUntil])).toEqual([
    ["API credits", "$499.60", "2027-10-17T00:00:00.000Z"], ["DLI codes", "14 codes", null]]);
});

it("accrues a recurring line from its start on every read: a month once it starts, the term as its total, the stored row untouched (operator 7/11)", async () => {
  let at = Date.parse("2026-11-07T07:00:00Z");
  const repository = new InMemoryNousProgramsRepository(), programs = createNousPrograms({ repository, now: () => at });
  const seat = { what: "Team seat", account: "dev@spaceapp.dev", perMonth: { text: "$100/month", value: 100, currency: "USD" }, validUntil: "2027-10-17", status: "ACTIVE" };
  const pooled = { what: "Pooled API credits", perMonth: { text: "$500/month", value: 500, currency: "USD" }, status: "ACTIVE" };
  await write("startup-programs.json", { generatedAt: "2026-11-07T06:00:00Z", entries: [{ ...inception, benefits: [{ ...seat, since: "2026-10-17" }, pooled] }] });
  // The daily report writes the seat's activity as its used text and no start; the start stays.
  await write("usage.json", { generatedAt: "2026-11-07T06:30:00Z", entries: [{ id: "nvidia-inception", benefits: [{ ...seat, used: "within the last 7 days", usageAt: "2026-11-07T05:00:00Z" }] }] });
  await programs.importFiles(owner, dir, join(dir, "usage.json"));
  const line = async (index = 0) => (await programs.get(owner, "nvidia-inception"))!.benefits[index]!;
  expect(await line()).toMatchObject({ total: { text: "$1,200 (12 × $100/month)", value: 1200, currency: "USD" }, used: { text: "$100 (month 1 of 12)", value: 100 },
    remaining: { value: 1100 }, usageAt: "2026-11-07T07:00:00.000Z" });
  expect((await programs.list(owner))[0]!.benefits[0]!.used?.value).toBe(100);
  // A line with no start is never accrued (credits, not a seat), and nothing accrued is written back.
  expect(await line(1)).toMatchObject({ total: null, used: null });
  expect((await repository.get(owner, "nvidia-inception"))!.benefits[0]!.used?.text).toBe("within the last 7 days");
  // The programs file rewrites the lines without the start: it is kept.
  await write("startup-programs.json", { generatedAt: "2026-11-07T08:00:00Z", entries: [{ ...inception, benefits: [seat, pooled] }] });
  await utimes(join(dir, "startup-programs.json"), new Date(), new Date(Date.now() + 5_000));
  await programs.importFiles(owner, dir, join(dir, "usage.json"));
  at = Date.parse("2026-12-16T23:00:00Z");
  expect((await line()).used?.text).toBe("$200 (month 2 of 12)");
  at = Date.parse("2028-01-01T00:00:00Z");
  expect(await line()).toMatchObject({ used: { value: 1200 }, remaining: { value: 0 } });
});

it("takes the file's money flag for a row that has none, even when the row changed since the file, and keeps a flag already set", async () => {
  const programs = createNousPrograms({ repository: new InMemoryNousProgramsRepository(), now: () => Date.parse("2026-11-03T16:00:00Z") });
  await programs.upsert(owner, inception);
  await programs.upsert(owner, { ...google, page: "startup", givesMoney: false });
  await programs.importDocument(owner, "startup", { generatedAt: "2026-11-03T12:00:00Z",
    entries: [{ ...inception, status: "EXPIRED", givesMoney: true }, { ...google, givesMoney: true }] }, "2026-11-03T12:00:00Z");
  expect(await programs.get(owner, "nvidia-inception")).toMatchObject({ status: "APPROVED", givesMoney: true });
  expect((await programs.get(owner, "google-cloud-startups"))!.givesMoney).toBe(false);
  const tools = createNousTools({ programs } as never);
  const ctx = { owner, turnId: "turn:m", callId: "call:m", traceId: "trace:m" };
  expect((await tools.execute("space_programs", { action: "list", status: "APPROVED" }, ctx)).result).toContain("· MONEY");
  expect((await tools.execute("space_programs", { action: "read", id: "google-cloud-startups" }, ctx)).result).toContain("Gives money: no");
});

it("stores the files' tags; a row changed since the file takes them only when it has none (operator 6/11 21:42 BKK, nous_msg:f0287998)", async () => {
  const repository = new InMemoryNousProgramsRepository();
  const programs = createNousPrograms({ repository, now: () => Date.parse("2026-11-03T16:00:00Z") });
  await programs.upsert(owner, inception);
  await programs.upsert(owner, { ...google, page: "startup", tags: ["Server-Access"] });
  const put = vi.spyOn(repository, "put");
  // Older than both rows: only the tags fill the row without any; the other's own stay, and nothing else is written.
  await programs.importDocument(owner, "startup", { generatedAt: "2026-11-03T12:00:00Z",
    entries: [{ ...inception, status: "EXPIRED", tags: ["ai-tokens", "cash-grants"] }, { ...google, tags: ["perks"] }] }, "2026-11-03T12:00:00Z");
  expect(await programs.get(owner, "nvidia-inception")).toMatchObject({ status: "APPROVED", tags: ["ai-tokens", "cash-grants"] });
  expect((await programs.get(owner, "google-cloud-startups"))!.tags).toEqual(["server-access"]);
  expect(put).toHaveBeenCalledTimes(1);
  put.mockClear();
  await programs.importDocument(owner, "startup", { generatedAt: "2026-11-03T12:00:00Z", entries: [{ ...inception }] }, "2026-11-03T12:00:00Z");
  expect(put).not.toHaveBeenCalled();
  const tools = createNousTools({ programs } as never);
  expect((await tools.execute("space_programs", { action: "read", id: "nvidia-inception" }, { owner, turnId: "turn:t", callId: "call:t", traceId: "trace:t" })).result)
    .toContain("Tags: ai-tokens, cash-grants");
});

// R73 (operator 4/11 15:04 and 15:09 BKK): an approval reaches him from the registry itself, with what it is and how we use it; one program once.
function updatesHarness(language: "el" | "en" = "el") {
  const raised: SpaceNotification[] = [];
  const notices: string[] = [];
  const notifications = {
    async list(_owner: string, query: { dedupeKey?: string }) { return raised.filter((item) => !query.dedupeKey || item.dedupeKey === query.dedupeKey); },
    async raise(input: Omit<SpaceNotification, "id" | "status" | "createdAt" | "updatedAt" | "readAt">) {
      const record = { ...input, id: `notification:${raised.length + 1}`, status: "OPEN", createdAt: "2026-11-04T08:00:00.000Z" } as unknown as SpaceNotification;
      raised.push(record);
      return record;
    }
  };
  const clock = Date.parse("2026-11-04T08:30:00Z");
  const updates = createOperatorUpdates({ notifications: notifications as never, language: async () => language, notice: async (_owner, _key, line) => { notices.push(line); }, now: () => clock });
  const programs = createNousPrograms({ repository: new InMemoryNousProgramsRepository(), now: () => clock, updates });
  return { raised, notices, updates, programs };
}
const algolia = { id: "algolia-startup-program", page: "startup", parent: "Algolia", program: "Algolia Startup Program", project: "SpaceApp", status: "APPLIED",
  appliedAt: "2026-11-04T04:26:00Z", amount: { text: "$10,000 Algolia credits valid 12 months", value: 10000, currency: "USD" }, account: "crew@spaceapp.dev",
  mails: [{ ...mail, date: "2026-11-04T05:42:00Z", direction: "received", from: "startups@algolia.com", to: "crew@spaceapp.dev", subject: "Welcome to the Algolia Startup Program",
    gmailAccount: "crew@spaceapp.dev", threadId: "19a4algolia" }] };
const use = { whatItIs: "Υπηρεσία αναζήτησης (search API) για sites και εφαρμογές", howWeUse: "Αναζήτηση στα docs του SpaceApp· θέλει πλάνο Grow και κάρτα, λήγει 4/11/2027" };

it("refuses a second id for the same parent, program and project, naming the one recorded (R73: sentry-for-startups next to sentry-startups)", async () => {
  const { programs } = updatesHarness();
  const sentry = { page: "startup", parent: "Sentry", program: "Sentry for Startups", project: "SpaceApp", status: "APPLIED" };
  expect(await programs.upsert(owner, { id: "sentry-startups", ...sentry })).toMatchObject({ created: true });
  expect(await programs.upsert(owner, { id: "sentry-for-startups", ...sentry, parent: " sentry ", program: "Sentry  for startups" }))
    .toEqual({ problem: expect.stringContaining("already recorded as sentry-startups; update sentry-startups instead") });
  // The data file's copy is refused too (the deleted twin came back with every file change), and another project is another program.
  expect(await programs.importDocument(owner, "startup", { generatedAt: "2026-11-03T15:34:57Z", entries: [{ id: "sentry-for-startups", ...sentry }] }, "2026-11-04T08:28:00Z"))
    .toMatchObject({ written: 0, problems: [expect.stringContaining("sentry-startups")] });
  expect(await programs.upsert(owner, { id: "sentry-startups-oll4", ...sentry, project: "oll4.com" })).toMatchObject({ created: true });
  expect((await programs.list(owner)).map((program) => program.id)).toEqual(["sentry-startups", "sentry-startups-oll4"]);
});

it("saves every approval as APPROVED (the report waits for what it is and how we use it), and sends the operator its full report once, in his language", async () => {
  const { programs, raised, notices } = updatesHarness();
  await programs.upsert(owner, algolia);
  expect(raised).toEqual([]);
  // Operator 7/11 (nous_msg:f4e5cdfaffa440a8bd7ad0d6, UpCloud): an approval with a step still pending is APPROVED; missing use fields only warn.
  expect(await programs.upsert(owner, { id: algolia.id, status: "APPROVED", decidedAt: "2026-11-04T05:42:00Z", nextAction: "Credit not applied yet" }))
    .toMatchObject({ program: { status: "APPROVED" }, warning: expect.stringContaining("saved as APPROVED, but its operator report waits for whatItIs") });
  expect(raised).toEqual([]);
  expect(notices).toEqual([expect.stringContaining("is APPROVED without whatItIs/howWeUse")]);
  await programs.upsert(owner, { id: algolia.id, status: "APPLIED" });
  const approved = await programs.upsert(owner, { id: algolia.id, status: "APPROVED", decidedAt: "2026-11-04T05:42:00Z", validUntil: "2027-11-04", ...use });
  expect(approved).toMatchObject({ program: { status: "APPROVED", ...use } });
  expect(raised).toHaveLength(1);
  const [update] = raised;
  expect(update).toMatchObject({ source: "NOUS", kind: "OPERATOR_UPDATE", roomId: null, paneId: null, title: "Εγκρίθηκε: Algolia › Algolia Startup Program",
    link: { surface: "nous", target: "updates" }, payload: { programId: algolia.id } });
  const report = (update!.payload as { report: string }).report;
  expect("report" in approved && approved.report).toBe(report);
  for (const line of [`Τι είναι: ${use.whatItIs}`, "Τι δίνει: $10,000 Algolia credits valid 12 months · ισχύει έως 2027-11-04", `Πώς το χρησιμοποιούμε και τι χρειάζεται: ${use.howWeUse}`,
    "Λογαριασμός: crew@spaceapp.dev", "Αίτηση: 2026-11-04", "← startups@algolia.com · \"Welcome to the Algolia Startup Program\""]) expect(report).toContain(line);
  expect((update!.payload as { links: Array<{ url: string }> }).links.map((link) => link.url)).toContain("https://mail.google.com/mail/u/?authuser=crew%40spaceapp.dev#all/19a4algolia");
  // Written again (a mail, a note): no second report; a new approved amount is one.
  await programs.upsert(owner, { id: algolia.id, notes: "Grow plan chosen" });
  expect(raised).toHaveLength(1);
  expect(await programs.upsert(owner, { id: algolia.id, amount: { text: "$12,000 Algolia credits", value: 12000, currency: "USD" } })).toMatchObject({ report: expect.stringContaining("Πριν: $10,000") });
  expect(raised.map((item) => item.title)).toEqual(["Εγκρίθηκε: Algolia › Algolia Startup Program", "Νέο ποσό: Algolia › Algolia Startup Program"]);
  // A rejection needs no use fields.
  await programs.upsert(owner, { ...google, decidedAt: "2026-11-04T07:00:00Z", status: "APPLIED" });
  await programs.upsert(owner, { id: google.id, status: "REJECTED" });
  expect(raised.at(-1)).toMatchObject({ title: "Απορρίφθηκε: Google › Google for Startups Cloud" });
});

it("never lets a data file move an approved program back before its decision, and reads an approval's other words as APPROVED", async () => {
  const { programs } = updatesHarness("en");
  await programs.upsert(owner, { ...algolia, status: "APPROVED", decidedAt: "2026-11-06T05:00:00Z", amount: { text: "€5,000 credits", value: 5000, currency: "EUR" }, ...use });
  // UpCloud 7/11: its file, written later, still said DRAFT; the amount and the rest of the file still land.
  await programs.importDocument(owner, "startup", { generatedAt: "2099-01-01T00:00:00Z", entries: [{ id: algolia.id, status: "DRAFT", statusReason: "Credit not applied yet" }] }, "2099-01-01T00:00:00Z");
  expect(await programs.get(owner, algolia.id)).toMatchObject({ status: "APPROVED", statusReason: "Credit not applied yet", amount: { value: 5000, currency: "EUR" } });
  // A file may still close it (expired, cancelled, rejected).
  await programs.importDocument(owner, "startup", { generatedAt: "2099-01-02T00:00:00Z", entries: [{ id: algolia.id, status: "EXPIRED" }] }, "2099-01-02T00:00:00Z");
  expect((await programs.get(owner, algolia.id))!.status).toBe("EXPIRED");
  // Tailscale 7/11 arrived as REDEEMED and was refused, so it never showed.
  expect(await programs.importDocument(owner, "startup", { generatedAt: "2026-11-07T04:30:00Z",
    entries: [{ id: "tailscale-for-startups", parent: "Tailscale", program: "Tailscale for Startups", status: "REDEEMED", decidedAt: "2026-11-06T22:11:00Z" }] }, "2026-11-07T04:30:00Z"))
    .toEqual({ written: 1, problems: [] });
  expect((await programs.get(owner, "tailscale-for-startups"))!.status).toBe("APPROVED");
  // Novita 7/11: APPROVED in its file (credits added, console not checked), APPLIED on stable because the row changed after the file's
  // generatedAt. The approval still lands with its entry; a decided row changed since (REJECTED) keeps its decision.
  const novita = { id: "novita-startup-program", parent: "Novita AI", program: "Novita Startup Program", ...use };
  await programs.upsert(owner, { ...novita, status: "APPLIED", nextAction: "Wait for Novita's reply" });
  await programs.upsert(owner, { ...google, decidedAt: "2026-11-04T07:00:00Z" });
  await programs.importDocument(owner, "startup", { generatedAt: "2026-11-03T15:34:57Z", entries: [
    { id: novita.id, status: "APPROVED", statusReason: "Credits added; console not checked yet", amount: { text: "$100 credits", value: 100, currency: "USD" } },
    { id: google.id, status: "APPROVED" }] }, "2026-11-07T11:26:00Z");
  expect(await programs.get(owner, novita.id)).toMatchObject({ status: "APPROVED", statusReason: "Credits added; console not checked yet", amount: { value: 100 } });
  expect((await programs.get(owner, google.id))!.status).toBe("REJECTED");
});

it("stores the provider's yes as APPROVED while activation steps remain: another word for it, an active or used benefit, a reached tier (operator 7/11)", async () => {
  const programs = createNousPrograms({ repository: new InMemoryNousProgramsRepository() });
  const tailscale = { id: "tailscale-for-startups", parent: "Tailscale", program: "Tailscale for Startups", status: "redeemed", ...use };
  expect(await programs.upsert(owner, tailscale)).toMatchObject({ program: { status: "APPROVED" } });
  const upcloud = { id: "upcloud-for-startups", parent: "UpCloud", program: "UpCloud for Startups", status: "IN_PROGRESS", nextAction: "Add a card to activate the credits" };
  expect(await programs.upsert(owner, upcloud)).toMatchObject({ program: { status: "IN_PROGRESS" } });
  const credits = { what: "€5,000 cloud credits", status: "ACTIVE", total: { text: "€5,000", value: 5000, currency: "EUR" } };
  // Saved as APPROVED even without the use fields (operator 7/11, nous_msg:f4e5cdfaffa440a8bd7ad0d6); the answer only warns.
  expect(await programs.upsert(owner, { id: upcloud.id, benefits: [credits] }))
    .toMatchObject({ program: { status: "APPROVED" }, warning: expect.stringContaining("reached tier is the provider's yes") });
  expect(await programs.upsert(owner, { id: upcloud.id, status: "APPLIED", benefits: [credits], ...use }))
    .toMatchObject({ program: { status: "APPROVED", nextAction: upcloud.nextAction } });
  // Its completion still pending (operator 11/11, nous_msg:a5e13d01): kept by an upsert that leaves it out, cleared by null.
  expect(await programs.upsert(owner, { id: upcloud.id, awaitingCompletion: true })).toMatchObject({ program: { awaitingCompletion: true } });
  expect(await programs.upsert(owner, { id: upcloud.id, notes: "credit applied soon" })).toMatchObject({ program: { awaitingCompletion: true } });
  expect(await programs.upsert(owner, { id: upcloud.id, awaitingCompletion: null })).toMatchObject({ program: { awaitingCompletion: false } });
  const tier = { id: "aws-activate", parent: "AWS", program: "AWS Activate", status: "IN_PROGRESS", tiers: [{ name: "Founders", status: "REACHED" }], ...use };
  expect(await programs.upsert(owner, tier)).toMatchObject({ program: { status: "APPROVED" } });
  // A pending benefit is no yes yet.
  expect(await programs.upsert(owner, { ...tier, id: "aws-activate-portfolio", program: "AWS Activate Portfolio", tiers: [], benefits: [{ ...credits, status: "PENDING" }] }))
    .toMatchObject({ program: { status: "IN_PROGRESS" } });
});

it("takes a data file's approval without the use fields, asks Nous for them, and reports it when Nous writes them; the start's sweep backfills", async () => {
  const { programs, raised, notices, updates } = updatesHarness("en");
  await programs.importDocument(owner, "startup", { generatedAt: "2026-11-03T15:34:57Z", entries: [{ ...algolia, status: "APPROVED", decidedAt: "2026-11-04T05:42:00Z" }] }, "2026-11-04T06:00:00Z");
  expect((await programs.get(owner, algolia.id))!.status).toBe("APPROVED");
  expect(raised).toEqual([]);
  expect(notices).toEqual([expect.stringContaining("algolia-startup-program (Algolia › Algolia Startup Program) is APPROVED without whatItIs/howWeUse")]);
  const filled = await programs.upsert(owner, { id: algolia.id, ...use });
  expect(filled).toMatchObject({ report: expect.stringMatching(/^Approved: Algolia › Algolia Startup Program \(SpaceApp\)\nWhat it is: /) });
  expect(raised).toHaveLength(1);
  // The sweep: a recent decision with no update gets one (once); an old one and an approval missing its fields do not, and Nous is asked once for the latter.
  await programs.upsert(owner, { id: "github-sponsors", page: "startup", parent: "GitHub", program: "GitHub Sponsors", status: "APPLIED" });
  await programs.importDocument(owner, "startup", { entries: [{ id: "github-sponsors", status: "APPROVED", decidedAt: "2026-11-02T06:32:00Z" },
    { id: "old-one", page: "startup", parent: "Old", program: "Old", status: "REJECTED", decidedAt: "2026-10-01T00:00:00Z" },
    { id: "quicksrv", page: "startup", parent: "quicksrv.io", program: "Sponsorship", status: "REJECTED", decidedAt: "2026-11-02T07:45:00Z" }] }, "2026-11-04T09:00:00Z");
  expect((await programs.get(owner, "github-sponsors"))!.status).toBe("APPROVED");
  expect(raised.map((item) => item.title)).toEqual(["Approved: Algolia › Algolia Startup Program", "Rejected: quicksrv.io › Sponsorship"]);
  notices.length = 0;
  expect(await updates.sweep(owner, await programs.list(owner))).toBe(0);
  expect(notices).toEqual([expect.stringContaining("github-sponsors (GitHub › GitHub Sponsors) is APPROVED without")]);
  expect(raised).toHaveLength(2);
  // Once Nous writes its fields, the sweep has nothing left and the report went out with that write.
  await programs.upsert(owner, { id: "github-sponsors", ...use });
  notices.length = 0;
  expect(await updates.sweep(owner, await programs.list(owner))).toBe(0);
  expect(notices).toEqual([]);
  expect(raised.map((item) => item.title).at(-1)).toBe("Approved: GitHub › GitHub Sponsors");
});

it("gives Nous space_operator_update (once per title and body) and posts a program's report into the chat from space_programs", async () => {
  const { programs, raised, updates } = updatesHarness();
  const replies: string[] = [];
  const tools = createNousTools({ programs, operatorUpdates: updates, replyNow: async (_owner: string, _turn: string, text: string) => { replies.push(text); return "SENT"; } } as never);
  const ctx = { owner, turnId: "turn:r73", callId: "call:r73", traceId: "trace:r73" };
  await tools.execute("space_programs", { action: "upsert", entry: algolia }, ctx);
  const approved = await tools.execute("space_programs", { action: "upsert", entry: { id: algolia.id, status: "APPROVED", decidedAt: "2026-11-04T05:42:00Z", ...use } }, ctx);
  expect(approved.result).toContain("went to Updates and his chat by itself");
  expect(replies).toEqual([(raised[0]!.payload as { report: string }).report]);
  const note = { title: "Η αίτηση E2B στάλθηκε", body: "Έφυγε 14:53 από το crew@spaceapp.dev· περιμένουμε απάντηση.", links: [{ label: "Gmail", url: "https://mail.google.com/mail/u/?authuser=crew%40spaceapp.dev#all/1a1a58c446f7542d" }], refs: ["nous_msg:41668e5f"] };
  expect(await tools.execute("space_operator_update", note, ctx)).toMatchObject({ ok: true, display: "Posted to Updates: Η αίτηση E2B στάλθηκε" });
  expect(await tools.execute("space_operator_update", note, ctx)).toMatchObject({ ok: true, display: "Already in Updates" });
  expect(raised.at(-1)).toMatchObject({ kind: "OPERATOR_UPDATE", title: note.title, payload: { report: `${note.body}\n\n(nous_msg:41668e5f)`, links: note.links } });
  expect((await tools.execute("space_operator_update", note, { ...ctx, turn: { reason: "HELPER" } } as never)).ok).toBe(false);
  expect(nousToolDefinitions({ copilots: false }).map((tool) => tool.name)).toContain("space_operator_update");
  expect(NOUS_SUBAGENT_EXCLUDED.has("space_operator_update")).toBe(true);
});

it("keeps a whole-file rewrite from a stale copy from undoing the registry: replaced values, locked fields, dropped programs (operator 9/11 20:59 BKK)", async () => {
  let clock = Date.parse("2026-11-09T05:05:00Z");
  const repository = new InMemoryNousProgramsRepository(), alerts: string[] = [];
  const make = () => createNousPrograms({ repository, now: () => clock, journalDir: dir, kept: async (_owner, _key, text) => { alerts.push(text); } });
  let programs = make();
  const upcloud = { id: "upcloud-for-startups", parent: "UpCloud", program: "UpCloud for Startups", status: "APPLIED", amount: { text: "€1,000", value: 1000, currency: "EUR" } };
  const scaleway = { id: "scaleway-startup", parent: "Scaleway", program: "Scaleway Startup Program", status: "APPLIED" };
  const stale = { generatedAt: "2026-11-09T05:05:00Z", entries: [upcloud, google] };
  const file = async (document: unknown) => { await write("startup-programs.json", document); await utimes(join(dir, "startup-programs.json"), new Date(), new Date(clock)); };
  await file(stale);
  await programs.importFiles(owner, dir, join(dir, "usage.json"));
  // A pane adds Scaleway and marks Google's appeal (10:26); Nous locks UpCloud's €5,000 with the operator's word (14:04).
  clock = Date.parse("2026-11-09T10:26:00Z");
  await file({ generatedAt: "2026-11-09T10:26:00Z", entries: [upcloud, { ...google, status: "APPLIED" }, scaleway] });
  await programs.importFiles(owner, dir, join(dir, "usage.json"));
  clock = Date.parse("2026-11-09T14:04:00Z");
  const five = { text: "€5,000", value: 5000, currency: "EUR" };
  expect(await programs.upsert(owner, { id: upcloud.id, amount: five, locked: ["amount"], sources: ["nous_msg:20:59"] })).toMatchObject({ program: { locked: ["amount"] } });
  // The lock holds against space_programs too: no new source, nothing saved; a typo locks nothing silently.
  expect(await programs.upsert(owner, { id: upcloud.id, amount: upcloud.amount })).toEqual({ problem: expect.stringContaining("amount locked by the operator") });
  expect(await programs.upsert(owner, { id: upcloud.id, locked: [] })).toEqual({ problem: expect.stringContaining("amount locked by the operator") });
  expect(await programs.upsert(owner, { id: upcloud.id, locked: ["amout"] })).toEqual({ problem: expect.stringContaining("locked names no field: amout") });
  // After a restart, a pane rewrites the file whole from the 05:05 copy with a fresh generatedAt (Hugo, 12:04 on 9/11).
  programs = make();
  clock = Date.parse("2026-11-09T15:00:00Z");
  await file({ ...stale, generatedAt: "2026-11-09T15:00:00Z", entries: [{ ...upcloud, nextAction: "Add a card" }, google] });
  await programs.importFiles(owner, dir, join(dir, "usage.json"));
  expect(await programs.get(owner, upcloud.id)).toMatchObject({ amount: five, nextAction: "Add a card" });
  expect((await programs.get(owner, google.id))!.status).toBe("APPLIED");
  expect(await programs.get(owner, scaleway.id)).not.toBeNull();
  expect(alerts).toEqual([expect.stringMatching(/google-cloud-startups status: kept "APPLIED", the file has "REJECTED" \(a value replaced since\)\n1 programs left the file; the registry keeps them: scaleway-startup$/)]);
  // A file that changes the locked field is kept from it too; with the operator's new source space_programs changes it.
  clock = Date.parse("2026-11-09T16:00:00Z");
  await file({ generatedAt: "2026-11-09T16:00:00Z", entries: [{ ...upcloud, amount: { text: "€2,000", value: 2000, currency: "EUR" } }] });
  await programs.importFiles(owner, dir, join(dir, "usage.json"));
  expect(alerts.at(-1)).toContain("upcloud-for-startups amount: kept");
  expect(await programs.upsert(owner, { id: upcloud.id, amount: upcloud.amount, sources: ["nous_msg:20:59", "gmail:upcloud-reply"] })).toMatchObject({ program: { amount: { value: 1000 } } });
  const journal = (await readFile(join(dir, "startup-programs.journal.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(journal.filter((line) => line.id === upcloud.id && line.changed.amount).map((line) => [line.by, line.changed.amount.to.value])).toEqual([["file", 1000], ["tool", 5000], ["tool", 1000]]);
});
