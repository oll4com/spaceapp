import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { userSettingsSchema, type UserSettings } from "@space/contracts";
import { InMemorySiteSigninsRepository } from "@space/db";
import { LINK_SYNC_FORMAT, registerLinkSettingsSync, settingsDigest, signinsDigest, syncedSettings } from "../src/instance-link/settings-sync.js";

// B's side of settings and Space Memory over a Space Link (plan clipboard:TcX66vjNuZDv step 3).
const owner = "user:operator";
const block = (id: string, text: string) => `<!-- space-memory:id=${id} -->\n## ${text}\n${text} body.\n\n`;

async function linked(scopes: string[], local: Partial<UserSettings>) {
  const directory = await mkdtemp(join(tmpdir(), "link-sync-"));
  await writeFile(join(directory, "space_memory.md"), "# index\n");
  await writeFile(join(directory, "space_memory_2026-11.md"), `# Space Memory 2026-11\n${block("mem-local-1", "Local")}`);
  let settings = userSettingsSchema.parse(local);
  const store = { getUserSettings: () => settings, updateUserSettings: vi.fn((_: string, patch: Partial<UserSettings>) => (settings = userSettingsSchema.parse({ ...settings, ...patch }))) };
  const signins = new InMemorySiteSigninsRepository();
  const app = Fastify();
  app.addHook("onRequest", async (request) => { Object.assign(request, { user: { id: owner }, mobileDevice: { id: "device:link", scopes } }); });
  const sync = registerLinkSettingsSync(app, { store, repository: { listAll: async () => [] }, call: vi.fn(), routeOptions: {}, commit: async () => "c0ffee",
    memoryDirectory: directory, signins: () => signins, audit: vi.fn(async () => undefined) });
  await app.ready();
  return { app, store, directory, signins, settings: () => settings, sync };
}

describe("settings and memory over a Space Link, the receiving side", () => {
  it("refuses a link its person did not grant sync, a push in another format and one from another commit that names no format", async () => {
    const ungranted = await linked(["manage", "vault"], {});
    expect((await ungranted.app.inject({ method: "GET", url: "/api/instance-link/sync" })).statusCode).toBe(403);
    const { app, store } = await linked(["sync"], {});
    const other = await app.inject({ method: "POST", url: "/api/instance-link/sync", payload: { commit: "deadbeef", settings: { uiTheme: "classic" } } });
    expect(other.json().error.code).toBe("LINK_VERSION_DIFFERS");
    const format = await app.inject({ method: "POST", url: "/api/instance-link/sync", payload: { commit: "c0ffee", format: LINK_SYNC_FORMAT + 1, settings: { uiTheme: "classic" } } });
    expect(format.json().error.code).toBe("LINK_VERSION_DIFFERS");
    expect(store.updateUserSettings).not.toHaveBeenCalled();
  });

  it("takes the settings but keeps this host's limits and Nous allowances, and then reports the same digest", async () => {
    const { app, settings } = await linked(["sync"], { roomLimit: 3, nous: { enabled: true, mayPromote: false } as never });
    const source = userSettingsSchema.parse({ uiTheme: "classic", roomLimit: 9, nous: { enabled: false, mayPromote: true, maxTurnsPerHour: 99, fallbackModel: "none" } });
    const answer = await app.inject({ method: "POST", url: "/api/instance-link/sync", payload: { commit: "c0ffee", settings: { ...syncedSettings(source), roomLimit: 9, unknownField: 1 } } });
    expect(answer.statusCode).toBe(200);
    expect(settings()).toMatchObject({ uiTheme: "classic", roomLimit: 3, nous: { enabled: true, mayPromote: false, maxTurnsPerHour: 20 } });
    expect(answer.json().settings).toBe(settingsDigest(source));
    expect((await app.inject({ method: "GET", url: "/api/instance-link/sync" })).json()).toMatchObject({ commit: "c0ffee", settings: settingsDigest(source) });
  });

  it("appends only the memory blocks it lacks, keeps its own, and refuses what is not one block each", async () => {
    const { app, directory } = await linked(["sync"], {});
    const month = join(directory, "space_memory_2026-11.md");
    expect((await app.inject({ method: "GET", url: "/api/instance-link/sync?month=2026-11" })).json().ids).toEqual(["mem-local-1"]);
    const push = (blocks: string[]) => app.inject({ method: "POST", url: "/api/instance-link/sync", payload: { commit: "c0ffee", month: "2026-11", blocks } });
    expect((await push([block("mem-local-1", "Changed"), block("mem-remote-1", "Remote")])).json()).toEqual({ added: 1 });
    const text = await readFile(month, "utf8");
    expect(text).toContain("Local body.");
    expect(text).not.toContain("Changed");
    expect(text.indexOf("mem-remote-1")).toBeGreaterThan(text.indexOf("mem-local-1"));
    expect((await push([`${block("mem-a", "A")}${block("mem-b", "B")}`])).statusCode).toBe(400);
    expect((await push(["no marker at all"])).statusCode).toBe(400);
    expect((await push([block("mem-remote-1", "Remote")])).json()).toEqual({ added: 0 });
    expect((await app.inject({ method: "POST", url: "/api/instance-link/sync", payload: { commit: "c0ffee", month: "../etc", blocks: [] } })).statusCode).toBe(400);
  });

  it("takes A's sign-in recipes with their Google account by address, never A's browser profile, and unpins its own when the account changes", async () => {
    const { app, signins } = await linked(["sync"], {});
    await signins.record(owner, { site: "upwork.com", outcome: "SUCCESS", method: "GOOGLE", googleAccountEmail: "pirnniramon@gmail.com", browserProfileId: "google_account:b-1" }, "pane:b");
    await signins.record(owner, { site: "github.com", outcome: "SUCCESS", method: "GITHUB", browserProfileId: "google_account:b-2" }, "pane:b");
    const push = (rows: unknown[]) => app.inject({ method: "POST", url: "/api/instance-link/sync", payload: { commit: "c0ffee", signins: rows } });
    const answer = await push([
      { site: "upwork.com", accountLabel: "main", method: "GOOGLE", googleAccountEmail: "ntheogr@gmail.com", browserProfileId: "google_account:a-9", vaultHandle: null },
      { site: "github.com", accountLabel: "main", method: "GITHUB", notes: "Use the passkey." },
      { site: "contra.com", accountLabel: "main", method: "VAULT_LOGIN", vaultHandle: "vault_item:abc123" },
      { site: "user:pass@bad", accountLabel: "main" }
    ]);
    expect(answer.json()).toMatchObject({ changed: 3, refused: 1 });
    const upwork = await signins.get(owner, "upwork.com");
    expect(upwork).toMatchObject({ googleAccountEmail: "ntheogr@gmail.com", browserProfileId: null, successCount: 1 });
    expect(await signins.get(owner, "github.com")).toMatchObject({ notes: "Use the passkey.", browserProfileId: "google_account:b-2" });
    const contra = await signins.get(owner, "contra.com");
    expect(contra).toMatchObject({ method: "VAULT_LOGIN", vaultHandle: "vault_item:abc123" });
    expect(contra?.browserProfileId ?? null).toBeNull();
    const digest = signinsDigest(await signins.list(owner));
    expect(answer.json().signins).toBe(digest);
    expect((await app.inject({ method: "GET", url: "/api/instance-link/sync" })).json().signins).toBe(digest);
    expect((await push([{ site: "contra.com", accountLabel: "main", method: "VAULT_LOGIN", vaultHandle: "vault_item:abc123" }])).json()).toMatchObject({ changed: 0, refused: 0 });
  });

  it("A sends one row per key B uses, the latest, so two rows of one site (one from before 12/11's keys) converge and the next pass sends nothing", async () => {
    const b = await linked(["sync"], {});
    const row = (site: string, updatedAt: string, notes: string) => ({ site, accountLabel: "main", method: "VAULT_LOGIN", notes, updatedAt, history: [] }) as never;
    const rows = [row("myworkdayjobs.com", "2026-11-06T17:00:00.000Z", "newer"), row("wk.wd3.myworkdayjobs.com", "2026-11-01T00:00:00.000Z", "older")];
    const call = vi.fn(async (_link: unknown, method: "GET" | "POST", path: string, body?: unknown) => {
      const answer = await b.app.inject({ method, url: path, ...(body === undefined ? {} : { payload: body as object }) });
      return { status: answer.statusCode, body: answer.json() };
    });
    const link = { id: "link:b", ownerUserId: owner } as never;
    const settings = userSettingsSchema.parse({});
    const a = registerLinkSettingsSync(Fastify(), { store: { getUserSettings: () => settings, updateUserSettings: () => settings }, repository: { listAll: async () => [link] },
      call: call as never, routeOptions: {}, commit: async () => "c0ffee", memoryDirectory: b.directory, signins: () => ({ list: async () => rows }) as never, audit: vi.fn(async () => undefined) });
    expect((await a.now(link)).signins).toMatchObject({ same: true, error: null });
    expect(await b.signins.get(owner, "myworkdayjobs.com")).toMatchObject({ notes: "newer" });
    const posts = () => call.mock.calls.filter(([, method, , body]) => method === "POST" && (body as { signins?: unknown })?.signins).length;
    const sent = posts();
    expect((await a.now(link)).signins).toMatchObject({ same: true });
    expect(posts()).toBe(sent);
  });

  it("A's pass (Sync now) brings settings, memory and sign-ins to B from another commit in the same format, each category on its own state, a failed one alone", async () => {
    const b = await linked(["sync"], {});
    const directory = await mkdtemp(join(tmpdir(), "link-sync-a-"));
    await writeFile(join(directory, "space_memory.md"), "# index\n");
    await writeFile(join(directory, "space_memory_2026-11.md"), `# Space Memory 2026-11\n${block("mem-a-1", "From A")}`);
    let settings = userSettingsSchema.parse({ uiTheme: "classic" });
    const signins = new InMemorySiteSigninsRepository();
    await signins.record(owner, { site: "upwork.com", outcome: "SUCCESS", method: "GOOGLE", googleAccountEmail: "ntheogr@gmail.com", browserProfileId: "google_account:a-1" }, "pane:a");
    let failMemory = false;
    const call = vi.fn(async (_link: unknown, method: "GET" | "POST", path: string, body?: unknown) => {
      if (failMemory && path.includes("month=")) return { status: 500, body: null };
      const answer = await b.app.inject({ method, url: path, ...(body === undefined ? {} : { payload: body as object }) });
      return { status: answer.statusCode, body: answer.json() };
    });
    const link = { id: "link:b", ownerUserId: owner } as never;
    const app = Fastify();
    const a = registerLinkSettingsSync(app, { store: { getUserSettings: () => settings, updateUserSettings: (_: string, patch: Partial<UserSettings>) => (settings = userSettingsSchema.parse({ ...settings, ...patch })) },
      repository: { listAll: async () => [link] }, call: call as never, routeOptions: {}, commit: async () => "a-newer-commit", memoryDirectory: directory, signins: () => signins, audit: vi.fn(async () => undefined) });
    const state = await a.now(link);
    expect(state).toMatchObject({ error: null, waiting: false, settings: { same: true }, memory: { same: true }, signins: { same: true } });
    expect(b.settings().uiTheme).toBe("classic");
    expect(await readFile(join(b.directory, "space_memory_2026-11.md"), "utf8")).toContain("From A body.");
    expect(await b.signins.get(owner, "upwork.com")).toMatchObject({ googleAccountEmail: "ntheogr@gmail.com" });
    expect((await b.signins.get(owner, "upwork.com"))?.browserProfileId ?? null).toBeNull();
    expect(a.state(link)).toEqual(state);
    await writeFile(join(directory, "space_memory_2026-11.md"), `# Space Memory 2026-11\n${block("mem-a-1", "From A")}${block("mem-a-2", "Later")}`);
    failMemory = true;
    const failed = await a.now(link);
    expect(failed.memory.error).toBe("it answered 500");
    expect(failed.settings).toMatchObject({ same: true, error: null });
    expect(failed.signins).toMatchObject({ same: true, error: null });
    expect(failed.error).toBe("it answered 500");
    expect(state.syncedAt).toBeTruthy();
    await app.close();
  });

  it("A's pass after a restart (every Promote) leaves B's own change, pushes A's next change once, and Sync now pushes at once", async () => {
    const b = await linked(["sync"], { sensitiveDataMasked: false });
    let settings = userSettingsSchema.parse({ sensitiveDataMasked: true });
    const call = vi.fn(async (_link: unknown, method: "GET" | "POST", path: string, body?: unknown) => {
      const answer = await b.app.inject({ method, url: path, ...(body === undefined ? {} : { payload: body as object }) });
      return { status: answer.statusCode, body: answer.json() };
    });
    const link = { id: "link:b", ownerUserId: owner, createdAt: "2026-11-01T00:00:00.000Z" } as never;
    const app = Fastify();
    const a = registerLinkSettingsSync(app, { store: { getUserSettings: () => settings, updateUserSettings: vi.fn() },
      repository: { listAll: async () => [link] }, call: call as never, routeOptions: {}, commit: async () => "c0ffee", signins: () => undefined, audit: vi.fn(async () => undefined) });
    await a.pass();
    expect(b.settings().sensitiveDataMasked).toBe(false);
    expect(a.state(link)?.settings.same).toBe(false);
    settings = userSettingsSchema.parse({ sensitiveDataMasked: true, uiZoom: 110 });
    await a.pass();
    expect(b.settings()).toMatchObject({ sensitiveDataMasked: true, uiZoom: 110 });
    await b.app.inject({ method: "POST", url: "/api/instance-link/sync", payload: { commit: "c0ffee", format: LINK_SYNC_FORMAT, settings: { sensitiveDataMasked: false } } });
    await a.pass();
    expect(b.settings().sensitiveDataMasked).toBe(false);
    await a.now(link);
    expect(b.settings().sensitiveDataMasked).toBe(true);
    await app.close();
  });

  it("A waits for a B from before the sync format that runs another commit, and pushes nothing", async () => {
    const call = vi.fn(async () => ({ status: 200, body: { commit: "old", settings: "x", signins: null } }));
    const link = { id: "link:old", ownerUserId: owner } as never;
    const app = Fastify();
    const a = registerLinkSettingsSync(app, { store: { getUserSettings: () => userSettingsSchema.parse({}), updateUserSettings: vi.fn() },
      repository: { listAll: async () => [link] }, call: call as never, routeOptions: {}, commit: async () => "c0ffee", signins: () => undefined, audit: vi.fn(async () => undefined) });
    expect(await a.now(link)).toMatchObject({ waiting: true, error: null });
    expect(call).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

it("never carries host paths, prompt variables (secrets go Vault to Vault) or Nous's copilot-question allowance", async () => {
  const source = userSettingsSchema.parse({ projectPresets: [{ label: "a", path: "/srv/a" }], promptVariables: [], nous: { copilotQuestionsNousFirst: false } });
  const synced = syncedSettings(source) as Record<string, unknown>;
  expect(synced).not.toHaveProperty("projectPresets");
  expect(synced).not.toHaveProperty("promptVariables");
  expect(synced.nous).not.toHaveProperty("copilotQuestionsNousFirst");
});
