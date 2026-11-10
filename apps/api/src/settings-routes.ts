import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { updateProviderSettingsInputSchema, updateUserSettingsInputSchema } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import { sendApiError } from "./http-errors.js";
import { recordAudit } from "./request-audit.js";
import { registerHistoryPeriod } from "./history-period-routes.js";
import { parseBody } from "./route-parsing.js";

// uiLanguage (operator 1/11 23:09 BKK: «needs you … στην γλώσσα που εχω ορισει»): how Space reads to him, set for him on his order like the theme.
const agentAppearanceSettings = new Set(["uiTheme", "modernAppearance", "modernIconPack", "uiBackground", "liquidGlassTint", "roomTheme", "uiZoom", "sensitiveDataMasked", "uiLanguage", "agentLanguage"]);
const agentRefusedSettings = new Set(["nous", "notifications", "suppressNotifications", "livePane", "voice", "promptVariables", "promptVariablesEnabled",
  "promptVariablesAutoExpandOnSubmit", "history", "workspaceQuickActions", "projectPresets", "worktreeDefaultEnabled", "roomWorktreeOverrides",
  "jobCopilot", "mailCopilot", "marketingCopilot", "freelanceCopilot", "design", "appStudio", "video", "securityCopilot", "monitoringCopilot"]);

/** Provider settings and per-user settings; the parent retains authentication, CSRF, errors and rate limits. */
export function registerSettingsRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  // The History period setting (history.periodDays) bounds every history route's answer (plan clipboard:8riKjb1krKyL). Registered here,
  // after the session and the mobile gate in app.ts, so a phone's query is checked before a floor is added to it.
  registerHistoryPeriod(app, async (request) => options.store.getUserSettings((await options.store.upsertUser(request.user!)).id));
  const { store, cliRuntimeVisibility, routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/provider-settings", defaultRouteRateLimitOptions, async () => store.getProviderSettings());
  app.patch("/api/provider-settings", defaultRouteRateLimitOptions, async (request) => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    const input = parseBody(updateProviderSettingsInputSchema, request.body);
    const settings = await store.updateProviderSettings(input);
    await recordAudit(store, request, {
      action: "provider_settings.update",
      targetType: "provider_settings",
      targetId: "global",
      metadata: {
        defaultProviderId: settings.defaultProviderId,
        titleGenerationModelId: settings.titleGenerationModelId
      }
    });
    return settings;
  });
  const getUserSettingsHandler = async (request: any, reply: any) => {
    if (!request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    const settings = await store.getUserSettings(request.user.id);
    // Proofs and captures read the UI in English whatever the operator chose (plan clipboard:32etNsBgtbI- step 3): their fixed steps find
    // controls by their English names. An admin action drives no UI, so it reads the operator's real choice.
    const browser = request.user.proofScope || request.user.automationScope || (request.user.brokerScope && !request.user.brokerScope.startsWith("ADMIN_ACTION:"));
    return browser ? { ...settings, uiLanguage: "en" } : settings;
  };
  const patchUserSettingsHandler = async (request: any, reply: any) => {
    if (!request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    const input = parseBody(updateUserSettingsInputSchema, request.body);
    // An agent's session (hardening steps 5 and 19): an admin action changes only appearance; a proof drives the rest of the
    // UI but never what silences the operator, steers their assistants, copilots or Nous.
    const scope = request.user.brokerScope ?? (request.user.proofScope || request.user.automationScope ? "UI_PROOF" : null);
    if (scope) {
      const keys = Object.keys(input);
      const refused = scope.startsWith("ADMIN_ACTION:") ? keys.filter((key) => !agentAppearanceSettings.has(key)) : keys.filter((key) => agentRefusedSettings.has(key));
      if (refused.length) return sendApiError(reply, 403, "OPERATOR_REQUIRED", `Only the operator changes ${refused.join(", ")}.`);
    }
    const updated = await store.updateUserSettings(request.user.id, input);
    await recordAudit(store, request, {
      action: "user_settings.update",
      targetType: "user_settings",
      targetId: request.user.id,
      metadata: { userId: request.user.id }
    });
    return updated;
  };
  app.get("/api/user-settings", defaultRouteRateLimitOptions, getUserSettingsHandler);
  app.get("/api/user/settings", defaultRouteRateLimitOptions, getUserSettingsHandler);
  app.patch("/api/user-settings", defaultRouteRateLimitOptions, patchUserSettingsHandler);
  app.patch("/api/user/settings", defaultRouteRateLimitOptions, patchUserSettingsHandler);
}
