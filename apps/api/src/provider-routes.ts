import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { createProviderInputSchema, updateProviderInputSchema } from "@space/contracts";
import { SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import { validateProviderCredential } from "./providers.js";
import type { AuditRecorder } from "./request-audit.js";

/** Model provider registry and credential validation; the parent retains authentication, CSRF, errors and rate limits. */
export function registerProviderRoutes(app: FastifyInstance, options: {
  store: Pick<SpaceStore, "listProviders" | "createProvider" | "updateProvider" | "recordProviderValidation" |
    "replaceProviderModels" | "getLatestProviderValidation">;
  config: SpaceApiConfig;
  visibility: Pick<CliRuntimeVisibilityPolicy, "assertEnabled">;
  recordAudit: AuditRecorder;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { store, config, visibility: cliRuntimeVisibility, recordAudit, routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/providers", defaultRouteRateLimitOptions, async () => {
    const providers = await store.listProviders();
    return { data: providers, pagination: { page: 1, pageSize: 100, totalItems: providers.length, totalPages: providers.length ? 1 : 0 } };
  });
  app.post("/api/providers", defaultRouteRateLimitOptions, async (request) => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    const input = createProviderInputSchema.parse(request.body);
    const provider = await store.createProvider(input);
    await recordAudit(request, {
      action: "provider.create",
      targetType: "provider",
      targetId: provider.id,
      metadata: {
        type: provider.type,
        routeProfile: provider.routeProfile,
        backingProviderId: provider.backingProviderId
      }
    });
    return provider;
  });
  app.patch("/api/providers/:id", defaultRouteRateLimitOptions, async (request) => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    const params = request.params as { id: string };
    const input = updateProviderInputSchema.parse(request.body);
    const provider = await store.updateProvider(params.id, input);
    await recordAudit(request, {
      action: "provider.update",
      targetType: "provider",
      targetId: provider.id,
      metadata: {
        type: provider.type,
        routeProfile: provider.routeProfile,
        backingProviderId: provider.backingProviderId
      }
    });
    return provider;
  });
  app.post("/api/providers/:id/validate", defaultRouteRateLimitOptions, async (request) => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    const params = request.params as { id: string };
    const providers = await store.listProviders();
    const provider = providers.find((candidate) => candidate.id === params.id);
    if (!provider) {
      throw new SpaceNotFoundError(`Provider ${params.id} was not found.`);
    }
    const result = await validateProviderCredential(params.id, config, provider);
    const recorded = await store.recordProviderValidation(result);
    const persistedModels =
      recorded.status === "VERIFIED" && result.models ? await store.replaceProviderModels(params.id, result.models) : [];
    await recordAudit(request, {
      action: "provider.validate",
      targetType: "provider",
      targetId: params.id,
      metadata: {
        status: recorded.status,
        code: recorded.code,
        modelCount: recorded.modelCount,
        persistedModelCount: persistedModels.length,
        credentialLabel: recorded.credentialLabel
      }
    });
    return result.models ? { ...recorded, models: persistedModels } : recorded;
  });
  app.get("/api/providers/:id/validation", defaultRouteRateLimitOptions, async (request) => {
    const params = request.params as { id: string };
    const providers = await store.listProviders();
    if (!providers.some((provider) => provider.id === params.id)) {
      throw new SpaceNotFoundError(`Provider ${params.id} was not found.`);
    }
    return { data: await store.getLatestProviderValidation(params.id) };
  });
}
