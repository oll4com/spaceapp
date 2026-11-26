import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { siteSigninKeySchema, siteSigninRecordSchema, type BrowserHandoffRequest, type SiteSigninInput } from "@space/contracts";
import { InMemorySiteSigninsRepository, PostgresSiteSigninsRepository, type SiteSigninsRepository } from "@space/db";
import { SpaceConflictError, redactMemoryText, type SpaceStore } from "@space/runtime";
import { parseBody, parseQuery } from "./route-parsing.js";

const repositories = new WeakMap<object, SiteSigninsRepository>();
export const siteSigninsFor = (store: object) => repositories.get(store);
export function registerSiteSignins(app: FastifyInstance, store: object, databaseUrl?: string | null) {
  const repository = databaseUrl ? PostgresSiteSigninsRepository.fromConnectionString(databaseUrl) : new InMemorySiteSigninsRepository();
  repositories.set(store, repository);
  app.addHook("onClose", () => repository.dispose());
  return repository;
}
/** Read paths can receive non-web URLs: those have no sign-in recipe. Storage failures still propagate. */
export async function siteSigninFor(store: object, owner: string | null | undefined, site: string | null | undefined) {
  if (!owner || !site) return null;
  const key = siteSigninKeySchema.safeParse({site});
  return key.success ? await siteSigninsFor(store)?.get(owner, key.data.site) ?? null : null;
}
/** Every sign-in of a site, one per account label, "main" first. */
export async function siteSigninsForSite(store: object, owner: string | null | undefined, site: string | null | undefined) {
  const key = owner && site ? siteSigninKeySchema.safeParse({site}) : null;
  if (!owner || !key?.success) return [];
  return ((await siteSigninsFor(store)?.list(owner)) ?? []).filter((row) => row.site === key.data.site)
    .sort((left, right) => Number(right.accountLabel === "main") - Number(left.accountLabel === "main"));
}
/** A read for a non-domain site (a company name, Nous 21/11 02:19Z "Braintrust") has no recipe: say what to ask instead of failing with a ZodError. */
export function nonSiteSigninNote(site: string): string | null {
  if (siteSigninKeySchema.safeParse({site}).success) return null;
  // A URL with credentials answers with its bare domain and never echoes the credentials back (they would land in the turn's result).
  const url = (() => { try { return new URL(site.trim().includes("://") ? site.trim() : `https://${site.trim()}`); } catch { return null; } })();
  const credentials = Boolean(url && (url.username || url.password));
  if (url && credentials) {
    url.username = ""; url.password = "";
    const key = siteSigninKeySchema.safeParse({site: url.href});
    if (key.success) return `That site value carries a user name or password; ask again with only its domain (${key.data.site}), never credentials`;
  }
  // Daily Nous errors 21/11: a credentialed non-public host ("https://user:pw@localhost") echoed its password here; it names the host only.
  const shown = credentials && url ? url.hostname : site.trim().slice(0, 120);
  return `"${shown}" is not a site domain or http(s) URL of a public site (no IP address, localhost or local name)${credentials ? " and must carry no user name or password" : ""}; ask again with its public domain (e.g. app.example.com)`;
}
/** 2026-11-22 REVIEW (1 of 7 reads refused): a read needs only the site, so a public URL carrying a user name or password reads its domain's
 * record with the credentials dropped (never echoed); a value that is no public site stays as given for nonSiteSigninNote. */
export function signinReadSite(site: string): string {
  if (!nonSiteSigninNote(site)) return site;
  try {
    const url = new URL(site.trim().includes("://") ? site.trim() : `https://${site.trim()}`);
    if (!url.username && !url.password) return site;
    url.username = ""; url.password = "";
    return siteSigninKeySchema.safeParse({site: url.href}).success ? url.href : site;
  } catch { return site; }
}
export function safeSigninInput(input: SiteSigninInput): SiteSigninInput {
  return siteSigninRecordSchema.parse(Object.fromEntries(Object.entries(input).map(([key, value]) =>
    [key, typeof value === "string" && ["notes", "reason", "mailbox", "mfa", "username"].includes(key) ? redactMemoryText(value) : value])));
}
export function registerSiteSigninAgentRoutes(app: FastifyInstance, deps: {
  store: SpaceStore; requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{claims: {roomId: string; paneId: string}} | null>;
}) {
  const context = async (request: FastifyRequest, reply: FastifyReply) => {
    const bridge = await deps.requireBridge(request, reply); if (!bridge) return null;
    const room = await deps.store.getRoom(bridge.claims.roomId);
    const pane = await deps.store.getPane(bridge.claims.paneId);
    const owner = await deps.store.getPaneOwner?.(pane.id) ?? room.ownerUserId;
    if (!owner) throw new SpaceConflictError("This room has no owner for site sign-in memory.");
    return {owner, pane};
  };
  app.get("/api/cli/site-signins", async (request, reply) => {
    const ctx = await context(request, reply); if (!ctx) return reply;
    const input = parseQuery(siteSigninKeySchema.extend({site: z.string().trim().min(1).max(2000)}), request.query);
    const site = signinReadSite(input.site);
    const note = nonSiteSigninNote(site);
    if (note) return {signin: null, note};
    return {signin: await siteSigninsFor(deps.store)!.get(ctx.owner, site, input.accountLabel)};
  });
  app.post("/api/cli/site-signins", async (request, reply) => {
    const ctx = await context(request, reply); if (!ctx) return reply;
    const input = safeSigninInput(parseBody(siteSigninRecordSchema, request.body));
    return {signin: await siteSigninsFor(deps.store)!.record(ctx.owner, input, `${ctx.pane.mode}:${ctx.pane.id}`)};
  });
}
/** A handoff confirms authentication only when it was specifically for LOGIN/MFA. Keep the original site through SSO redirects. */
export async function recordCompletedSiteHandoff(store: object, handoff: BrowserHandoffRequest) {
  if (!siteSigninsFor(store)) return;
  const access = store as SpaceStore;
  if (!/^(LOGIN|MFA):/.test(handoff.reason)) return;
  const owner = await access.getPaneOwner?.(handoff.paneId) ?? (await access.getRoom(handoff.roomId)).ownerUserId;
  if (!owner) return;
  const session = (await access.listActivePaneBrowserSessions(handoff.roomId)).find((entry) => entry.paneId === handoff.paneId);
  const site = /\[site:([^\]]+)\]/.exec(handoff.reason)?.[1] ?? session?.currentUrl;
  if (!site || !siteSigninKeySchema.safeParse({site}).success) return;
  const by = `OPERATOR:${handoff.handoffRequestId}`;
  if ((await siteSigninFor(store, owner, site))?.lastSuccessBy === by) return;
  await siteSigninsFor(store)?.record(owner, {site, accountLabel: "main", outcome: "SUCCESS", ...(session?.profileId ? {browserProfileId:session.profileId} : {})}, by);
}
export async function signinHandoffRecipe(store: object, owner: string | null | undefined, url: string | null, triedStored?: boolean) {
  const signin = await siteSigninFor(store, owner, url);
  const key = url ? siteSigninKeySchema.safeParse({site:url}) : null;
  return {signin, blocked: Boolean(signin && !triedStored), site: key?.success ? key.data.site : null};
}
