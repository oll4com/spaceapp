import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { LINK_APP, LINK_REMOTE_ROUTES, LINK_ROUTE_SCOPES, decodeMobilePairQr, mobileDecisionContentHash, nousLinkDecisionSchema, signNousLinkAnswer, type NousLinkAnswerStatement, type NousLinkDecision, gatewayApiKeyCreateRequestSchema, nousLoadRangeSchema, vaultBase64url as b64, type MobileRouteRule, type NousLoad } from "@space/contracts";
import { InMemoryInstanceLinkRepository, PostgresInstanceLinkRepository, type InstanceLinkAccessKeys, type InstanceLinkRecord } from "@space/db";
import type { SpaceStore } from "@space/runtime";
import { ConnectorError, connectorSealContext, type ConnectorCrypto } from "../dot-connectors.js";
import { sendApiError } from "../http-errors.js";
import { recordAudit } from "../request-audit.js";
import type { VaultModule } from "../vault/wiring.js";
import { registerLinkVaultSync } from "./vault-sync.js";
import { registerLinkSettingsSync, type LinkSyncState } from "./settings-sync.js";
import { siteSigninsFor } from "../site-signins.js";
import { connectInstanceLink, InstanceLinkError, pairInstanceLink, type InstanceLinkReply, type InstanceLinkSession } from "./client.js";
import { linkedLoadRow, type LinkedLoadInput } from "./linked-load.js";
import { linkAiServe } from "./ai-lend.js";
import { nousStatement } from "./nous-hierarchy.js";
import { LinkNotSentError, linkBodyProblem, roomMissing, roomOf } from "./preflight.js";
import type { GatewayAdminService } from "../gateway/gateway-service.js";
import { gatewayCliAccountProfiles } from "../gateway/gateway-cli-accounts.js";
import { fullSyncCommit, registerVersionSyncRoutes, syncLinkVersion, type LinkVersion } from "./version-sync.js";
import { STEP_UP_ROUTES } from "../step-up.js";

// Space Link (ADR-014, docs/agents/instance-links.md): the SpaceApps this one's Nous manages. A person only (Settings), never a phone, a
// proof, automation or broker session; USER accounts never reach /api/instance-links (owned-resource-access.ts denies by default).

const vaultKeyId = z.string().regex(/^vault_key:[A-Za-z0-9_-]{8,64}$/);
// `access`: the Vault key ids of a Cloudflare Access service token in front of that SpaceApp's channel (a Service Auth policy, never a bypass).
const pairSchema = z.object({ code: z.string().trim().min(1).max(4000), access: z.object({ clientId: vaultKeyId, clientSecret: vaultKeyId }).strict().optional() }).strict();
const view = (link: InstanceLinkRecord, live: boolean) => ({ id: link.id, label: link.label, origins: link.origins, deviceId: link.deviceId, scopes: link.scopes,
  access: link.accessKeys, createdAt: link.createdAt, lastSeenAt: link.lastSeenAt, connected: live });
export type InstanceLinkView = ReturnType<typeof view>;
/** A linked SpaceApp's last overview (its own GET /api/nous/overview), as this side read it. */
export type PeerReading = { link: InstanceLinkView; overview: unknown; at: string | null; error: string | null };
export type InstanceLinkAnswer = InstanceLinkReply & { link: InstanceLinkView; scopes: string[]; rttMs: number };

/**
 * The other side's rule for `method path` (LINK_ROUTE_SCOPES), or null: this side sends nothing else. A path parameter is an id
 * (letters, digits, _ : -), so no dot segment or encoded byte reaches the other side; it checks the same table again.
 */
export function linkRoute(method: string, path: string): MobileRouteRule | null {
  const [pathname] = path.split("?");
  const key = Object.keys(LINK_ROUTE_SCOPES).find((entry) => {
    const [verb, pattern] = entry.split(" ");
    return verb === method && new RegExp(`^${pattern!.replace(/:[A-Za-z]+/g, "[A-Za-z0-9_:-]+")}$`).test(pathname!);
  });
  return key ? LINK_ROUTE_SCOPES[key]! : null;
}

/** What Nous reaches (space_instances, space_remote): the owner's links, and one request into one of them. */
export interface InstanceLinks {
  list(owner: string): Promise<InstanceLinkView[]>;
  /** `ref` is the link's id or its label when no other link has it. Throws InstanceLinkError when it is not linked or the route is not a link's. */
  request(owner: string, ref: string, method: "GET" | "POST" | "PATCH", path: string, body?: unknown, headers?: Record<string, string>): Promise<InstanceLinkAnswer>;
  /** Each link's last overview for Nous's world (Λ6). Never waits for a link: an older reading is read again in the background. */
  peers(owner: string): Promise<PeerReading[]>;
  /** Syncs one link now (Vault, settings, memory, sign-ins) and says, per category, whether both sides match (space_link_parity). */
  parity(owner: string, ref: string): Promise<LinkParity>;
  /** "Lend AI accounts" of one link (operator 22/11, space_link_lend); "Sync the Vault" stays the person's switch (Vault security). */
  lend(owner: string, ref: string, on: boolean): Promise<{ link: InstanceLinkView; ai: boolean; aiError: string | null }>;
}
export type LinkParity = { link: InstanceLinkView; commit: string | null; version: LinkVersion | null; ai: boolean | null; aiError: string | null;
  vault: { syncedAt: string | null; error: string | null } | null; sync: LinkSyncState | null };
// Technical bound (the other side's load): its overview builds its whole world, so a link is read at most once a minute however many turns run.
const PEER_READ_MS = 60_000;
const services = new WeakMap<object, InstanceLinks>();
/** The store's linked SpaceApps (Nous's tools find them through the store they share, as appointmentsFor does). */
export const instanceLinksFor = (store: object) => services.get(store);

export function registerInstanceLinks(app: FastifyInstance, options: {
  store: Pick<SpaceStore, "recordAuditEvent" | "upsertUser" | "listAuditEventsSince" | "getUserSettings" | "updateUserSettings">; crypto: ConnectorCrypto; databaseUrl: string | null | undefined;
  routeOptions: Pick<RouteShorthandOptions, "config">; assertPerson: (request: FastifyRequest) => void; version: string;
  /** A fresh Google sign-in, mailed link or SpaceApp password for this web session: approving or answering a linked Nous's decision needs it (v2 step 9). */
  stepUp?: { fresh(request: FastifyRequest): boolean };
  /** A kept Vault key's value of the owner (null when it is not a kept key with a value): a link's Access service token. */
  vaultKey?: (owner: string, id: string) => Promise<string | null>;
  /** The commit this SpaceApp runs (its /version), and whether its links follow it and it follows a link (stable, not packaged). */
  commit?: () => Promise<string | null>; versionSync?: boolean;
  /** AI lending (plan step 6): this SpaceApp's Gateway, its keys (created lazily, app.ts) and its address. */
  gateway?: { service: () => Pick<GatewayAdminService, "listApiKeys" | "createApiKey" | "updateApiKey" | "regenerateApiKey" | "serves">; url: string };
  /** Vault→Vault over the link (plan clipboard:TcX66vjNuZDv step 2): this SpaceApp's Vault (storage and broker). */
  vault?: () => Pick<VaultModule, "repository" | "broker">;
  /** Nous hierarchy (plan step 9): this SpaceApp's identity key (set up when missing), and the identity keys above its own Nous, nearest first. */
  nous?: { identity: () => Promise<{ privateKey: Uint8Array; publicKey: Uint8Array } | null>; chain: (owner: string) => Promise<string[]> };
}) {
  const repository = options.databaseUrl ? PostgresInstanceLinkRepository.fromConnectionString(options.databaseUrl) : new InMemoryInstanceLinkRepository();
  const sealContext = (link: Pick<InstanceLinkRecord, "id" | "ownerUserId">) => connectorSealContext("instance-link", link.ownerUserId, link.id);
  // One open session per link, reused while it stays open; the other side ends it after 24 h and the next request connects again.
  const sessions = new Map<string, Promise<InstanceLinkSession>>();
  const live = (id: string) => sessions.has(id);
  app.addHook("onClose", async () => {
    for (const pending of sessions.values()) void pending.then((session) => session.close(), () => undefined);
    await repository.dispose();
  });

  // The values are read from the Vault for each connect and go only into the WebSocket's headers: never stored, logged or answered.
  async function accessHeaders(owner: string, keys: InstanceLinkAccessKeys | null): Promise<Record<string, string>> {
    if (!keys) return {};
    const ids = [keys.clientId, keys.clientSecret];
    const values = await Promise.all(ids.map(async (key) => (await options.vaultKey?.(owner, key)) ?? null));
    const missing = ids.filter((_, index) => !values[index]);
    if (missing.length) throw new ConnectorError(409, "VAULT_KEY_UNAVAILABLE", `The Vault has no kept value for ${missing.join(" and ")}; keep it in Vault > Keys.`);
    return { "CF-Access-Client-Id": values[0]!, "CF-Access-Client-Secret": values[1]! };
  }

  async function session(link: InstanceLinkRecord): Promise<InstanceLinkSession> {
    const cached = sessions.get(link.id);
    if (cached) {
      const open = await cached.catch(() => null);
      if (open && !open.closed()) return open;
      if (sessions.get(link.id) === cached) sessions.delete(link.id);
    }
    const pending = (async () => {
      const devicePrivate = b64.decode(options.crypto.open(link.sealedDevicePrivate, sealContext(link)));
      const opened = await connectInstanceLink({ ...link, devicePrivate }, options.version, await accessHeaders(link.ownerUserId, link.accessKeys),
        options.gateway ? linkAiServe(options.gateway.url, () => lentKey(link.id), () => lendingTo.has(link.id)) : undefined,
        // A grant changed there mid-session: kept at once, so the list and the send preflight stop reading the connect's scopes.
        (scopes) => void repository.seen(link.id, { atIso: new Date().toISOString(), scopes }).catch(() => undefined));
      await repository.seen(link.id, { atIso: new Date().toISOString(), scopes: opened.scopes, ...opened.rotated });
      return opened;
    })();
    sessions.set(link.id, pending);
    pending.then(() => announce(link), () => { if (sessions.get(link.id) === pending) sessions.delete(link.id); });
    return pending;
  }

  // Nous hierarchy (plan step 9): a link whose grant holds nous hears, signed, that this Nous is its superior and which Nous are above this
  // one; again on each new session and whenever that chain changes (a 30 s pass over the open sessions). Its refusal (a cycle) shows in Settings.
  const nousErrors = new Map<string, string | null>();
  const announced = new WeakMap<InstanceLinkSession, string>();
  // Step 9b: the last report on this Nous's commands there (its status and the request's words), read on each pass, unaudited as a read.
  const nousReports = new Map<string, { status: string; text: string; at: string } | null>();
  // Step 9c: its open RELEASE, DESTRUCTIVE, EXTERNAL and DIRECTION decisions, read on the same pass; this SpaceApp's person answers them below.
  const nousDecisions = new Map<string, NousLinkDecision[]>();
  async function announce(link: InstanceLinkRecord) {
    if (!options.nous) return;
    try {
      const open = await session(link);
      if (!open.scopes.includes("nous")) { nousDecisions.delete(link.id); return; }
      const identity = await options.nous.identity();
      if (!identity) throw new Error("This SpaceApp has no identity key to sign as superior with.");
      const body = nousStatement(identity, link.identityPublic, link.deviceId, `SpaceApp ${hostname()}`, hostname(), await options.nous.chain(link.ownerUserId));
      const key = JSON.stringify(body.statement);
      if (announced.get(open) !== key) {
        const answer = await call(link, "POST", "/api/nous/link/superior", body);
        if (answer.status !== 200) throw new Error((answer.body as { error?: { message?: string } } | null)?.error?.message ?? `it answered ${answer.status}`);
        announced.set(open, key);
        nousErrors.set(link.id, null);
      }
      const reports = await open.request("GET", "/api/nous/link/reports");
      const last = reports.status === 200 ? (reports.body as { reports?: Array<{ status: string; text: string; doneAt?: string; answeredAt?: string; createdAt: string }> }).reports?.at(-1) : undefined;
      if (reports.status === 200) nousReports.set(link.id, last ? { status: last.status, text: last.text, at: last.doneAt ?? last.answeredAt ?? last.createdAt } : null);
      const decisions = await open.request("GET", "/api/nous/link/decisions");
      // Its answer is data: a decision that does not parse is left out (an older SpaceApp answers 404 and shows none).
      if (decisions.status === 200) nousDecisions.set(link.id, ((decisions.body as { decisions?: unknown[] } | null)?.decisions ?? [])
        .flatMap((decision) => { const parsed = nousLinkDecisionSchema.safeParse(decision); return parsed.success ? [parsed.data] : []; }));
    } catch (error) { nousErrors.set(link.id, error instanceof Error ? error.message : String(error)); }
  }
  if (options.nous) {
    const timer = setInterval(() => void repository.listAll().then((links) => Promise.all(links.filter((link) => live(link.id)).map(announce))).catch(() => undefined), 30_000);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }

  // A SpaceApp built before Λ4 (13/11; spaceapp-hz ran 0.2.5 at cdd498440a on 15/11) refuses a req frame carrying x-space-link-request
  // (its frame schema is strict) and closes 4400 before anything runs: every act failed. So a session asks once with a read carrying it,
  // and where that is refused its acts go without it (its side audits them under its own trace). A read never runs twice; an act could.
  const traces = new WeakMap<InstanceLinkSession, Promise<boolean>>();
  async function traced(link: InstanceLinkRecord): Promise<{ open: InstanceLinkSession; trace: boolean }> {
    const open = await session(link);
    if (!traces.has(open)) {
      traces.set(open, open.request("GET", "/api/auth/me", undefined, `lnk:${b64.encode(randomBytes(12))}`).then(() => true, (error: unknown) => {
        if (open.closed() === 4400) return false;
        traces.delete(open);
        throw error;
      }));
    }
    if (await traces.get(open)) return { open, trace: true };
    const again = await session(link);
    if (!traces.has(again)) traces.set(again, Promise.resolve(false));
    return { open: again, trace: false };
  }

  async function call(link: InstanceLinkRecord, method: "GET" | "POST" | "PATCH", path: string, body?: unknown, headers?: Record<string, string>): Promise<InstanceLinkAnswer> {
    // An act is audited here and on the other side under one trace id (Λ4); reads are not (Load reads every 30 s).
    const requestId = linkRoute(method, path)?.scope === "read" ? undefined : `lnk:${b64.encode(randomBytes(12))}`;
    let status: number | null = null;
    try {
      const { open, trace } = requestId ? await traced(link) : { open: await session(link), trace: false };
      const started = Date.now();
      const answer = await open.request(method, path, body, trace ? requestId : undefined, headers);
      status = answer.status;
      return { link: view((await repository.get(link.ownerUserId, link.id)) ?? link, true), scopes: open.scopes, rttMs: Date.now() - started, ...answer };
    } finally {
      if (requestId) await Promise.resolve(options.store.recordAuditEvent({ actorUserId: link.ownerUserId, traceId: requestId, action: "instance_link.request",
        targetType: "instance_link", targetId: link.id, metadata: { via: "link-out", method, path: path.split("?")[0], status, label: link.label } })).catch(() => undefined);
    }
  }
  const readings = new Map<string, Omit<PeerReading, "link"> & { tried: number }>();
  function reading(link: InstanceLinkRecord) {
    const kept = readings.get(link.id) ?? { overview: null, at: null, error: null, tried: 0 };
    if (Date.now() - kept.tried < PEER_READ_MS) return kept;
    const next = { ...kept, tried: Date.now() };
    readings.set(link.id, next);
    const keep = (value: Partial<PeerReading>) => { if (readings.get(link.id) === next) readings.set(link.id, { ...next, ...value }); };
    void call(link, "GET", "/api/nous/overview").then((answer) => keep(answer.status === 200
      ? { overview: (answer.body as { overview?: unknown } | null)?.overview ?? null, at: new Date().toISOString(), error: null } : { error: `it answered ${answer.status}` }),
    (error) => keep({ error: error instanceof Error ? error.message : String(error) }));
    return next;
  }
  services.set(options.store, {
    peers: async (owner) => (await repository.list(owner)).map((link) => {
      const { overview, at, error } = reading(link);
      return { link: view(link, live(link.id)), overview, at, error };
    }),
    list: async (owner) => (await repository.list(owner)).map((link) => view(link, live(link.id))),
    async request(owner, ref, method, path, body, headers) {
      // Step 9c: a superior's answer to a decision there carries this SpaceApp's person's signature: its Nous never sends one.
      const rule = linkRoute(method, path);
      if (!rule || rule.superiorSignature) throw new InstanceLinkError(`A linked SpaceApp answers only ${LINK_REMOTE_ROUTES.join(", ")}.`);
      const link = await linkOf(owner, ref);
      if (method === "POST" && path.split("?")[0] === "/api/version-sync") {
        const rawObj = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
        const given = rawObj ? (rawObj.commit ?? rawObj.sha ?? rawObj.target) : body;
        const full = await fullSyncCommit(given, await commit());
        if (!full) throw new LinkNotSentError(`Not sent: POST ${path} takes commit: ${JSON.stringify(given)} is no commit this SpaceApp's git knows; give its full 40-character id, or none for the commit this SpaceApp runs.`);
        body = { ...(rawObj ?? {}), commit: full };
      }
      const problem = linkBodyProblem(rule, method, path, body, link.scopes ?? []);
      if (problem) throw new LinkNotSentError(`Not sent: ${method} ${path} would be refused by ${link.label}: ${problem}`);
      const room = roomOf(path, body);
      if (room) await peerHolds(link, room, method, path);
      return call(link, method, path, body, headers);
    },
    async parity(owner, ref) {
      const link = await linkOf(owner, ref);
      const entry = await syncNow(link);
      return { ...entry, link: view(link, live(link.id)), commit: await commit(), version: versions.get(link.id) ?? null, ai: entry.ai ?? null, aiError: entry.aiError ?? null, vault: entry.vault ?? null };
    },
    async lend(owner, ref, on) {
      const link = await linkOf(owner, ref);
      if (!options.gateway) throw new InstanceLinkError("This SpaceApp has no Gateway to lend.");
      const result = await setLending(link, on, owner);
      await Promise.resolve(options.store.recordAuditEvent({ actorUserId: owner, traceId: `nous:${b64.encode(randomBytes(12))}`, action: "instance_link.ai_lending",
        targetType: "instance_link", targetId: link.id, metadata: { on, via: "nous" } })).catch(() => undefined);
      return { link: view(link, live(link.id)), ...result };
    }
  });
  // The rooms each linked SpaceApp last listed (its ROOMS read again when a request names one not among them).
  const peerRooms = new Map<string, Set<string>>();
  async function peerHolds(link: InstanceLinkRecord, room: string, method: string, path: string) {
    const missing = await roomMissing(peerRooms, link.id, room, async () => {
      const answer = await call(link, "POST", "/api/control/v1/inspect", { section: "ROOMS" });
      return answer.status === 200 ? answer.body : null;
    });
    if (missing) throw new LinkNotSentError(`Not sent: ${method} ${path}: ${link.label} ${missing}`);
  }
  async function linkOf(owner: string, ref: string) {
    const links = await repository.list(owner);
    const { link, matches } = matchLink(links, ref);
    if (!link) throw new InstanceLinkError(matches > 1 ? `${matches} linked SpaceApps are named ${ref}; give its id.`
      : `No linked SpaceApp is ${ref}. Linked: ${links.map((entry) => `${entry.label} (${entry.id})`).join(", ") || "none"}.`);
    return link;
  }

  // Version sync (operator nous_msg:2c4707988f754da5b0719dd5): each linked SpaceApp runs the commit this one runs. Asked after pairing,
  // a minute after start (a promote restarts this API), on each pass and when Settings shows the links; that side decides and may refuse.
  const versions = new Map<string, LinkVersion>();
  const commit = async () => (await options.commit?.()) ?? null;
  const syncVersion = async (link: InstanceLinkRecord, now = false) => {
    const entry = await syncLinkVersion((method, path, body) => call(link, method, path, body), options.versionSync ? await commit() : null, now);
    versions.set(link.id, entry);
    return entry;
  };
  if (options.versionSync && options.commit) {
    const pass = () => void repository.listAll().then((links) => Promise.all(links.map((link) => syncVersion(link)))).catch(() => undefined);
    // Technical bound (the other side's git fetch on each ask): a pass every 15 minutes asks again after a refusal (its repository unreachable, a build running).
    const timers = [setTimeout(pass, 60_000), setInterval(pass, 15 * 60_000)];
    for (const timer of timers) timer.unref();
    app.addHook("onClose", async () => { for (const timer of timers) clearTimeout(timer); });
  }
  registerVersionSyncRoutes(app, { store: options.store, routeOptions: options.routeOptions, assertPerson: options.assertPerson, version: options.version,
    commit, enabled: Boolean(options.versionSync) });

  // AI lending (plan step 6): a Gateway key per link, named for it, so Tokens shows the link's use and its limits there are the link's
  // budget. Lending is on while that key is active; off deactivates it (records are never deleted). Its plaintext lives only here.
  const aiKeyName = (link: InstanceLinkRecord) => `Space Link AI: ${link.label}`.slice(0, 100) + ` (${link.id})`;
  const plainKeys = new Map<string, string>();
  const aiErrors = new Map<string, string | null>();
  /** The links whose AI key is active as of the last pass: a request from any other is refused before its body is held. */
  const lendingTo = new Set<string>();
  const offered = new WeakSet<InstanceLinkSession>();
  const aiKeys = async () => options.gateway ? (await options.gateway.service().listApiKeys()).data.filter((key) => key.name.startsWith("Space Link AI: ")) : [];
  const keyOf = (keys: Awaited<ReturnType<typeof aiKeys>>, linkId: string) => keys.find((key) => key.name.endsWith(` (${linkId})`));
  async function lentKey(linkId: string): Promise<string | null> {
    const key = keyOf(await aiKeys(), linkId);
    if (!key?.isActive) return null;
    if (!plainKeys.has(linkId)) plainKeys.set(linkId, (await options.gateway!.service().regenerateApiKey(key.id))!.plainKey);
    return plainKeys.get(linkId)!;
  }
  // Offers the Gateway on each lending link's open session: again after its 24 h close or a drop (technical: a pass every 30 s).
  let keeping: Promise<void> | null = null;
  const keepLending = () => keeping ??= (async () => {
    const keys = (await aiKeys()).filter((key) => key.isActive);
    for (const link of await repository.listAll()) {
      if (!keyOf(keys, link.id)) { aiErrors.delete(link.id); lendingTo.delete(link.id); continue; }
      lendingTo.add(link.id);
      try {
        const open = await session(link);
        if (!offered.has(open)) {
          // Step 4: every provider a Gateway CLI profile signs in through that this Gateway serves now; B offers those profiles only.
          const providers = (await Promise.all([...new Set(Object.values(gatewayCliAccountProfiles).map((entry) => entry!.provider))]
            .map(async (provider) => await options.gateway!.service().serves(provider).catch(() => false) ? [provider] : []))).flat();
          const answer = await call(link, "POST", "/api/instance-link/ai", { providers });
          if (answer.status !== 200) throw new InstanceLinkError(answer.status === 403
            ? "It does not let this SpaceApp lend AI accounts: its person grants AI accounts in Settings > Account > Devices."
            : `It answered ${answer.status}: ${(answer.body as { error?: { message?: string } } | null)?.error?.message ?? ""}`);
          offered.add(open);
        }
        aiErrors.set(link.id, null);
      } catch (error) { aiErrors.set(link.id, error instanceof Error ? error.message : String(error)); }
    }
  })().catch(() => undefined).finally(() => { keeping = null; });
  if (options.gateway) {
    const timer = setInterval(() => void keepLending(), 30_000);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }

  const person = (request: FastifyRequest) => {
    options.assertPerson(request);
    if (request.appSession) throw Object.assign(new Error("Link other SpaceApps from SpaceApp on a computer (Settings > Linked SpaceApps)."), { statusCode: 403 });
    return request.user!.id;
  };
  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ConnectorError) return sendApiError(reply, error.status, error.code, error.message);
    if (error instanceof InstanceLinkError) return sendApiError(reply, 502, "INSTANCE_LINK", error.message);
    throw error;
  };

  const entry = (link: InstanceLinkRecord, keys: Awaited<ReturnType<typeof aiKeys>>) => ({ ...view(link, live(link.id)),
    ...(options.gateway ? { ai: Boolean(keyOf(keys, link.id)?.isActive), aiError: aiErrors.get(link.id) ?? null } : {}),
    ...(vaultSync ? { vault: vaultSync.state(link) } : {}), sync: settingsSync.state(link), ...(options.nous ? { nousError: nousErrors.get(link.id) ?? null, nousReport: nousReports.get(link.id) ?? null } : {}) });
  app.get("/api/instance-links", options.routeOptions, async (request) => {
    const owner = person(request);
    const keys = await aiKeys().catch(() => []);
    return { links: (await repository.list(owner)).map((link) => entry(link, keys)) };
  });
  // Step 9c (ADR-014 v2): this SpaceApp's person answers a linked Nous's decision; it goes signed by this SpaceApp's identity key over the
  // decision as shown here, and that side accepts it only from its superior with the decision unchanged. Its own person can answer first.
  // The Nous app answers them too, over its paired channel only (the gate checked decide and the signature first); a SpaceApp link never does.
  const decider = (request: FastifyRequest) => request.mobileDevice && request.appSession !== LINK_APP ? request.user!.id : person(request);
  app.get("/api/instance-links/decisions", options.routeOptions, async (request) => {
    const links = await repository.list(decider(request));
    return { decisions: links.flatMap((link) => (nousDecisions.get(link.id) ?? []).map((decision) => ({ linkId: link.id, label: link.label, decision }))) };
  });
  const linkAnswer = z.object({ answer: z.enum(["APPROVE", "DECLINE", "ANSWER"]), text: z.string().trim().min(1).max(2_000).optional() }).strict()
    .refine((input) => input.answer !== "ANSWER" || Boolean(input.text), { message: "An answer needs text." });
  app.post<{ Params: { id: string; decisionId: string } }>("/api/instance-links/:id/decisions/:decisionId/answer", options.routeOptions, async (request, reply) => {
    const owner = decider(request);
    const input = linkAnswer.safeParse(request.body);
    if (!input.success) return sendApiError(reply, 400, "INVALID_REQUEST", "The body is {answer: APPROVE|DECLINE|ANSWER, text?}; an answer needs text.");
    // Plan clipboard:zqVWdClsx_pA step 9: the operator answers from above with their own step-up; declining needs none.
    if (input.data.answer !== "DECLINE" && options.stepUp && !options.stepUp.fresh(request)) {
      return sendApiError(reply, 401, "STEP_UP_REQUIRED", "Confirm it is you with Google or a link by mail, then answer within 5 minutes.",
        STEP_UP_ROUTES);
    }
    const link = await repository.get(owner, request.params.id);
    if (!link) return sendApiError(reply, 404, "NOT_FOUND", "No such linked SpaceApp.");
    const decision = nousDecisions.get(link.id)?.find((entry) => entry.id === request.params.decisionId);
    if (!decision) return sendApiError(reply, 404, "NOT_FOUND", "That decision is not open there any more; refresh.");
    const identity = await options.nous?.identity();
    if (!identity) return sendApiError(reply, 409, "NO_IDENTITY", "This SpaceApp has no identity key to sign with.");
    const statement: NousLinkAnswerStatement = { v: 1, to: link.identityPublic, decisionId: decision.id, contentHash: mobileDecisionContentHash(decision),
      answer: input.data.answer, ...(input.data.text ? { text: input.data.text } : {}), at: new Date().toISOString() };
    try {
      const answer = await call(link, "POST", `/api/nous/link/decisions/${decision.id}/answer`, { statement, signature: signNousLinkAnswer(statement, identity.privateKey) });
      await announce(link);
      const body = answer.body as { decision?: unknown; error?: { code?: string; message?: string } } | null;
      return answer.status === 200 ? { decision: body?.decision ?? null }
        : sendApiError(reply, answer.status >= 500 ? 502 : answer.status, body?.error?.code ?? "INSTANCE_LINK", body?.error?.message ?? `It answered ${answer.status}.`);
    } catch (error) { return failed(reply, error); }
  });

  // Sync now (plan TcX66vjNuZDv step 6): the Vault (when on), settings, memory and sign-ins of one link at once; each category keeps its own error.
  async function syncNow(link: InstanceLinkRecord) {
    if (vaultSync) await vaultSync.now(link);
    await settingsSync.now(link);
    await announce(link);
    return entry((await repository.get(link.ownerUserId, link.id)) ?? link, await aiKeys().catch(() => []));
  }
  app.post<{ Params: { id: string } }>("/api/instance-links/:id/sync", options.routeOptions, async (request, reply) => {
    const link = await repository.get(person(request), request.params.id);
    if (!link) return sendApiError(reply, 404, "NOT_FOUND", "No such linked SpaceApp.");
    return { link: await syncNow(link) };
  });

  // "Lend AI accounts" (plan step 6): on makes or reactivates the link's Gateway key and offers it now; off deactivates the key and ends the session.
  app.post<{ Params: { id: string } }>("/api/instance-links/:id/ai", options.routeOptions, async (request, reply) => {
    const owner = person(request);
    const input = z.object({ on: z.boolean() }).strict().safeParse(request.body);
    if (!input.success) return sendApiError(reply, 400, "INVALID_REQUEST", "on is true or false.");
    const link = await repository.get(owner, request.params.id);
    if (!link) return sendApiError(reply, 404, "NOT_FOUND", "No such linked SpaceApp.");
    if (!options.gateway) return sendApiError(reply, 409, "GATEWAY_UNAVAILABLE", "This SpaceApp has no Gateway to lend.");
    await recordAudit(options.store, request, { action: "instance_link.ai_lending", targetType: "instance_link", targetId: link.id, metadata: { on: input.data.on } });
    return setLending(link, input.data.on, owner);
  });
  /** The route's and Nous's switch (space_link_lend); the caller checked the Gateway. */
  async function setLending(link: InstanceLinkRecord, on: boolean, owner: string) {
    const service = options.gateway!.service();
    const key = keyOf(await aiKeys(), link.id);
    plainKeys.delete(link.id);
    if (on) {
      if (key) await service.updateApiKey(key.id, { isActive: true });
      else plainKeys.set(link.id, (await service.createApiKey(gatewayApiKeyCreateRequestSchema.parse({ name: aiKeyName(link) }), owner)).plainKey);
    } else {
      if (key) await service.updateApiKey(key.id, { isActive: false });
      lendingTo.delete(link.id);
      aiErrors.delete(link.id);
      const pending = sessions.get(link.id);
      sessions.delete(link.id);
      void pending?.then((open) => open.close(), () => undefined);
    }
    if (on) { await keeping; await keepLending(); }
    return { ai: on, aiError: aiErrors.get(link.id) ?? null };
  }

  // The code goes only into the pairing, never into the audit, logs or the answer.
  app.post("/api/instance-links", options.routeOptions, async (request, reply) => {
    const owner = person(request);
    const input = pairSchema.safeParse(request.body ?? {});
    if (!input.success) return sendApiError(reply, 400, "INVALID_INPUT", "The body takes code (the SPACEAPP-PAIR code that SpaceApp shows in Settings > Mobile app) and, behind Cloudflare Access, access {clientId, clientSecret} as Vault key ids.");
    const accessKeys = input.data.access ?? null;
    // A SpaceApp whose Nous is above this one's: managing it from here would close a loop (plan step 9).
    let target: string | null = null;
    try { target = decodeMobilePairQr(input.data.code.trim(), Math.floor(Date.now() / 1000)).i; } catch { /* pairInstanceLink says what is wrong with it */ }
    if (target && options.nous && (await options.nous.chain(owner)).includes(target)) {
      return sendApiError(reply, 409, "NOUS_LINK_CYCLE", "That SpaceApp's Nous is above this one's; linking it here would make a Nous answer to itself.");
    }
    let paired;
    try { paired = await pairInstanceLink(input.data.code, `SpaceApp ${hostname()}`, options.version, await accessHeaders(owner, accessKeys)); } catch (error) {
      if (error instanceof InstanceLinkError || error instanceof ConnectorError) return failed(reply, error);
      return sendApiError(reply, 400, "INVALID_INPUT", error instanceof Error && error.message.includes("expired") ? error.message : "That is not a valid SpaceApp pairing code.");
    }
    const id = `link:${randomBytes(12).toString("base64url")}`;
    let link;
    try {
      link = await repository.create({ id, ownerUserId: owner, label: paired.label, origins: paired.origins, noisePublic: paired.noisePublic, identityPublic: paired.identityPublic,
        deviceId: paired.deviceId, scopes: paired.scopes, accessKeys, sealedDevicePrivate: options.crypto.seal(b64.encode(paired.devicePrivate), sealContext({ id, ownerUserId: owner })) });
    } catch (error) { return failed(reply, error); }
    await recordAudit(options.store, request, { action: "instance_link.paired", targetType: "instance_link", targetId: id,
      metadata: { label: paired.label, origins: paired.origins, deviceId: paired.deviceId, pending: paired.pending, access: accessKeys } });
    void syncVersion(link).catch(() => undefined);
    return { link: entry(link, await aiKeys().catch(() => [])), pending: paired.pending };
  });

  // Settings > Linked SpaceApps: this SpaceApp's version, and each link's with its last sync (read now, asked to follow when behind).
  app.get("/api/instance-links/versions", options.routeOptions, async (request) => {
    const links = await repository.list(person(request));
    return { local: { commit: await commit(), version: options.version, syncing: Boolean(options.versionSync) },
      links: Object.fromEntries(await Promise.all(links.map(async (link) => [link.id, await syncVersion(link)] as const))) };
  });

  // "Upgrade to this version" (plan step 4): asks now, also after a failure or rollback the passes no longer retry; that side decides.
  app.post<{ Params: { id: string } }>("/api/instance-links/:id/upgrade", options.routeOptions, async (request, reply) => {
    const link = await repository.get(person(request), request.params.id);
    if (!link) return sendApiError(reply, 404, "NOT_FOUND", "No such linked SpaceApp.");
    if (!options.versionSync) return sendApiError(reply, 409, "VERSION_SYNC_OFF", "This SpaceApp does not upgrade linked SpaceApps (a dev instance or a packaged install).");
    const entry = await syncVersion(link, true);
    await recordAudit(options.store, request, { action: "instance_link.upgrade_requested", targetType: "instance_link", targetId: link.id,
      metadata: { from: entry.commit, target: await commit(), error: entry.error } });
    return entry;
  });

  // Connects (or reuses the open session) and asks the other side who this link is: its scopes, and the round trip.
  app.post<{ Params: { id: string } }>("/api/instance-links/:id/check", options.routeOptions, async (request, reply) => {
    const link = await repository.get(person(request), request.params.id);
    if (!link) return sendApiError(reply, 404, "NOT_FOUND", "No such linked SpaceApp.");
    try {
      const { link: seen, scopes, status, rttMs } = await call(link, "GET", "/api/auth/me");
      // The list's shape (vault, ai, sync), so Settings keeps "Sync the Vault" and "Lend AI accounts" on the row after Check.
      return { link: { ...entry(link, await aiKeys().catch(() => [])), ...seen }, scopes, status, rttMs };
    } catch (error) { return failed(reply, error); }
  });

  // Λ4: what this SpaceApp did through one link (its acts and pairing), inside the History period (HISTORY_FLOORS sets `since`).
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>("/api/instance-links/:id/history", options.routeOptions, async (request, reply) => {
    const owner = person(request);
    if (!(await repository.get(owner, request.params.id))) return sendApiError(reply, 404, "NOT_FOUND", "No such linked SpaceApp.");
    const since = Number.isNaN(Date.parse(request.query.since ?? "")) ? new Date(0).toISOString() : request.query.since!;
    const rows = await options.store.listAuditEventsSince?.({ actions: ["instance_link.paired", "instance_link.request"], since }) ?? [];
    return { events: rows.filter((row) => row.targetType === "instance_link" && row.targetId === request.params.id && row.actorUserId === owner)
      .map((row) => ({ id: row.id, action: row.action, requestId: row.traceId, metadata: row.metadata, createdAt: row.createdAt })) };
  });

  // Λ7: each linked SpaceApp's own load, read in parallel; one that does not answer gives its error, and the web keeps its last reading.
  // The Load page, the Live card and the Nous app's Resources (Λ9 phone read, without the links' addresses): each link's load, as rows.
  const answeredAt = new Map<string, string>();
  app.get("/api/instance-links/load", options.routeOptions, async (request, reply) => {
    // The Nous app reads it over its channel or its app session, as /api/instance-links/status; it gets only the rows.
    const phone = Boolean(request.mobileDevice || request.appSession);
    if (phone && !request.mobileDevice) options.assertPerson(request);
    const owner = phone ? request.user!.id : person(request);
    const range = nousLoadRangeSchema.default("1h").safeParse((request.query as { range?: unknown }).range);
    if (!range.success) return sendApiError(reply, 400, "INVALID_INPUT", "range is 1h, 24h, 7d or 30d.");
    const links = await repository.list(owner);
    return { instances: await Promise.all(links.map(async (link) => {
      let shown = view(link, live(link.id)), load: NousLoad | null = null, health: LinkedLoadInput["health"] = null, error: string | null = null;
      try {
        const answer = await call(link, "GET", `/api/nous/load?range=${range.data}`);
        shown = answer.link;
        if (answer.status === 200) load = answer.body as NousLoad;
        else {
          const said = (answer.body as { error?: { message?: unknown } } | null)?.error?.message;
          error = typeof said === "string" ? said : `It answered ${answer.status}.`;
          // One built before /api/nous/load reached a link (spaceapp-hz 0.2.5 answers 403) still answers its SYSTEM_HEALTH inspect, a read.
          const inspect = await call(link, "POST", "/api/control/v1/inspect", { section: "SYSTEM_HEALTH" });
          const metrics = (inspect.body as { metrics?: unknown } | null)?.metrics;
          if (inspect.status === 200 && Array.isArray(metrics)) [health, error] = [metrics as LinkedLoadInput["health"], null];
        }
      } catch (failure) {
        error = failure instanceof Error ? failure.message : "It did not answer.";
      }
      const answered = Boolean(load || health);
      if (answered) answeredAt.set(link.id, new Date().toISOString());
      const agents = answered ? (reading(link).overview as { live?: { agents?: { running?: unknown; total?: unknown } } } | null)?.live?.agents ?? null : null;
      const row = linkedLoadRow({ link, load, health, agents, answered, answeredAt: answeredAt.get(link.id) ?? link.lastSeenAt, error });
      return phone ? { row } : { link: shown, load, error, row };
    })) };
  });

  const vaultSync = options.vault ? registerLinkVaultSync(app, { vault: options.vault, repository, call, routeOptions: options.routeOptions, person,
    audit: (request, action, linkId, metadata) => recordAudit(options.store, request, { action, targetType: "instance_link", targetId: linkId, metadata }) }) : null;

  const settingsSync = registerLinkSettingsSync(app, { store: options.store, repository, call, routeOptions: options.routeOptions, commit, signins: () => siteSigninsFor(options.store),
    audit: (request, metadata) => recordAudit(options.store, request, { action: "instance_link.sync", targetType: "app_device_session", targetId: request.mobileDevice?.id ?? "", metadata }) });

  // Removing forgets this side's key: the link can never connect again. Its device stays listed there until its person revokes it.
  app.delete<{ Params: { id: string } }>("/api/instance-links/:id", options.routeOptions, async (request, reply) => {
    const owner = person(request);
    const pending = sessions.get(request.params.id);
    // Its agents stop filling with this Vault first (best effort: an unreachable side keeps its copy until its person turns access off).
    const synced = await repository.get(owner, request.params.id);
    if (synced && vaultSync) await vaultSync.stop(synced);
    // Its AI key stops too (security review 15/11): lending is on only while that key is active, and records are never deleted.
    const aiKey = synced ? keyOf(await aiKeys().catch(() => []), synced.id) : undefined;
    if (aiKey?.isActive) await options.gateway!.service().updateApiKey(aiKey.id, { isActive: false });
    plainKeys.delete(request.params.id);
    lendingTo.delete(request.params.id);
    if (!(await repository.remove(owner, request.params.id))) return sendApiError(reply, 404, "NOT_FOUND", "No such linked SpaceApp.");
    sessions.delete(request.params.id);
    readings.delete(request.params.id);
    versions.delete(request.params.id);
    void pending?.then((open) => open.close(), () => undefined);
    await recordAudit(options.store, request, { action: "instance_link.removed", targetType: "instance_link", targetId: request.params.id });
    return { ok: true };
  });

  return { repository, session,
    linkedDecision: async (owner: string, linkId: string, id: string) => (await repository.get(owner, linkId)) ? nousDecisions.get(linkId)?.find((entry) => entry.id === id) ?? null : null };
}

/**
 * The link a name points at: its id, else its label, else its address's host (a URL or host:port as a pane writes it), else the first label
 * of that host ("spaceapp-hz" for example.invalid, plan clipboard:zqVWdClsx_pA step 1). Case-insensitive; more than one match is none,
 * with their count.
 */
export function matchLink<T extends { id: string; label: string; origins: string[] }>(links: readonly T[], ref: string): { link: T | null; matches: number } {
  const byId = links.find((entry) => entry.id === ref);
  if (byId) return { link: byId, matches: 1 };
  const key = ref.trim().toLowerCase();
  const address = key.includes("://") ? key : `https://${key}`;
  const host = URL.canParse(address) ? new URL(address).hostname : key;
  const hosts = (link: T) => link.origins.flatMap((origin) => URL.canParse(origin) ? [new URL(origin).hostname] : []);
  for (const matches of [(link: T) => link.label.toLowerCase() === key, (link: T) => hosts(link).includes(host),
    (link: T) => hosts(link).some((name) => name.split(".")[0] === key),
    // Daily Nous errors 23/11 (space_link_parity "hz" failed on example.invalid): a whole word of the label or of the host's first label.
    (link: T) => [...link.label.toLowerCase().split(/[\s_-]+/), ...hosts(link).flatMap((name) => name.split(".")[0]!.split(/[_-]+/))].includes(key)]) {
    const found = links.filter(matches);
    if (found.length) return { link: found.length === 1 ? found[0]! : null, matches: found.length };
  }
  return { link: null, matches: 0 };
}
