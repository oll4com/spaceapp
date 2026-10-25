import type {} from "./request-context.js";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  cliAccountIdentitiesResponseSchema, cliAccountProfileDetailsResponseSchema, cliAccountProfileIdSchema,
  cliLoginRequestSchema, type CliLoginResponse, createCliAccountProfileInputSchema,
  createCliAccountProfileResponseSchema, listCliAccountProfilesResponseSchema, removeCliAccountProfileResponseSchema,
  updateCliAccountProfileInputSchema, updateCliAccountProfileResponseSchema
} from "@space/contracts";
import { nowIso, SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { type CliAccountProfileRuntimeId, isCliAccountProfileRuntimeId } from "./cli-account-profile-runtimes.js";
import { cliAccountProfileRuntimeIds } from "./cli-runtime-descriptors.js";
import { cliRuntimeSettingParamSchema } from "./cli-runtime-params.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import { sendApiError } from "./http-errors.js";
import type { GatewayCliAccounts } from "./gateway/gateway-cli-accounts.js";
import { type CliAccountBalancer, isCliBalancedRuntimeId } from "./cli-account-balancer.js";
import { recordAudit } from "./request-audit.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";

/**
 * CLI account profiles (list, create, rename, identities, details, delete) and the room CLI login; the parent
 * retains authentication, CSRF, errors and rate limits.
 */
export function registerCliAccountRoutes(app: FastifyInstance, options: {
  removeGeminiAccountProfileState: (profileId: string) => Promise<void>;
  removeClaudeAccountProfileState: (profileId: string) => Promise<void>;
  removeCopilotAccountProfileState: (profileId: string) => Promise<void>;
  removeCursorAccountProfileState: (profileId: string) => Promise<void>;
  removeKimiAccountProfileState?: (profileId: string) => Promise<void>;
  deletingCliAccountProfileKeys: Set<string>;
  cliAccountProfileKey: (runtimeId: string, profileId: string) => string;
  readCliAccountProfileDetails: (runtimeId: CliAccountProfileRuntimeId, profileId: string) => Promise<{ authStatus: "CONNECTED" | "NOT_CONNECTED" | "UNAVAILABLE"; email: string | null; }>;
  cliAccountIdentityCacheTtlMs: 30000;
  cliAccountIdentityCache: Map<string, { expiresAt: number; value: Promise<{ authStatus: "CONNECTED" | "NOT_CONNECTED" | "UNAVAILABLE"; email: string | null; login?: string | null; }>; }>;
  readCachedCliAccountIdentity: (runtimeId: CliAccountProfileRuntimeId, profileId: string) => Promise<{ authStatus: "CONNECTED" | "NOT_CONNECTED" | "UNAVAILABLE"; email: string | null; } | { authStatus: "UNAVAILABLE"; email: null; }>;
  invalidateCliAccountIdentity: (runtimeId: string, profileId: string) => void;
  store: SpaceStore;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  openCliLogin: (request: FastifyRequest, roomId: string, runtimeId: string) => Promise<CliLoginResponse>;
  gatewayCliAccounts?: Pick<GatewayCliAccounts, "gatewayProfile">;
  cliAccountBalancer?: Pick<CliAccountBalancer, "balance">;
}) {
  const { removeGeminiAccountProfileState, removeClaudeAccountProfileState, removeCopilotAccountProfileState,
    removeCursorAccountProfileState, deletingCliAccountProfileKeys, cliAccountProfileKey,
    readCliAccountProfileDetails, cliAccountIdentityCacheTtlMs, cliAccountIdentityCache,
    readCachedCliAccountIdentity, invalidateCliAccountIdentity, store, cliRuntimeVisibility,
    routeOptions: defaultRouteRateLimitOptions, openCliLogin, gatewayCliAccounts, cliAccountBalancer, removeKimiAccountProfileState } = options;
  const cliAccountProfileParamSchema = z.object({
    runtimeId: z.enum(cliAccountProfileRuntimeIds),
    profileId: cliAccountProfileIdSchema.optional()
  });
  app.get("/api/cli/runtimes/:runtimeId/account-profiles", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI account profiles require the ADMIN role.");
    }
    const params = parseQuery(cliRuntimeSettingParamSchema, request.params);
    if (!isCliAccountProfileRuntimeId(params.runtimeId)) {
      throw new SpaceConflictError(`CLI runtime ${params.runtimeId} does not support account profiles.`);
    }
    await cliRuntimeVisibility.assertEnabled(params.runtimeId);
    const [profiles, gatewayProfile] = await Promise.all([
      store.listCliAccountProfiles(params.runtimeId),
      gatewayCliAccounts?.gatewayProfile(params.runtimeId) ?? null
    ]);
    return listCliAccountProfilesResponseSchema.parse({ profiles, gatewayProfile });
  });
  // Session-level balancing: each account's remaining quota, and the account a pane on Auto starts on now.
  app.get("/api/cli/runtimes/:runtimeId/account-balance", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI account profiles require the ADMIN role.");
    }
    const params = parseQuery(cliRuntimeSettingParamSchema, request.params);
    if (!cliAccountBalancer || !isCliBalancedRuntimeId(params.runtimeId)) {
      throw new SpaceConflictError(`CLI runtime ${params.runtimeId} does not balance accounts.`);
    }
    await cliRuntimeVisibility.assertEnabled(params.runtimeId);
    return cliAccountBalancer.balance(params.runtimeId);
  });
  app.post("/api/cli/runtimes/:runtimeId/account-profiles", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI account profiles require the ADMIN role.");
    }
    const params = parseQuery(cliRuntimeSettingParamSchema, request.params);
    if (!isCliAccountProfileRuntimeId(params.runtimeId)) {
      throw new SpaceConflictError(`CLI runtime ${params.runtimeId} does not support account profiles.`);
    }
    const input = parseBody(createCliAccountProfileInputSchema, request.body ?? {});
    if (input.runtimeId !== params.runtimeId) {
      throw new SpaceConflictError("Account profile runtime must match the route runtime.");
    }
    if (deletingCliAccountProfileKeys.has(cliAccountProfileKey(input.runtimeId, input.profileId))) {
      throw new SpaceConflictError(`Account profile ${input.profileId} is being removed.`);
    }
    const profile = await store.createCliAccountProfile(
      params.runtimeId,
      input,
      request.user?.id ?? "operator:unknown"
    );
    invalidateCliAccountIdentity(params.runtimeId, profile.profileId);
    await recordAudit(store, request, {
      action: "cli.runtime.account_profile.created",
      targetType: "cli_runtime",
      targetId: params.runtimeId,
      metadata: { profileId: profile.profileId }
    });
    return createCliAccountProfileResponseSchema.parse({ profile });
  });
  app.patch("/api/cli/runtimes/:runtimeId/account-profiles/:profileId", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI account profiles require the ADMIN role.");
    }
    const params = parseQuery(cliAccountProfileParamSchema, request.params);
    if (!isCliAccountProfileRuntimeId(params.runtimeId) || !params.profileId) {
      throw new SpaceConflictError("A supported CLI account profile is required.");
    }
    const existing = await store.getCliAccountProfile(params.runtimeId, params.profileId);
    if (!existing) {
      throw new SpaceNotFoundError(`CLI account profile ${params.runtimeId}/${params.profileId} was not found.`);
    }
    const input = parseBody(updateCliAccountProfileInputSchema, request.body ?? {});
    const profile = await store.createCliAccountProfile(
      params.runtimeId,
      { runtimeId: params.runtimeId, profileId: params.profileId, displayName: input.displayName },
      request.user?.id ?? "operator:unknown"
    );
    invalidateCliAccountIdentity(params.runtimeId, profile.profileId);
    await recordAudit(store, request, {
      action: "cli.runtime.account_profile.renamed",
      targetType: "cli_runtime",
      targetId: params.runtimeId,
      metadata: { profileId: profile.profileId }
    });
    return updateCliAccountProfileResponseSchema.parse({ profile });
  });
  app.get("/api/cli/account-identities", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI account profiles require the ADMIN role.");
    }
    const runtimes = await Promise.all(cliAccountProfileRuntimeIds.map(async (runtimeId) => ({
      runtimeId,
      enabled: await cliRuntimeVisibility.isEnabled(runtimeId)
    })));
    const query = parseQuery(z.object({ refresh: z.enum(["0", "1"]).optional() }), request.query ?? {});
    const profiles = (await Promise.all(runtimes
      .filter((runtime) => runtime.enabled)
      .map(async ({ runtimeId }) => store.listCliAccountProfiles(runtimeId)))).flat()
      .filter((profile): profile is typeof profile & { runtimeId: CliAccountProfileRuntimeId } => isCliAccountProfileRuntimeId(profile.runtimeId));
    if (query.refresh === "1") {
      for (const profile of profiles) invalidateCliAccountIdentity(profile.runtimeId, profile.profileId);
    }
    // At most a few native probes at once; cached identities resolve immediately.
    const accounts: Array<{ runtimeId: CliAccountProfileRuntimeId; profileId: string; displayName: string; authStatus: "CONNECTED" | "NOT_CONNECTED" | "UNAVAILABLE"; email: string | null; login?: string | null }> = new Array(profiles.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(6, profiles.length) }, async () => {
      while (nextIndex < profiles.length) {
        const index = nextIndex++;
        const profile = profiles[index]!;
        accounts[index] = {
          runtimeId: profile.runtimeId,
          profileId: profile.profileId,
          displayName: profile.displayName,
          ...await readCachedCliAccountIdentity(profile.runtimeId, profile.profileId)
        };
      }
    }));
    return cliAccountIdentitiesResponseSchema.parse({ accounts, checkedAt: nowIso() });
  });
  app.get("/api/cli/runtimes/:runtimeId/account-profiles/:profileId/details", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI account profiles require the ADMIN role.");
    }
    const params = parseQuery(cliAccountProfileParamSchema, request.params);
    if (!isCliAccountProfileRuntimeId(params.runtimeId) || !params.profileId) {
      throw new SpaceConflictError("A supported CLI account profile is required.");
    }
    const profile = await store.getCliAccountProfile(params.runtimeId, params.profileId);
    if (!profile) {
      throw new SpaceNotFoundError(`CLI account profile ${params.runtimeId}/${params.profileId} was not found.`);
    }
    const nativeDetails = await readCliAccountProfileDetails(params.runtimeId, params.profileId);
    cliAccountIdentityCache.set(cliAccountProfileKey(params.runtimeId, params.profileId), {
      expiresAt: Date.now() + cliAccountIdentityCacheTtlMs,
      value: Promise.resolve(nativeDetails)
    });
    return cliAccountProfileDetailsResponseSchema.parse({
      details: {
        runtimeId: params.runtimeId,
        profileId: params.profileId,
        displayName: profile.displayName,
        ...nativeDetails
      }
    });
  });
  app.delete("/api/cli/runtimes/:runtimeId/account-profiles/:profileId", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI account profiles require the ADMIN role.");
    }
    const params = parseQuery(cliAccountProfileParamSchema, request.params);
    if (!isCliAccountProfileRuntimeId(params.runtimeId)) {
      throw new SpaceConflictError(`CLI runtime ${params.runtimeId} does not support account profiles.`);
    }
    if (!params.profileId) {
      throw new SpaceConflictError("A profileId is required to remove an account profile.");
    }
    if (params.profileId === "main") {
      throw new SpaceConflictError("The main CLI account profile cannot be removed.");
    }
    if (deletingCliAccountProfileKeys.has(cliAccountProfileKey(params.runtimeId, params.profileId))) {
      throw new SpaceConflictError(`Account profile ${params.profileId} is already being removed.`);
    }
    deletingCliAccountProfileKeys.add(cliAccountProfileKey(params.runtimeId, params.profileId));
    try {
      if (await store.isCliAccountProfileInUse(params.runtimeId, params.profileId)) {
        throw new SpaceConflictError(`Account profile ${params.profileId} is in use by an active CLI pane.`);
      }
      const profile = await store.getCliAccountProfile(params.runtimeId, params.profileId);
      if (!profile) {
        throw new SpaceNotFoundError(`CLI account profile ${params.runtimeId}/${params.profileId} was not found.`);
      }
      if (params.runtimeId === "cli:gemini") await removeGeminiAccountProfileState(params.profileId);
      else if (params.runtimeId === "cli:claude") await removeClaudeAccountProfileState(params.profileId);
      else if (params.runtimeId === "cli:copilot") await removeCopilotAccountProfileState(params.profileId);
      else if (params.runtimeId === "cli:kimi") await removeKimiAccountProfileState?.(params.profileId);
      else await removeCursorAccountProfileState(params.profileId);
      const removed = await store.removeCliAccountProfile(params.runtimeId, params.profileId);
      if (!removed) {
        throw new SpaceNotFoundError(`CLI account profile ${params.runtimeId}/${params.profileId} was not found.`);
      }
      invalidateCliAccountIdentity(params.runtimeId, params.profileId);
      await recordAudit(store, request, {
        action: "cli.runtime.account_profile.removed",
        targetType: "cli_runtime",
        targetId: params.runtimeId,
        metadata: { profileId: params.profileId }
      });
      return removeCliAccountProfileResponseSchema.parse({ removed });
    } finally {
      deletingCliAccountProfileKeys.delete(cliAccountProfileKey(params.runtimeId, params.profileId));
    }
  });
  app.post("/api/rooms/:id/cli-login", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(cliLoginRequestSchema, request.body ?? {});
    return openCliLogin(request, params.id, input.runtimeId);
  });
}
