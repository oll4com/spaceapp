import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { siteSigninKeySchema, siteSigninRecordSchema, updateUserSettingsInputSchema, type SiteSignin, type UpdateUserSettingsInput, type UserSettings } from "@space/contracts";
import type { InstanceLinkRecord, InstanceLinkRepository, SiteSigninsRepository } from "@space/db";
import { appendCanonicalMemoryBlocks, canonicalMemoryBlocks, MONTHLY_MEMORY_FILE_PATTERN, SPACE_MEMORY_DIRECTORY, spaceMemoryMonthlyPath } from "@space/runtime";
import { sendApiError } from "../http-errors.js";
import type { InstanceLinkReply } from "./client.js";

// Settings and Space Memory over a Space Link (plan clipboard:TcX66vjNuZDv step 3, operator nous_msg:549e67fc «σαν να ηταν τοπικα»). The
// managing SpaceApp (A) is the source: a link whose person granted "Settings and memory" (scope sync) gets A's person's settings and every
// Space Memory block it lacks, on each change (a pass every 30 s) and only while both speak the same sync format (LINK_SYNC_FORMAT). Nothing here is a secret.
// shortcut: one way (A to B), only user settings (not the CLI runtime's, whose VPN choice is per host, nor clipboard, tasks or providers), text
// before a month's first id marker is not carried and B's added blocks land at its file's end; add more when the operator asks.
// Site sign-in recipes ride along (step 5): which method, which Vault item and which Google account by its address (rule 158a7bfd: never the
// first account), never a browser profile or its cookies, which stay on their host; on B the recipe names the account to sign in to once.

/** Never carried: this host's own addresses, resource limits and room-local state (rule d46b9e48: each side keeps its own). */
const HOST_KEYS = ["warmRoomEnabled", "warmRoomConnectedPaneLimit", "roomLimit", "paneHibernate", "vibeMusicPlaylistLinkId", "roomExtraEmptySlots",
  "roomWorktreeOverrides", "updatedAt",
  // Host paths, and free-text values people fill with tokens (secrets travel only Vault to Vault; security review 15/11).
  "projectPresets", "promptVariables"] as const;
/** Nous's operator allowances and this host's own loops: the link never decides them, B's person does. */
const HOST_NOUS_KEYS = ["enabled", "maxTurnsPerHour", "mayPromote", "mayApproveWarm", "maySecurityHotfix", "askOwnHostChanges", "autoResetCredits", "maySend",
  "mayDeleteOwn", "mayPublish", "mayRestartHosts", "neverBuy", "mayCleanSystem", "neverRefuse", "shell", "alwaysApprove", "telegramInbound", "standingOrders", "goals",
  "copilotQuestionsNousFirst"] as const;
/** Technical: how often A looks for a change (one stat per month file and one small read per link). */
const KEEP_MS = 30_000;
/** Technical: a month A confirmed is asked again after an hour, so a block B lost comes back without A's file changing. */
const CONFIRM_MS = 60 * 60_000;
/** Technical bound: a block page stays under the receiving route's body limit (2 × this). */
const PAGE_BYTES = 4 * 1024 * 1024;
const MONTH = /^\d{4}-\d{2}$/;
/** What both sides send each other. Bump it when that changes in a way an older peer would misread; B checks each field it takes on its own. */
export const LINK_SYNC_FORMAT = 1;
/** A peer from before the format (no format given) syncs only from the same commit, as it did then. */
const sameFormat = (peer: { format?: unknown; commit?: unknown }, commit: string | null) =>
  peer.format === undefined ? Boolean(commit) && peer.commit === commit : peer.format === LINK_SYNC_FORMAT;
/** What a sign-in recipe carries; browserProfileId, attempts and counts are this host's own. */
const RECIPE = ["method", "googleAccountEmail", "siteAccountEmail", "username", "vaultHandle", "mailbox", "mfa", "notes"] as const;

const omit = (value: Record<string, unknown> | null | undefined, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key)));
const pick = (value: Record<string, unknown> | null | undefined, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => keys.includes(key)));
/** What the link carries of one person's settings: everything but this host's own fields. */
export function syncedSettings(settings: UserSettings): Record<string, unknown> {
  const shared = omit(settings as Record<string, unknown>, HOST_KEYS);
  return settings.nous ? { ...shared, nous: omit(settings.nous, HOST_NOUS_KEYS) } : shared;
}
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value) ?? "null";
export const settingsDigest = (settings: UserSettings) => createHash("sha256").update(stable(syncedSettings(settings))).digest("hex");
/** One sign-in as the link carries it: its key and recipe, absent fields as null so both sides compare alike. */
export const syncedSignin = (row: SiteSignin) => ({ site: row.site, accountLabel: row.accountLabel,
  ...Object.fromEntries(RECIPE.map((key) => [key, row[key] ?? null])) }) as Record<string, unknown> & { site: string; accountLabel: string };
/** Rows as B keys them, the latest one per key: a row from before 12/11's keys (wk.wd3.myworkdayjobs.com beside myworkdayjobs.com) overwrote
 * its twin on B every pass and the digests never met (hz 15/11). A key that does not parse stays raw, so B counts it refused. */
const keyed = (rows: SiteSignin[]) => [...new Map([...rows].sort((left, right) => (left.updatedAt ?? "").localeCompare(right.updatedAt ?? "")).map((row) => {
  const key = siteSigninKeySchema.safeParse({ site: row.site, accountLabel: row.accountLabel });
  return key.success ? { ...row, ...key.data } : row;
}).map((row) => [`${row.site} ${row.accountLabel}`, row] as const)).values()];
export const signinsDigest = (rows: SiteSignin[]) => createHash("sha256").update(stable(keyed(rows).map(syncedSignin)
  .sort((left, right) => `${left.site} ${left.accountLabel}`.localeCompare(`${right.site} ${right.accountLabel}`)))).digest("hex");
/** Items in pages under the receiving route's body limit. */
function paged<T>(items: T[], size: (item: T) => number): T[][] {
  const pages: T[][] = [[]];
  let bytes = 0;
  for (const item of items) {
    if (bytes + size(item) > PAGE_BYTES && pages.at(-1)!.length) { pages.push([]); bytes = 0; }
    pages.at(-1)!.push(item);
    bytes += size(item);
  }
  return pages.filter((page) => page.length);
}

/** A's settings as B's patch, field by field (user-settings-never-reset): a field B's schema does not take is left out, never the rest. */
export function settingsPatch(incoming: unknown, local: UserSettings): UpdateUserSettingsInput | null {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return null;
  const input: Record<string, unknown> = omit(incoming as Record<string, unknown>, HOST_KEYS);
  if (input.nous && typeof input.nous === "object") input.nous = { ...omit(input.nous as Record<string, unknown>, HOST_NOUS_KEYS), ...pick(local.nous, HOST_NOUS_KEYS) };
  else delete input.nous;
  for (let tries = 0; tries < 2; tries += 1) {
    const parsed = updateUserSettingsInputSchema.safeParse(input);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues) {
      for (const key of issue.code === "unrecognized_keys" ? issue.keys : [issue.path[0]]) if (typeof key === "string") delete input[key];
    }
  }
  return null;
}

type Call = (link: InstanceLinkRecord, method: "GET" | "POST", path: string, body?: unknown) => Promise<InstanceLinkReply>;
const said = (answer: InstanceLinkReply) => `it answered ${answer.status}${(answer.body as { error?: { code?: string } } | null)?.error?.code ? ` ${(answer.body as { error: { code: string } }).error.code}` : ""}`;
const base = { commit: z.string().min(1).nullable(), format: z.number().int().optional() };
const pushSchema = z.union([
  z.object({ ...base, settings: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ ...base, month: z.string().regex(MONTH), blocks: z.array(z.string()) }).strict(),
  z.object({ ...base, signins: z.array(z.record(z.string(), z.unknown())) }).strict()
]);
/** One category's last pass: when it last matched or carried, whether both sides now match (null: not compared yet), and its error. */
export type LinkSyncCategory = { at: string | null; same: boolean | null; error: string | null };
export type LinkSyncState = { syncedAt: string | null; error: string | null; waiting: boolean; settings: LinkSyncCategory; memory: LinkSyncCategory; signins: LinkSyncCategory };
const CATEGORIES = ["settings", "memory", "signins"] as const;

export function registerLinkSettingsSync(app: FastifyInstance, options: {
  store: { getUserSettings(userId: string): UserSettings | Promise<UserSettings>; updateUserSettings(userId: string, input: UpdateUserSettingsInput): unknown };
  repository: Pick<InstanceLinkRepository, "listAll">; call: Call; routeOptions: Pick<RouteShorthandOptions, "config">;
  commit: () => Promise<string | null>; memoryDirectory?: string;
  /** Read at each use: the Vault module registers the sign-in repository after the link routes. */
  signins: () => Pick<SiteSigninsRepository, "list" | "record"> | undefined;
  audit: (request: FastifyRequest, metadata: Record<string, unknown>) => Promise<void>;
}) {
  const directory = options.memoryDirectory ?? SPACE_MEMORY_DIRECTORY;
  const months = async () => [...new Set((await readdir(directory).catch(() => [])).flatMap((name) => MONTHLY_MEMORY_FILE_PATTERN.exec(name)?.[1] ?? []))].sort();
  const read = async (month: string) => canonicalMemoryBlocks(await readFile(spaceMemoryMonthlyPath(month, directory), "utf8").catch(() => ""));

  // B's side. Only a link this SpaceApp's person granted "Settings and memory", and only in the sync format this SpaceApp speaks.
  const linked = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.mobileDevice?.scopes.includes("sync")) return request.user!.id;
    sendApiError(reply, 403, "LINK_SYNC_NOT_GRANTED", "Only a linked SpaceApp this SpaceApp's person let sync settings and memory (Settings > Account > Devices).");
    return null;
  };
  app.get<{ Querystring: { month?: string } }>("/api/instance-link/sync", options.routeOptions, async (request, reply) => {
    const owner = linked(request, reply);
    if (!owner) return reply;
    const commit = await options.commit();
    const { month } = request.query;
    const signins = options.signins();
    if (month === undefined) return { commit, format: LINK_SYNC_FORMAT, settings: settingsDigest(await options.store.getUserSettings(owner)), signins: signins ? signinsDigest(await signins.list(owner)) : null };
    if (!MONTH.test(month)) return sendApiError(reply, 400, "INVALID_INPUT", "month is YYYY-MM.");
    return { commit, format: LINK_SYNC_FORMAT, month, ids: [...(await read(month)).keys()] };
  });
  app.post("/api/instance-link/sync", { ...options.routeOptions, bodyLimit: 2 * PAGE_BYTES }, async (request, reply) => {
    const owner = linked(request, reply);
    if (!owner) return reply;
    const input = pushSchema.safeParse(request.body);
    if (!input.success) return sendApiError(reply, 400, "INVALID_INPUT", "Not a settings or memory push.");
    if (!sameFormat(input.data, await options.commit())) return sendApiError(reply, 409, "LINK_VERSION_DIFFERS", "This SpaceApp speaks another sync format: it syncs once both run a version with the same.");
    if ("settings" in input.data) {
      const patch = settingsPatch(input.data.settings, await options.store.getUserSettings(owner));
      if (!patch) return sendApiError(reply, 400, "INVALID_INPUT", "No settings this SpaceApp takes.");
      await options.store.updateUserSettings(owner, patch);
      await options.audit(request, { settings: Object.keys(patch).length });
      return { settings: settingsDigest(await options.store.getUserSettings(owner)) };
    }
    if ("signins" in input.data) {
      const repository = options.signins();
      if (!repository) return sendApiError(reply, 409, "SIGNINS_UNAVAILABLE", "This SpaceApp keeps no site sign-ins yet.");
      const here = new Map((await repository.list(owner)).map((row) => [`${row.site} ${row.accountLabel}`, row]));
      let changed = 0, refused = 0;
      for (const raw of input.data.signins) {
        const fields = Object.fromEntries(Object.entries(raw).filter(([key]) => key === "site" || key === "accountLabel" || (RECIPE as readonly string[]).includes(key)));
        const parsed = siteSigninRecordSchema.safeParse({ ...fields, outcome: "CHANGED", reason: "From the managing SpaceApp over Space Link." });
        if (!parsed.success) { refused += 1; continue; }
        const old = here.get(`${parsed.data.site} ${parsed.data.accountLabel}`);
        if (old && stable(syncedSignin(old)) === stable({ site: parsed.data.site, accountLabel: parsed.data.accountLabel, ...Object.fromEntries(RECIPE.map((key) => [key, parsed.data[key] ?? null])) })) continue;
        // Another Google account than this host's profile was pinned for: the profile no longer fits, the account's address picks one here.
        const profile = old?.browserProfileId && (old.googleAccountEmail ?? null) !== (parsed.data.googleAccountEmail ?? null) ? { browserProfileId: null } : {};
        await repository.record(owner, { ...parsed.data, ...profile }, `link:${request.mobileDevice?.id ?? "unknown"}`);
        changed += 1;
      }
      if (changed || refused) await options.audit(request, { signins: changed, refused });
      return { signins: signinsDigest(await repository.list(owner)), changed, refused };
    }
    const { month, blocks } = input.data;
    const added = await appendCanonicalMemoryBlocks(spaceMemoryMonthlyPath(month, directory), blocks).catch((error: Error) => error);
    if (added instanceof Error) return sendApiError(reply, 400, "INVALID_INPUT", added.message);
    if (added.added) await options.audit(request, { month, added: added.added });
    return added;
  });

  // A's side.
  const states = new Map<string, LinkSyncState>();
  const pushed = new Map<string, string>();
  const started = Date.now();
  const confirmed = new Map<string, { print: string; at: number }>();
  const unknown = (): LinkSyncCategory => ({ at: null, same: null, error: null });
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  async function sync(link: InstanceLinkRecord, manual: boolean): Promise<LinkSyncState> {
    const before = states.get(link.id);
    const state: LinkSyncState = { syncedAt: before?.syncedAt ?? null, error: null, waiting: false,
      ...Object.fromEntries(CATEGORIES.map((name) => [name, before?.[name] ?? unknown()])) as Pick<LinkSyncState, typeof CATEGORIES[number]> };
    const ask = async (method: "GET" | "POST", path: string, body?: unknown) => {
      const answer = await options.call(link, method, path, body);
      if (answer.status === 403) throw new Error("It does not let this SpaceApp sync settings and memory: its person grants it in Settings > Account > Devices.");
      if (answer.status !== 200) throw new Error(said(answer));
      return answer.body as Record<string, unknown>;
    };
    const commit = await options.commit();
    let peer: Record<string, unknown>;
    try { peer = await ask("GET", "/api/instance-link/sync"); } catch (error) { state.error = message(error); return state; }
    if (!sameFormat(peer, commit)) return { ...state, waiting: true };
    // Each category on its own: one that fails leaves the others' state and work alone.
    const run = async (name: typeof CATEGORIES[number], work: () => Promise<boolean>) => {
      try { state[name] = { at: new Date().toISOString(), same: await work(), error: null }; } catch (error) {
        state[name] = { ...state[name], error: message(error) };
        state.error ??= message(error);
      }
    };
    await run("settings", async () => {
      const settings = await options.store.getUserSettings(link.ownerUserId);
      const mine = settingsDigest(settings);
      if (mine === peer.settings) { pushed.set(link.id, mine); return true; }
      // The pass pushes only A's own change (once, so a field B's schema leaves out is not sent forever): B's person's change stays
      // until A's next change or Sync now, and a restart (every Promote) seeds the mark of a link it found instead of pushing it all
      // again over B's toggles (operator 23/11). A link made since the start has no mark and gets its first push.
      if (!manual && !pushed.has(link.id) && Date.parse(link.createdAt) < started) pushed.set(link.id, mine);
      if (!manual && pushed.get(link.id) === mine) return false;
      const answer = await ask("POST", "/api/instance-link/sync", { commit, format: LINK_SYNC_FORMAT, settings: syncedSettings(settings) });
      pushed.set(link.id, mine);
      return answer.settings === mine;
    });
    await run("signins", async () => {
      const signins = options.signins();
      if (!signins || peer.signins === null) return false;
      const rows = await signins.list(link.ownerUserId), mine = signinsDigest(rows), mark = `${mine}:${String(peer.signins)}`;
      if (mine === peer.signins) return true;
      // B's own sign-ins that A lacks stay there (one way, records are never deleted), so the digests can differ for good: once per difference.
      if (!rows.length || pushed.get(`${link.id}:signins`) === mark) return false;
      let digest: unknown = null;
      for (const page of paged(keyed(rows).map(syncedSignin), (row) => JSON.stringify(row).length)) digest = (await ask("POST", "/api/instance-link/sync", { commit, format: LINK_SYNC_FORMAT, signins: page })).signins;
      pushed.set(`${link.id}:signins`, mark);
      return digest === mine;
    });
    await run("memory", async () => {
      for (const month of await months()) {
        const info = await stat(spaceMemoryMonthlyPath(month, directory)).catch(() => null);
        if (!info) continue;
        const key = `${link.id}:${month}`, print = `${info.size}:${info.mtimeMs}`, done = confirmed.get(key);
        if (done?.print === print && Date.now() - done.at < CONFIRM_MS) continue;
        const have = new Set((await ask("GET", `/api/instance-link/sync?month=${month}`)).ids as string[]);
        const missing = [...(await read(month))].filter(([id]) => !have.has(id)).map(([, block]) => block);
        for (const blocks of paged(missing, (block) => block.length)) await ask("POST", "/api/instance-link/sync", { commit, format: LINK_SYNC_FORMAT, month, blocks });
        confirmed.set(key, { print, at: Date.now() });
      }
      return true;
    });
    if (!state.error) state.syncedAt = new Date().toISOString();
    return state;
  }
  const syncNow = async (link: InstanceLinkRecord, manual: boolean) => {
    const state = await sync(link, manual).catch((error: unknown) => ({ ...(states.get(link.id) ?? { syncedAt: null, waiting: false, settings: unknown(), memory: unknown(), signins: unknown() }), error: message(error) }));
    states.set(link.id, state);
    return state;
  };
  let keeping: Promise<void> | null = null;
  const pass = () => keeping ??= (async () => {
    for (const link of await options.repository.listAll()) await syncNow(link, false);
  })().catch(() => undefined).finally(() => { keeping = null; });
  const timer = setInterval(() => void pass(), KEEP_MS);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  /** What Settings lists per link: null until a first pass reached it. `now` runs one link's pass at once (Sync now, space_link_parity). */
  return { state: (link: InstanceLinkRecord) => states.get(link.id) ?? null, pass, now: (link: InstanceLinkRecord) => syncNow(link, true) };
}
