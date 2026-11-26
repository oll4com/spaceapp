import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { LINK_APP, nousSuperiorRequestSchema, signNousSuperior, verifyNousSuperior, vaultBase64url, type NousSuperiorStatement } from "@space/contracts";
import type { AppDeviceSessionRecord, AppDeviceSessionRepository } from "@space/db";
import type { SpaceStore } from "@space/runtime";
import { sendApiError } from "../http-errors.js";
import { recordAudit } from "../request-audit.js";

// Nous hierarchy (Space Link v2, ADR-014 v2, plan clipboard:zqVWdClsx_pA step 9): a SpaceApp whose link holds nous names its Nous this Nous's
// superior, signed by its identity key, with the chain of Nous above it. One superior per SpaceApp (the grant refuses a second); a chain that
// reaches back to this SpaceApp is a cycle: refused, and that link loses nous.

/** The live link whose Nous this Nous answers to, or null. */
export const superiorOf = (rows: AppDeviceSessionRecord[], nowIso: string) =>
  rows.find((row) => row.app === LINK_APP && !row.revokedAt && row.expiresAt > nowIso && row.scopes?.includes("nous") && row.nousSuperior) ?? null;
/** The identity keys above this Nous, nearest first. */
export const chainOf = (row: AppDeviceSessionRecord | null) => row?.nousSuperior ? [row.nousSuperior.identityPublic, ...row.nousSuperior.chain] : [];

/** B's side: the route a link's Nous names itself superior on. */
export function registerNousSuperior(app: FastifyInstance, options: { store: Pick<SpaceStore, "recordAuditEvent" | "upsertUser">; devices: AppDeviceSessionRepository;
  routeOptions: Pick<RouteShorthandOptions, "config">; ownIdentity: () => Promise<string | null>; now?: () => number }) {
  app.post("/api/nous/link/superior", options.routeOptions, async (request, reply) => {
    const device = request.mobileDevice;
    if (!request.user || request.appSession !== LINK_APP || !device) return sendApiError(reply, 403, "NOUS_SUPERIOR_LINK_ONLY", "Only a linked SpaceApp's Nous names itself superior here.");
    const input = nousSuperiorRequestSchema.safeParse(request.body);
    if (!input.success) return sendApiError(reply, 400, "INVALID_REQUEST", "The body is {statement, signature}.");
    const { statement, signature } = input.data;
    const own = await options.ownIdentity();
    if (!own || statement.to !== own || statement.device !== device.id || !verifyNousSuperior(statement, signature)) {
      return sendApiError(reply, 403, "NOUS_SUPERIOR_SIGNATURE", "The statement is not signed for this SpaceApp and this link.");
    }
    const at = new Date(options.now?.() ?? Date.now()).toISOString();
    const row = (await options.devices.list(request.user.id)).find((entry) => entry.id === device.id);
    // A cycle answers as one even after nous left (the other side's open session learns its scopes within 10 s).
    if (row && (statement.identity === own || statement.chain.includes(own))) {
      if (row.scopes?.includes("nous")) await options.devices.setLinkScopes(request.user.id, row.id, row.scopes.filter((scope) => scope !== "nous"), at);
      await recordAudit(options.store, request, { action: "nous.link.cycle_refused", targetType: "app_device_session", targetId: row.id,
        metadata: { identity: statement.identity, label: statement.label, host: statement.host, chain: statement.chain.length } });
      return sendApiError(reply, 409, "NOUS_LINK_CYCLE", "This SpaceApp's Nous is already above that Nous; a Nous cannot answer to itself. The link keeps manage without nous.");
    }
    if (!row?.scopes?.includes("nous")) return sendApiError(reply, 403, "MOBILE_SCOPE_DENIED", "This link does not hold nous here.");
    const same = row.nousSuperior?.identityPublic === statement.identity;
    const saved = await options.devices.setNousSuperior(row.id, { identityPublic: statement.identity, label: statement.label, host: statement.host,
      chain: statement.chain, since: same ? row.nousSuperior!.since : at, at });
    if (!saved) return sendApiError(reply, 403, "MOBILE_SCOPE_DENIED", "This link does not hold nous here.");
    if (!same) await recordAudit(options.store, request, { action: "nous.link.superior_set", targetType: "app_device_session", targetId: row.id,
      metadata: { identity: statement.identity, label: statement.label, host: statement.host, chain: statement.chain.length } });
    return { superior: saved.nousSuperior };
  });
}

/** A's side: the signed statement it sends a link whose grant holds nous. */
export function nousStatement(identity: { privateKey: Uint8Array; publicKey: Uint8Array }, to: string, device: string, label: string, host: string, chain: string[]) {
  const statement: NousSuperiorStatement = { v: 1, to, device, identity: vaultBase64url.encode(identity.publicKey), label, host, chain };
  return { statement, signature: signNousSuperior(statement, identity.privateKey) };
}
