import { siteSigninKeySchema } from "@space/contracts";
import type { SiteSigninsRepository, VaultAuditEntry } from "@space/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import {
  newVaultHandle, sealToVaultPublicKey, vaultAgentAuditRequestSchema, vaultAgentAuditResultSchema, vaultAgentCardFillRequestSchema, vaultAgentEmptyRequestSchema, vaultAgentFillRequestSchema, canonicalVaultOrigin, isVaultCardRole,
  vaultAgentGenerateRequestSchema, vaultAgentListRequestSchema, vaultDirtiedBySchema, vaultAgentListResultSchema, vaultAgentResultSchema, vaultAgentSaveRequestSchema, vaultAgentSaveSite, vaultAgentStatusResultSchema, vaultLoginPageProblem, vaultOriginCovers,
  vaultAgentTotpRequestSchema, vaultBase64url, vaultAgentKeyRequestSchema, vaultAgentKeyTakeResultSchema, vaultAgentKeyListRequestSchema, vaultAgentKeyListResultSchema,
  vaultAgentKeySaveRequestSchema, vaultAgentKeySaveResultSchema, vaultPasswordPolicyForField, vaultPolicyConstraints,
  type Pane, type VaultGeneratePolicy, type VaultAgentResult, type VaultAuditEvent, type VaultHostFillResult, type VaultHostTarget
} from "@space/contracts";
import { connectorSealContext, type ConnectorCrypto } from "../dot-connectors.js";
import { ownBrowserPane, type BrowserControlActivity } from "../browser-control-activity.js";
import { isBrowserPane } from "../pane-guards.js";
import type { VaultBroker } from "./broker-client.js";
import type { VaultProtection } from "./protection.js";
import { cliVaultPathPrefix, type VaultStore } from "./routes.js";
import { handOverPendingLogin } from "./handover.js";
import { runVaultSignup } from "./signup.js";
import { markSignin, resetHold, resetRefusal, VAULT_RESET_REASON } from "../signin-readback.js";

// What agents and Nous may do with the Vault (operator decision 2026-10-18, plan clipboard:Ml8zElMcc4Ac). One switch in the
// dock is the whole authorization: while it is on, every item the dock delegated fills with no further approval, and new
// logins can be saved. The value never reaches the caller: the Browser Host types it, the fill's browser stays protected until
// the filled page is gone, and every answer is a status, a reason in the audit and, for a list, handles and origins only.
// Nous calls the same paths as the agents' bridge, so both have identical access.

export const VAULT_AGENT_PATHS = ["status", "list", "audit", "fill", "card-fill", "totp-fill", "generate-fill", "save", "key-take", "key-used", "key-list", "key-save"] as const;
export type VaultAgentPath = (typeof VAULT_AGENT_PATHS)[number];
const actions: Record<VaultAgentPath, VaultAuditEvent["action"]> = {
  status: "AGENT_LIST", list: "AGENT_LIST", audit: "AGENT_LIST", fill: "FILL", "card-fill": "FILL", "totp-fill": "FILL", "generate-fill": "GENERATE", save: "ITEM_SAVE",
  "key-take": "KEY_HANDOFF", "key-used": "KEY_HANDOFF", "key-list": "KEY_HANDOFF", "key-save": "KEY_HANDOFF"
};
/** The calls that need the delegation to hold every saved login (joinMissing). */
const RETRIES_HAND_OVER = new Set<VaultAgentPath>(["status", "list", "fill", "totp-fill", "generate-fill"]);

/**
 * `itemId`: the item a new login or generated password becomes, so the audit (and the dock's Activity) names it. `typed` and
 * `document` come from the Browser Host (never to the caller): a value entered the page, and the document it ran in.
 */
type Outcome = { status: VaultAgentResult["status"]; reason: string | null; itemId?: string; extra?: Record<string, unknown>; typed?: boolean; document?: string | null; origin?: string };
export interface VaultAgentCall {
  owner: string;
  /** The calling pane (a CLI pane, or the pane Nous named). */
  paneId: string;
  roomId: string;
  path: VaultAgentPath;
  body: Record<string, unknown>;
  traceId: string;
  /** The calling CLI (`cli:<session>`): a fill makes it the fence's viewer, so it gets the masked view of the page it filled. */
  viewer?: string;
}

export function createVaultAgent(deps: {
  siteSignins?: SiteSigninsRepository;
  repository: VaultStore | null;
  broker: VaultBroker;
  protection: VaultProtection;
  listPanes(roomId: string): Promise<Pane[]>;
  /** Who drives each pane browser: a fill that names no browser goes only to the caller's own (ownBrowserPane). */
  controlActivity?: Pick<BrowserControlActivity, "agentFor">;
  /** The pane's owner (its explicit owner, else its room's); null when the pane does not exist. */
  paneOwner(paneId: string): Promise<string | null>;
  /** The Browser Host's sealed fill (absent where no Browser Host runs). */
  browser?: { vaultTarget?(pane: Pane): Promise<VaultHostTarget>; vaultFill?(pane: Pane, request: unknown, traceId: string): Promise<VaultHostFillResult> };
  /** The owner's Google accounts (id and address): a list names each login's account (Chrome imports, plan clipboard:SMcT__jALB6R). */
  googleAccounts?(owner: string): Promise<Array<{ id: string; email: string }>>;
  /** The Google account a pane's browser opens with (its id), or null. */
  paneAccount?(owner: string, pane: Pane): Promise<string | null>;
  /** A kept key an agent just saved (Space Gateway takes the free ones). */
  keySaved?(owner: string, key: { label: string; value: string }): void;
  /**
   * Whether an agent session scripted or changed this document in the page's own world (the CDP proxy's marks): the host then
   * starts from a fresh document. Absent: the host reloads every time (its safe default).
   */
  documentDirty?(paneId: string, targetId: string, document: string | null): boolean | Promise<boolean>;
  /** The CDP method that made it dirty, named in a FIELD_NOT_FOUND_AFTER_RELOAD answer (28/10: Job Copilot sign-ups after browser_evaluate). */
  documentDirtiedBy?(paneId: string, targetId: string, document: string | null): string | null | Promise<string | null>;
  /** Opens the API keys the operator handed to agents (sealed by the operator route with the same key). */
  crypto: ConnectorCrypto;
}) {
  const blocked = (reason: string): Outcome => ({ status: "BLOCKED", reason });

  const handOverPending = (repository: VaultStore, owner: string, handle: string) => handOverPendingLogin(repository, deps.broker, owner, handle);

  // A hand-over that failed (the broker restarting, a timeout) is tried again on the next call that needs the login, at most once a
  // minute per owner: a saved login never waits for the operator's unlock (operator 31/10 10:03 BKK).
  // shortcut: only logins the delegation lacks are retried; a changed password of a delegated login whose hand-over failed stays the
  // old one until the dock's next delegation re-attaches it; record joined entries if that ever happens.
  const retriedAt = new Map<string, number>();
  async function joinMissing(repository: VaultStore, owner: string): Promise<void> {
    if (Date.now() - (retriedAt.get(owner) ?? 0) < 60_000) return;
    const delegation = await repository.getActiveDelegation(owner);
    if (!delegation?.inboxKeyEnvelope) return;
    const held = new Set(delegation.certificate.claims.items.map((item) => item.handle));
    const missing = new Set((await repository.listPending(owner)).map((entry) => entry.handle).filter((handle) => !held.has(handle)));
    if (!missing.size) return;
    retriedAt.set(owner, Date.now());
    for (const handle of missing) await handOverPending(repository, owner, handle);
  }

  /** The browser to fill: the named pane, else the caller itself when it is a browser, else its own browser (never another agent's); always the owner's. */
  async function browserPane(call: VaultAgentCall): Promise<Pane | null> {
    const panes = (await deps.listPanes(call.roomId)).filter((pane) => !pane.isClosed);
    const named = call.body.targetPaneId;
    const pane = typeof named === "string" ? panes.find((entry) => entry.id === named)
      : panes.find((entry) => entry.id === call.paneId && isBrowserPane(entry)) ?? ownBrowserPane(panes, call.paneId, deps.controlActivity);
    return pane && isBrowserPane(pane) && await deps.paneOwner(pane.id) === call.owner ? pane : null;
  }

  async function fill(repository: VaultStore, call: VaultAgentCall): Promise<Outcome> {
    const { owner, path, body, traceId } = call;
    const host = deps.browser;
    if (!host?.vaultTarget || !host.vaultFill) return blocked("FILL_PATH_UNAVAILABLE");
    const { vaultTarget, vaultFill } = host;
    const pane = await browserPane(call);
    if (!pane) return blocked("NO_BROWSER");
    const live = async () => {
      const target = await vaultTarget(pane);
      return target.eligible && target.targetId && target.frameId && target.origin
        ? { targetId: target.targetId, frameId: target.frameId, origin: target.origin, document: target.document ?? null, freshDocument: target.freshDocument === true,
          generatePolicy: target.generatePolicy === true, cards: target.cards === true } : target.reason ?? "NOT_ELIGIBLE";
    };
    // Queue item 37: the site's stated password rules go only to a host that takes them (after its guarded restart); an older one
    // would type a password the site refuses, so the call stops here with the reason. A policy nothing satisfies stops too.
    const policy = path === "generate-fill" && body.policy ? body.policy as VaultGeneratePolicy : undefined;
    if (policy) {
      try { const merged = vaultPolicyConstraints({}, policy); vaultPasswordPolicyForField(merged.field, merged.base); } catch { return blocked("POLICY_UNSATISFIABLE"); }
    }
    const withPolicy = (target: { generatePolicy: boolean }) => policy ? target.generatePolicy ? { policy } : null : {};
    // What the host is told about the document: reload only one an agent session touched in the page's own world. Only a host
    // that takes the field gets it (an older host's strict request schema would refuse the fill).
    const freshness = async (target: { targetId: string; document: string | null; freshDocument: boolean }) =>
      deps.documentDirty && target.freshDocument ? { freshDocument: await deps.documentDirty(pane.id, target.targetId, target.document) } : {};
    // The browser is fenced before any value exists; a fill that typed nothing leaves it as it was. One that typed anything keeps
    // the fence, whatever happened after (Vault review 2026-10-22): a failed fill's scrub is best effort.
    const wasProtected = await deps.protection.ownerOf(pane.id) === owner;
    const guarded = async (target: { targetId: string; origin: string; document: string | null; freshDocument: boolean }, fresh: { freshDocument?: boolean },
      run: () => Promise<Outcome>): Promise<Outcome> => {
      if (!await deps.protection.protect(owner, pane.id, { targetId: target.targetId, origin: target.origin, document: target.document }, call.viewer)) return blocked("PANE_PROTECTED_ELSEWHERE");
      const outcome = await run().catch((): Outcome => blocked("FILL_FAILED"));
      if (outcome.status === "SUBMITTED" && path !== "totp-fill" && siteSigninKeySchema.safeParse({site: target.origin}).success) {
        await deps.siteSignins?.record(owner, {site: target.origin, accountLabel: "main", outcome: "PENDING", method: "VAULT_LOGIN",
          username: outcome.itemId ? (await repository.getItem(owner, outcome.itemId))?.metadata.label ?? (typeof body.label === "string" ? body.label : null) : null,
          vaultHandle: outcome.itemId ?? null, browserProfileId: await deps.paneAccount?.(owner, pane) ?? null}, `${pane.mode}:${pane.id}`);
      }
      const entered = outcome.status === "FILLED" || outcome.status === "SUBMITTED";
      // 7/11 Oracle: a set password is a reset the next one waits for; a filled login is tried and waits for its read-back.
      if (entered && path === "fill") markSignin(owner, target.origin, "tried");
      if (entered && path === "generate-fill" && siteSigninKeySchema.safeParse({site: target.origin}).success) {
        await deps.siteSignins?.record(owner, {site: target.origin, accountLabel: "main", outcome: "CHANGED", vaultHandle: outcome.itemId ?? undefined, reason: VAULT_RESET_REASON}, `${pane.mode}:${pane.id}`).catch(() => undefined);
      }
      const kept = entered || outcome.typed === true;
      // The host reloaded the page before typing (a fresh document, with no script an agent left in it): the fence follows that document.
      if (kept && outcome.document && outcome.document !== target.document) {
        await deps.protection.protect(owner, pane.id, { targetId: target.targetId, origin: target.origin, document: outcome.document }, call.viewer);
      }
      if (!wasProtected && !kept) await deps.protection.unprotect(owner, pane.id);
      // The reload lost the field: say which command made the page dirty, so the agent redoes the steps without it. R20-7 (30/10 13:15 BKK,
      // Cleo/Finn on Allianz: FILLED, nothing said, every other field emptied by the reload): a fill after a reload says so too.
      const reloaded = kept && target.freshDocument && fresh.freshDocument !== false;
      const by = outcome.reason === "FIELD_NOT_FOUND_AFTER_RELOAD" || outcome.reason === "RELOAD_WOULD_RESUBMIT" || reloaded
        ? await Promise.resolve(deps.documentDirtiedBy?.(pane.id, target.targetId, target.document)).catch(() => null) : null;
      const extra = { ...(reloaded ? { reloaded: true } : {}), ...(by && vaultDirtiedBySchema.safeParse(by).success ? { dirtiedBy: by } : {}) };
      return Object.keys(extra).length ? { ...outcome, extra: { ...outcome.extra, ...extra } } : outcome;
    };

    // 7/11 Oracle (reset after reset, each never tried): another password reset waits RESET_WAIT_MS and until the last one was filled and read back.
    // nous_msg:fe72e061 (Reddit, Oracle, Upwork): no reset while the stored sign-in works, unless the operator's order (nous_msg id) is passed.
    let operatorOrder: string | null = null;
    const resetRefused = async (origin: string, retryOf?: { createdAt: string }): Promise<Outcome | null> => {
      if (path !== "generate-fill" || !deps.siteSignins || !siteSigninKeySchema.safeParse({site: origin}).success) return null;
      const signin = await deps.siteSignins.get(owner, origin);
      const works = resetRefusal(signin, typeof body.operatorOrder === "string" ? body.operatorOrder : null);
      if (works.refusal) return { status: "BLOCKED", reason: "SIGNIN_WORKS", extra: { message: works.refusal } };
      // 13/11 DCM: retrying a sign-up the site never accepted (no SUCCESS since it) is no reset to wait for.
      const hold = retryOf && !(signin?.lastSuccessAt && signin.lastSuccessAt > retryOf.createdAt) ? null : resetHold(owner, origin, signin);
      if (hold) return blocked(hold);
      if (works.override) {
        operatorOrder = works.override;
        await deps.siteSignins.record(owner, {site: origin, accountLabel: "main", outcome: "CHANGED", reason: `Password reset on the operator's order ${works.override}`}, `${pane.mode}:${pane.id}`).catch(() => undefined);
      }
      return null;
    };
    const ordered = (outcome: Outcome): Outcome => operatorOrder && !outcome.reason ? { ...outcome, reason: "OPERATOR_ORDER" } : outcome;

    // A new account (or a reset of an account without an item) has no item yet: it runs under a sign-up grant the operator
    // signed for the site (option B, signup.ts), else under one the broker mints from the dock's delegation.
    if (path === "generate-fill" && body.purpose === "NEW_ACCOUNT") {
      const target = await live();
      if (typeof target === "string") return blocked(target);
      // 13/11 DCM (the site refused the first generated password, the retry made a second item): a sign-up at this site under the same
      // label the dock has not filed yet is retried on its handle; its new password arrives as that login's change, the old one kept in history.
      const label = String(body.label);
      const retryOf = (await repository.listPending(owner)).findLast((entry) => entry.kind === "NEW_ACCOUNT" && entry.origin === target.origin && entry.label === label.trim());
      const resetWait = await resetRefused(target.origin, retryOf);
      if (resetWait) return resetWait;
      const delegation = await repository.getActiveDelegation(owner);
      // Neither: refused before the browser's automation connections are closed.
      if (!delegation && !(await repository.listSignupGrants(owner)).some((grant) => grant.sites.includes(target.origin))) return blocked("NO_SIGNUP_GRANT");
      const autoGrant = delegation ? () => deps.broker.signupAutoGrant({ ownerUserId: owner, vaultId: delegation.certificate.claims.vaultId,
        certificate: delegation.certificate, origin: target.origin }) : undefined;
      const fresh = await freshness(target);
      const rules = withPolicy(target);
      if (!rules) return blocked("POLICY_NEEDS_HOST_RESTART");
      const created = await guarded(target, fresh, () => runVaultSignup({ repository, fill: (request) => vaultFill(pane, { mode: "SIGNUP", ...request, ...fresh, ...rules }, traceId), autoGrant },
        { owner, paneId: pane.id, target, label, handle: retryOf?.handle, username: typeof body.username === "string" ? body.username : null,
          roles: Array.isArray(body.roles) && body.roles.length ? body.roles as Array<"NEW_PASSWORD" | "CONFIRM_PASSWORD"> : ["NEW_PASSWORD"], submit: body.submit === true }));
      if (created.itemId) await handOverPending(repository, owner, created.itemId);
      return ordered(created);
    }
    const handle = path === "generate-fill" ? String(body.handle) : await paneAccountLogin(repository, owner, pane, String(body.handle));
    const card = path === "card-fill";
    const delegation = await repository.getActiveDelegation(owner);
    const delegated = delegation?.certificate.claims.items.find((item) => item.handle === handle);
    // A card fills every field it holds; a login only the ones asked for.
    const fields = path === "totp-fill" ? ["OTP"] : path === "generate-fill" ? ["PASSWORD"] : card ? delegated?.fields ?? [] : (body.fields as string[]);
    if (!delegation || !delegated || fields.some((field) => !delegated.fields.includes(field as never))) return blocked("NOT_DELEGATED");
    if (card && !delegated.fields.every(isVaultCardRole)) return blocked("NOT_A_CARD");
    // Deleted or hidden since the dock last delegated: the stale envelopes are never used. A login agents saved since the
    // last unlock is no item yet, only its inbox entry.
    const item = await repository.getItem(owner, handle);
    const saved = item ? null : (await repository.listPending(owner)).find((entry) => entry.handle === handle);
    if (item ? item.metadata.status !== "ACTIVE" || !item.metadata.policy.agentUse : !saved) return blocked("NOT_DELEGATED");
    const label = item?.metadata.label ?? saved!.label;
    const submit = body.submit === true;
    if (submit && !delegated.submit) return blocked("SUBMIT_NOT_ALLOWED");
    const target = await live();
    if (typeof target === "string") return blocked(target);
    if (card) {
      // An older Browser Host has no CARD mode (its strict schema would refuse it): stop before the broker issues a capability.
      if (!target.cards) return blocked("CARD_NEEDS_HOST_RESTART");
      // A card pays at any merchant, but only on a clean https page (the broker checks the same).
      const site = canonicalVaultOrigin(target.origin);
      if (site?.origin !== target.origin || site.warnings.length > 0) return { status: "ORIGIN_MISMATCH", reason: "CARD_NEEDS_HTTPS", origin: site?.origin };
    } else if (!vaultOriginCovers(delegated.origins, target.origin)) return { status: "ORIGIN_MISMATCH", reason: "ORIGIN_NOT_DELEGATED" };
    const resetWait = await resetRefused(target.origin);
    if (resetWait) return resetWait;
    // A generated password is sealed by the Browser Host to the operator's inbox key and joins the delegation at once.
    const inbox = path === "generate-fill" ? await repository.getInbox(owner) : null;
    if (path === "generate-fill" && !inbox) return blocked("INBOX_NOT_READY");
    const epoch = (await repository.getVault(owner))?.epoch;
    if (!epoch) return blocked("NOT_ENROLLED");
    const roles = Array.isArray(body.roles) && body.roles.length ? body.roles as string[] : ["NEW_PASSWORD"];
    const { capability } = await deps.broker.issueUse({ ownerUserId: owner, vaultId: delegation.certificate.claims.vaultId, certificate: delegation.certificate, epoch,
      handle, fields, submit, paneId: pane.id, targetId: target.targetId, pageId: target.targetId, frameId: target.frameId, origin: target.origin,
      ...(inbox ? { generate: { roles, inboxPublicKey: inbox.publicKey } } : {}) });
    const fresh = await freshness(target);
    const rules = withPolicy(target);
    if (!rules) return blocked("POLICY_NEEDS_HOST_RESTART");
    const done = ordered(await guarded(target, fresh, async () => {
      const result = await vaultFill(pane, { mode: path === "totp-fill" ? "TOTP" : path === "generate-fill" ? "GENERATE" : card ? "CARD" : "FILL", capability,
        keyEnvelope: delegation.keyEnvelope, fieldEnvelopes: delegation.fillEnvelopes[handle] ?? {}, ...fresh, ...rules }, traceId);
      if (result.sealedGenerated && (result.status === "FILLED" || result.status === "SUBMITTED")) {
        await repository.addPending(owner, { id: newVaultHandle("vault_pending"), kind: "CHANGE_PASSWORD", handle, label,
          origin: target.origin, sealedUsername: null, sealedPassword: result.sealedGenerated, paneId: pane.id, createdAt: new Date().toISOString(), loginPage: null });
        await handOverPending(repository, owner, handle);
      }
      return { status: result.status, reason: result.reason, itemId: handle, typed: result.typed, document: result.document,
        ...(result.fields && { extra: { fields: result.fields } }) };
    }));
    // A card fills at any merchant: its audit names where.
    return card ? { ...done, origin: target.origin } : done;
  }

  /**
   * The same site and username saved under several Google accounts (Chrome imports): a fill into a pane browser on account X
   * uses X's login when exactly one such login exists (the browser-made login key says it is the same login).
   */
  async function paneAccountLogin(repository: VaultStore, owner: string, pane: Pane, handle: string): Promise<string> {
    const item = await repository.getItem(owner, handle);
    const account = item?.metadata.loginKey && deps.paneAccount ? await deps.paneAccount(owner, pane).catch(() => null) : null;
    if (!item || !account || item.metadata.googleAccountId === account) return handle;
    // Only a login the delegation holds can stand in (an older broker holds at most 200).
    const delegated = new Set((await repository.getActiveDelegation(owner))?.certificate.claims.items.map((entry) => entry.handle));
    const twins = (await repository.itemsByLoginKey(owner, item.metadata.loginKey!)).filter((other) => other.id !== handle && other.googleAccountId === account
      && other.status === "ACTIVE" && other.policy.agentUse && delegated.has(other.id));
    return twins.length === 1 ? twins[0]!.id : handle;
  }

  /**
   * A saved login's login page (nous_msg:cc5aba71): metadata only, so no value is sealed again and the Vault may stay locked; only an
   * address on one of the login's own origins, so where it fills never changes.
   */
  async function setLoginPage(repository: VaultStore, call: VaultAgentCall): Promise<Outcome> {
    const handle = String(call.body.handle);
    const loginPage = (call.body.loginPage as string | null) ?? null;
    const origins = (await repository.getItem(call.owner, handle))?.metadata.origins
      ?? (await repository.listPending(call.owner)).filter((entry) => entry.handle === handle && entry.kind === "NEW_ACCOUNT").map((entry) => entry.origin);
    if (!origins.length) return blocked("ITEM_NOT_FOUND");
    if (loginPage && vaultLoginPageProblem(loginPage, origins)) return blocked("LOGIN_PAGE_OFF_SITE");
    return (await repository.setLoginPage(call.owner, handle, loginPage)) ? { status: "SAVED", reason: null, itemId: handle } : blocked("ITEM_NOT_FOUND");
  }

  /** A login the caller created: sealed at once to the operator's inbox key and fillable at once; the dock files it as an item when it is next unlocked. */
  async function save(repository: VaultStore, call: VaultAgentCall): Promise<Outcome> {
    if (call.body.handle) return setLoginPage(repository, call);
    const vault = await repository.getVault(call.owner);
    const inbox = vault && await repository.getInbox(call.owner);
    if (!vault || !inbox) return blocked("INBOX_NOT_READY");
    const scope = { ownerUserId: call.owner, vaultId: vault.vaultId, keyVersion: 1 };
    const seal = (text: string) => sealToVaultPublicKey(vaultBase64url.decode(inbox.publicKey), new TextEncoder().encode(text), scope);
    const { site, username, password, label, loginPage } = call.body as { site: string; username: string; password?: string; label: string; loginPage?: string | null };
    const handle = newVaultHandle("vault_item");
    await repository.addPending(call.owner, { id: newVaultHandle("vault_pending"), kind: "NEW_ACCOUNT", handle, label,
      origin: vaultAgentSaveSite(site)!, sealedUsername: await seal(username), sealedPassword: password ? await seal(password) : null, paneId: call.paneId, createdAt: new Date().toISOString(), loginPage: loginPage ?? null });
    await handOverPending(repository, call.owner, handle);
    return { status: "SAVED", reason: null, itemId: handle };
  }

  /**
   * An API key the operator pasted for agents (operator request 2026-10-22, plan clipboard:-qvpC_Q0rAVg): this pane takes its
   * value once (the relay writes the file, the agent never sees it) and confirms the write, which deletes the value.
   */
  async function handoff(repository: VaultStore, call: VaultAgentCall): Promise<Outcome> {
    const id = String(call.body.id);
    if (call.path === "key-used") return (await repository.useHandoffKey(call.owner, id, call.paneId)) ? { status: "USED", reason: null } : blocked("KEY_NOT_TAKEN");
    const taken = await repository.takeHandoffKey(call.owner, id, call.paneId);
    if (!taken) return blocked("KEY_UNAVAILABLE");
    try { return { status: "TAKEN", reason: null, extra: { value: deps.crypto.open(taken.valueSealed, connectorSealContext("vault-handoff-key", call.owner, id)) } }; }
    catch { return blocked("KEY_UNREADABLE"); }
  }

  /**
   * Kept keys (operator request 2026-10-26): agents find server, VM and API passwords by label instead of asking the operator,
   * and save the ones that reach them (a mail, the operator, a service); the API seals the value, the answer is the new id.
   */
  async function keptKeys(repository: VaultStore, call: VaultAgentCall): Promise<Outcome> {
    if (call.path === "key-save") {
      const { label, value } = call.body as { label: string; value: string };
      const id = newVaultHandle("vault_key");
      const stored = await repository.addHandoffKey(call.owner, { id, label, valueSealed: deps.crypto.seal(value, connectorSealContext("vault-handoff-key", call.owner, id)),
        expiresAt: null, kept: true, savedBy: call.paneId });
      if (stored) deps.keySaved?.(call.owner, { label, value });
      return stored ? { status: "SAVED", reason: null, extra: { id } } : blocked("KEY_NOT_STORED");
    }
    const words = typeof call.body.q === "string" ? call.body.q.toLowerCase().split(/\s+/) : [];
    const keys = (await repository.listHandoffKeys(call.owner)).filter((key) => key.kept && key.hasValue && words.every((word) => key.label.toLowerCase().includes(word)));
    return { status: "LISTED", reason: null, extra: { keys: keys.map((key) => ({ id: key.id, label: key.label, savedBy: key.savedBy })) } };
  }

  async function outcome(repository: VaultStore, call: VaultAgentCall): Promise<Outcome> {
    const vault = await repository.getVault(call.owner);
    if (call.path === "audit") {
      const limit = typeof call.body.limit === "number" ? call.body.limit : 20;
      // The pane's own attempts, paging the owner's audit 200 at a time (its page) until `limit` are found (until 31/10 only within the newest 200).
      const found: VaultAuditEntry[] = [];
      for (let beforeSeq: number | undefined; found.length < limit; ) {
        const page = await repository.listAudit(call.owner, { limit: 200, ...(beforeSeq ? { beforeSeq } : {}) });
        found.push(...page.filter((entry) => entry.event.paneId === call.paneId));
        if (page.length < 200) break;
        beforeSeq = page.at(-1)!.seq;
      }
      const entries = found.slice(0, limit)
        .map((entry) => ({ at: entry.createdAt, action: entry.event.action, result: entry.event.result, reason: entry.event.reason, itemId: entry.event.itemId }));
      return { status: "LISTED", reason: null, extra: { entries } };
    }
    if (vault?.agentAccess && RETRIES_HAND_OVER.has(call.path)) await joinMissing(repository, call.owner).catch(() => undefined);
    const delegated = vault?.agentAccess ? (await repository.getActiveDelegation(call.owner))?.certificate.claims.items ?? [] : [];
    if (call.path === "status") return { status: "LISTED", reason: null, extra: { agentAccess: vault?.agentAccess ?? false, delegatedItems: delegated.length } };
    if (!vault) return blocked("NOT_ENROLLED");
    if (!vault.agentAccess) return blocked("AGENT_ACCESS_OFF");
    if (call.path === "save") return save(repository, call);
    if (call.path === "key-take" || call.path === "key-used") return handoff(repository, call);
    if (call.path === "key-list" || call.path === "key-save") return keptKeys(repository, call);
    if (call.path === "list") {
      // Saved and generated logins the dock has not filed as items yet are delegated already, under their inbox label.
      const pending = await repository.listPending(call.owner);
      const accounts = new Map((await deps.googleAccounts?.(call.owner).catch(() => []) ?? []).map((account) => [account.id, account.email]));
      const items = [];
      const filter = listFilter(call.body);
      // One read for every item: a delegation holds as many logins as the Vault has.
      const metadata = new Map((await repository.listItems(call.owner)).map((entry) => [entry.id, entry]));
      for (const item of delegated) {
        const stored = metadata.get(item.handle);
        const label = stored ? stored.status === "ACTIVE" && stored.policy.agentUse ? stored.label : null
          : pending.find((entry) => entry.handle === item.handle)?.label ?? null;
        const account = stored?.googleAccountId ? accounts.get(stored.googleAccountId) : undefined;
        if (filter.account && account?.toLowerCase() !== filter.account) continue;
        // A card has no site: it is listed for any site.
        if (filter.host && stored?.card == null && !vaultOriginCovers(item.origins, `https://${filter.host}`) && !item.origins.some((origin) => { const host = new URL(origin).hostname; return host === filter.host || host.endsWith(`.${filter.host}`); })) continue;
        const loginPage = stored ? stored.loginPage : pending.find((entry) => entry.handle === item.handle)?.loginPage;
        if (label) items.push({ handle: item.handle, label, origins: item.origins, fields: item.fields, ...(stored?.card ? { card: `${stored.card.brand} ••${stored.card.last4}` } : {}),
          ...(account ? { account } : {}), ...(loginPage ? { loginPage } : {}) });
      }
      return { status: "LISTED", reason: null, extra: { items } };
    }
    return fill(repository, call);
  }

  return {
    /** One audited agent or Nous call; the answer is the fixed agent shape for its path. */
    async call(call: VaultAgentCall): Promise<Record<string, unknown>> {
      const repository = deps.repository;
      if (!repository) return vaultAgentResultSchema.parse({ status: "BLOCKED", auditId: null });
      const result = await outcome(repository, call).catch((): Outcome => blocked("FILL_FAILED"));
      const audited = await repository.appendAudit(call.owner, { actor: "AGENT", action: actions[call.path], result: result.status, reason: result.reason,
        itemId: result.itemId ?? (typeof call.body.handle === "string" ? call.body.handle : null), paneId: call.paneId, origin: result.origin ?? null });
      const answer = { status: result.status, auditId: audited?.id ?? null, ...result.extra };
      // The one answer that carries a value: the relay writes it into the file and never shows it to the agent.
      if (call.path === "key-take" && result.status === "TAKEN") return vaultAgentKeyTakeResultSchema.parse({ ...answer, reason: null });
      if (call.path === "key-save" && result.status === "SAVED") return vaultAgentKeySaveResultSchema.parse({ ...answer, reason: null });
      if (call.path === "key-list" && result.status === "LISTED") return vaultAgentKeyListResultSchema.parse(answer);
      // The audit's short code goes with the status (2026-10-22), so a fill answer can be acted on (FIELD_NOT_FOUND_AFTER_RELOAD).
      if (result.status !== "LISTED") return vaultAgentResultSchema.parse({ ...answer, reason: result.reason ?? null });
      return (call.path === "status" ? vaultAgentStatusResultSchema : call.path === "audit" ? vaultAgentAuditResultSchema : vaultAgentListResultSchema).parse(answer);
    }
  };
}
export type VaultAgent = ReturnType<typeof createVaultAgent>;

/** space_vault_list's filters: the site's host (an address or a bare host name) and the account address, lower-case. */
function listFilter(body: Record<string, unknown>): { host: string | null; account: string | null } {
  const site = typeof body.site === "string" ? body.site.trim() : "";
  let host: string | null = null;
  if (site) { try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(site) ? site : `https://${site}`).hostname.toLowerCase(); } catch { host = site.toLowerCase(); } }
  return { host, account: typeof body.account === "string" ? body.account.trim().toLowerCase() : null };
}

export interface VaultAgentRouteDependencies {
  agent: VaultAgent;
  /** The verified bridge's pane owner (the pane's explicit owner, else the room's); null when the pane has none. */
  requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<{ owner: string | null; paneId: string; roomId: string; viewer?: string } | null>;
  routeOptions: Record<string, unknown>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
}

const agentSchemas: Record<VaultAgentPath, z.ZodTypeAny> = {
  status: vaultAgentEmptyRequestSchema, list: vaultAgentListRequestSchema, audit: vaultAgentAuditRequestSchema, fill: vaultAgentFillRequestSchema, "card-fill": vaultAgentCardFillRequestSchema,
  "totp-fill": vaultAgentTotpRequestSchema, "generate-fill": vaultAgentGenerateRequestSchema, save: vaultAgentSaveRequestSchema,
  "key-take": vaultAgentKeyRequestSchema, "key-used": vaultAgentKeyRequestSchema, "key-list": vaultAgentKeyListRequestSchema, "key-save": vaultAgentKeySaveRequestSchema
};

/** Every agent call is validated and audited; a pane without an owner has no Vault to use. */
export function registerVaultAgentRoutes(app: FastifyInstance, deps: VaultAgentRouteDependencies): void {
  for (const [path, schema] of Object.entries(agentSchemas) as Array<[VaultAgentPath, z.ZodTypeAny]>) {
    app.post(`${cliVaultPathPrefix}${path}`, deps.routeOptions, async (request, reply) => {
      const context = await deps.requireOwner(request, reply);
      if (!context) return reply;
      const body = deps.parseBody(schema, request.body ?? {}) as Record<string, unknown>;
      if (!context.owner) return vaultAgentResultSchema.parse({ status: "BLOCKED", auditId: null });
      return deps.agent.call({ owner: context.owner, paneId: context.paneId, roomId: context.roomId, path, body, traceId: request.requestIdForSpace ?? "", viewer: context.viewer });
    });
  }
}
