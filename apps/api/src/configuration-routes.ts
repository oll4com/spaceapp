import type {} from "./request-context.js";
import { isAbsolute } from "node:path";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { CONFIG_REPLACE_UNCONFIRMED, ConfigSecretsError, prepareConfigImport, type SpaceStore } from "@space/runtime";
import {
  exportConfigOptionsSchema,
  importConfigOptionsSchema,
  parseConfigBundleLeniently,
  type AgentRuntime,
  type CliToggleRuntimeId,
  type SpaceConfigBundle
} from "@space/contracts";
import { sendApiError } from "./http-errors.js";
import type { AuditRecorder } from "./request-audit.js";
import { createCliAuthTransfer, type CredentialHost } from "./cli-auth-transfer.js";
import type { SpaceApiConfig } from "./config.js";

const passphraseFailureWindowMs = 10 * 60_000;

/** A backup from a newer SpaceApp can hold settings and entries this version does not know. */
function skippedWarning(skipped: string[]): string[] {
  return skipped.length
    ? [`Skipped what this SpaceApp version does not recognize (the backup may come from a newer version): ${skipped.join(", ")}.`]
    : [];
}
const passphraseFailureLimit = 5;

/** Parent authentication and CSRF hooks run before these domain authorization checks. */
export function registerConfigurationRoutes(app: FastifyInstance, options: {
  store: Pick<SpaceStore, "exportConfigurationBundle" | "importConfigurationBundle" | "getCliAccountProfile">;
  config: Pick<SpaceApiConfig, "publicDistribution">;
  runtimes: { read(): Promise<{ data: AgentRuntime[] }>; invalidate(): void };
  credentialHost: CredentialHost | null;
  routeOptions: { config: NonNullable<RouteShorthandOptions["config"]> };
  recordAudit: AuditRecorder;
}) {
  const { store, routeOptions: defaultRouteRateLimitOptions, recordAudit } = options;
  const readRuntimes = async () => (await options.runtimes.read()).data;
  const cliAuth = createCliAuthTransfer({
    publicDistribution: Boolean(options.config.publicDistribution),
    readRuntimes,
    invalidateRuntimes: () => options.runtimes.invalidate(),
    warn: (message) => app.log.warn(message),
    credentialHost: options.credentialHost
  });
  app.addHook("onClose", async () => { await options.credentialHost?.close(); });
  const configurationRouteRateLimitOptions = {
    ...defaultRouteRateLimitOptions,
    bodyLimit: 50 * 1024 * 1024
  };
  const passphraseFailures = new Map<string, number[]>();
  const recentFailures = (userId: string) =>
    (passphraseFailures.get(userId) ?? []).filter((at) => Date.now() - at < passphraseFailureWindowMs);

  /** What this host lacks for the bundle: folders, installed CLIs, account profiles, reachable providers. */
  async function hostCheck(bundle: SpaceConfigBundle, pathRewrite?: { from: string; to: string }) {
    const prepared = await prepareConfigImport(bundle, { pathRewrite }, {
      profileExists: async (runtimeId, profileId) => {
        try { return Boolean(await store.getCliAccountProfile(runtimeId as CliToggleRuntimeId, profileId)); } catch { return false; }
      }
    });
    return { warnings: [...prepared.warnings, ...await missingRuntimeWarnings(bundle)], missingProjectRoots: prepared.missingProjectRoots };
  }

  async function missingRuntimeWarnings(bundle: SpaceConfigBundle): Promise<string[]> {
    const runtimes = await readRuntimes().catch(() => null);
    if (!runtimes) return [];
    const missing = bundle.data.cliRuntimeSettings
      .filter((setting) => setting.enabled && !runtimes.some((runtime) => runtime.id === setting.runtimeId && runtime.detectedCommandPath))
      .map((setting) => setting.runtimeId.replace(/^cli:/, ""));
    return missing.length
      ? [`Enabled in the backup but not installed on this host: ${missing.join(", ")}. Their panes cannot start until they are installed.`]
      : [];
  }

  app.get("/api/configuration/export", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    const bundle = await store.exportConfigurationBundle({
      userId: request.user.id
    });
    const filename = `spaceapp-config-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    reply.header("Content-Type", "application/json; charset=utf-8");
    return bundle;
  });

  app.post("/api/configuration/export", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    const input = exportConfigOptionsSchema.parse(request.body ?? {});
    const isAdmin = request.user.role === "ADMIN" || request.user.role === "OPERATOR";
    if (!isAdmin && (input.includeApiKeys || input.includeCredentials)) {
      return sendApiError(reply, 403, "CONFIGURATION_PRIVILEGED_ACCESS_REQUIRED", "Exporting installation secrets requires ADMIN or OPERATOR access.");
    }
    if ((input.includeApiKeys || input.includeCredentials) && !input.passphrase) {
      return sendApiError(reply, 400, "CONFIGURATION_PASSPHRASE_REQUIRED", "A passphrase of at least 12 characters is required to export API keys or CLI logins.");
    }
    const userId = (isAdmin && input.userId) ? input.userId : request.user.id;
    let captured = {};
    let skipped: Array<{ runtimeId: string; reason: string }> = [];
    if (input.includeCredentials) {
      const runtimeIds = input.cliAuthRuntimes
        ?? (await cliAuth.list()).filter((login) => login.exportable && login.loggedIn).map((login) => login.runtimeId);
      ({ captured, skipped } = await cliAuth.capture(runtimeIds));
    }
    const bundle = await store.exportConfigurationBundle({ ...input, userId }, { cliAuth: captured });
    if (bundle.encrypted) {
      await recordAudit(request, {
        action: "configuration.export_secrets",
        targetType: "configuration",
        targetId: request.user.id,
        metadata: { apiKeys: bundle.sections?.apiKeys?.names ?? [], cliAuthRuntimes: bundle.sections?.cliAuth?.runtimes ?? [], skipped }
      });
    }
    return bundle;
  });

  app.get("/api/configuration/cli-logins", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    if (request.user.role !== "ADMIN" && request.user.role !== "OPERATOR") {
      return sendApiError(reply, 403, "CONFIGURATION_PRIVILEGED_ACCESS_REQUIRED", "CLI logins require ADMIN or OPERATOR access.");
    }
    return { items: await cliAuth.list() };
  });

  app.post("/api/configuration/inspect", { ...configurationRouteRateLimitOptions, config: { rateLimit: defaultRouteRateLimitOptions.config.rateLimit } }, async (request, reply) => {
    if (!request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    const rawBundle = (request.body && typeof request.body === "object" && "bundle" in (request.body as Record<string, unknown>))
      ? (request.body as Record<string, unknown>).bundle
      : request.body;
    const parsed = parseConfigBundleLeniently(rawBundle);
    if (!parsed.success) {
      return reply.status(400).send({
        valid: false,
        error: "Invalid configuration bundle structure.",
        issues: parsed.error.issues
      });
    }
    const b = parsed.bundle;
    const isAdmin = request.user.role === "ADMIN" || request.user.role === "OPERATOR";
    const host = isAdmin ? await hostCheck(b) : { warnings: [], missingProjectRoots: [] };
    host.warnings.unshift(...skippedWarning(parsed.skipped));
    return {
      valid: true,
      version: b.version,
      exportedAt: b.exportedAt,
      source: b.source,
      summary: {
        roomsCount: b.metadata.roomsCount,
        panesCount: b.metadata.panesCount,
        hasUserSettings: Boolean(b.data.userSettings),
        userLinksCount: b.metadata.userLinksCount,
        clipboardItemsCount: b.metadata.clipboardItemsCount,
        taskItemsCount: b.metadata.taskItemsCount,
        cliRuntimeSettingsCount: b.metadata.cliRuntimesCount,
        hasCodexCliModeDefaults: Boolean(b.data.codexCliModeDefaults),
        providersCount: b.metadata.providersCount,
        apiKeysCount: b.metadata.apiKeysCount ?? (b.data.apiKeys ? Object.keys(b.data.apiKeys).length : 0),
        credentialsCount: b.metadata.credentialsCount ?? 0
      },
      secrets: {
        encrypted: Boolean(b.encrypted),
        // A 1.0.0 bundle carries its API keys in plaintext.
        plaintextApiKeys: !b.encrypted && Boolean(b.data.apiKeys && Object.keys(b.data.apiKeys).length),
        cliAuthRuntimes: b.sections?.cliAuth?.runtimes ?? []
      },
      ...host,
      rooms: b.data.rooms.map((r) => ({
        id: r.id,
        name: r.name,
        order: r.order,
        panesCount: r.panes?.length || 0
      }))
    };
  });

  app.post("/api/configuration/import", { ...configurationRouteRateLimitOptions, config: { rateLimit: defaultRouteRateLimitOptions.config.rateLimit } }, async (request, reply) => {
    if (!request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    const isAdmin = request.user.role === "ADMIN" || request.user.role === "OPERATOR";
    // A bundle can replace installation-wide runtimes/providers and write credentials.
    // Scoping targetUserId alone cannot make an import safe for a regular USER.
    if (!isAdmin) {
      return sendApiError(reply, 403, "CONFIGURATION_PRIVILEGED_ACCESS_REQUIRED", "Importing installation configuration requires ADMIN or OPERATOR access.");
    }
    const { bundle: rawBundle, ...options } = (request.body ?? {}) as Record<string, unknown>;
    const parsedBundle = parseConfigBundleLeniently(rawBundle);
    if (!parsedBundle.success) {
      return sendApiError(reply, 422, "VALIDATION_ERROR", "Invalid configuration bundle structure.", parsedBundle.error.issues);
    }
    const input = { ...importConfigOptionsSchema.parse(options), bundle: parsedBundle.bundle };
    if (input.pathRewrite && (!isAbsolute(input.pathRewrite.from) || !isAbsolute(input.pathRewrite.to))) {
      return sendApiError(reply, 400, "CONFIGURATION_PATH_INVALID", "Project folders must be absolute paths.");
    }
    if (input.mode === "replace" && input.confirmReplace !== true) {
      return sendApiError(reply, 400, "CONFIGURATION_REPLACE_UNCONFIRMED", CONFIG_REPLACE_UNCONFIRMED);
    }
    if (input.passphrase && recentFailures(request.user.id).length >= passphraseFailureLimit) {
      return sendApiError(reply, 429, "CONFIGURATION_PASSPHRASE_LOCKED", "Too many wrong passphrases. Try again in 10 minutes.");
    }
    const targetUserId = (isAdmin && input.targetUserId) ? input.targetUserId : request.user.id;
    let result;
    try {
      result = await store.importConfigurationBundle(input.bundle, {
        mode: input.mode,
        confirmReplace: input.confirmReplace,
        targetUserId,
        pathRewrite: input.pathRewrite,
        sections: input.sections,
        importApiKeys: input.importApiKeys,
        importCredentials: input.importCredentials,
        passphrase: input.passphrase
      }, {
        applyCliAuth: (logins) => cliAuth.apply(logins, { runtimeIds: input.cliAuthRuntimes, conflict: input.cliAuthConflict })
      });
    } catch (error) {
      if (error instanceof ConfigSecretsError) {
        passphraseFailures.set(request.user.id, [...recentFailures(request.user.id), Date.now()]);
        return sendApiError(reply, 400, error.code, error.message);
      }
      throw error;
    }
    result.warnings.unshift(...skippedWarning(parsedBundle.skipped));
    result.warnings.push(...await missingRuntimeWarnings(input.bundle));
    await recordAudit(request, {
      action: "configuration.import",
      targetType: "configuration",
      targetId: request.user.id,
      metadata: {
        mode: result.mode,
        stats: result.stats,
        cliAuth: result.cliAuth?.map(({ runtimeId, result: outcome, reason }) => ({ runtimeId, result: outcome, reason })) ?? []
      }
    });
    return result;
  });

}
