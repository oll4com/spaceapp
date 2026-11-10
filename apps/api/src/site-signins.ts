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
    const input = parseQuery(siteSigninKeySchema, request.query);
    return {signin: await siteSigninsFor(deps.store)!.get(ctx.owner, input.site, input.accountLabel)};
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
