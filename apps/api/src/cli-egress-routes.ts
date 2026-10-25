import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  cliVpnConnectionSchema, cliVpnProfileIdSchema, cliVpnRoutingStatusSchema, replaceCliVpnProfileInputSchema,
  type CliGlobalEgressStatus, type CliRuntimeSetting, type CliRuntimeVpnStatus, type CliVpnConnection
} from "@space/contracts";
import { nowIso, type SpaceStore } from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";
import type { CliVpnBroker } from "./cli-vpn.js";
import { sendApiError } from "./http-errors.js";
import type { AuditRecorder } from "./request-audit.js";

export type CliVpnApplicationsReader = (settings: readonly CliRuntimeSetting[]) => Promise<{
  connection: CliVpnConnection | undefined;
  applications: CliRuntimeVpnStatus[];
  egress: CliGlobalEgressStatus;
}>;

/**
 * ADMIN CLI egress and shared VPN profile domain. Switching the global egress
 * route restarts running CLI sessions, so that route stays in the composition
 * root, which also retains authentication, CSRF, errors and rate limits.
 */
export function registerCliEgressRoutes(app: FastifyInstance, options: {
  store: Pick<SpaceStore, "listCliRuntimeSettings">;
  config: Pick<SpaceApiConfig, "cliVpnEnabled">;
  cliVpnBroker: Pick<CliVpnBroker, "status" | "replace" | "verify" | "remove" | "replaceProfile" | "verifyProfile" |
    "rotateMullvadCity" | "rotateNordCity" | "removeProfile">;
  assertCliVpnAvailable: () => void;
  readCliVpnApplications: CliVpnApplicationsReader;
  recordAudit: AuditRecorder;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const {
    store, config, cliVpnBroker, assertCliVpnAvailable, readCliVpnApplications, recordAudit,
    routeOptions: defaultRouteRateLimitOptions
  } = options;
  app.get("/api/cli/egress", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI egress settings require the ADMIN role.");
    }
    const settings = await store.listCliRuntimeSettings();
    return (await readCliVpnApplications(settings)).egress;
  });

  app.get("/api/cli/vpn/routing-status", defaultRouteRateLimitOptions, async () => {
    const settings = await store.listCliRuntimeSettings();
    const vpn = await readCliVpnApplications(settings);
    return cliVpnRoutingStatusSchema.parse({
      vpnSupported: config.cliVpnEnabled,
      selectedRoute: vpn.egress.selectedRoute,
      connectionStatus: vpn.connection?.status ?? "NOT_CONFIGURED",
      egressIpv4: vpn.connection?.egressIpv4 ?? null,
      egressIpv6: vpn.connection?.egressIpv6 ?? null,
      relay: vpn.connection?.relay ?? null,
      applications: vpn.applications,
      checkedAt: nowIso()
    });
  });

  app.get("/api/cli/vpn", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI VPN settings require the ADMIN role.");
    }
    assertCliVpnAvailable();
    return cliVpnConnectionSchema.parse(await cliVpnBroker.status());
  });

  app.put("/api/cli/vpn/profile", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI VPN settings require the ADMIN role.");
    }
    assertCliVpnAvailable();
    const input = replaceCliVpnProfileInputSchema.parse(request.body ?? {});
    const connection = cliVpnConnectionSchema.parse(await cliVpnBroker.replace(input.config));
    await recordAudit(request, {
      action: "cli.vpn.profile.replace",
      targetType: "cli_vpn_profile",
      targetId: "shared",
      metadata: {
        status: connection.status,
        profileFingerprint: connection.profileFingerprint,
        ipv4Verified: connection.egressIpv4 !== null,
        ipv6Verified: connection.egressIpv6 !== null
      }
    });
    return connection;
  });

  app.post("/api/cli/vpn/verify", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI VPN settings require the ADMIN role.");
    }
    assertCliVpnAvailable();
    const connection = cliVpnConnectionSchema.parse(await cliVpnBroker.verify());
    await recordAudit(request, {
      action: "cli.vpn.profile.verify",
      targetType: "cli_vpn_profile",
      targetId: "shared",
      metadata: {
        status: connection.status,
        profileFingerprint: connection.profileFingerprint,
        ipv4Verified: connection.egressIpv4 !== null,
        ipv6Verified: connection.egressIpv6 !== null
      }
    });
    return connection;
  });

  app.delete("/api/cli/vpn/profile", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI VPN settings require the ADMIN role.");
    }
    assertCliVpnAvailable();
    const connection = cliVpnConnectionSchema.parse(await cliVpnBroker.remove());
    await recordAudit(request, {
      action: "cli.vpn.profile.remove",
      targetType: "cli_vpn_profile",
      targetId: "shared",
      metadata: { status: connection.status }
    });
    return connection;
  });

  const cliVpnProfileParamSchema = z.object({ profileId: cliVpnProfileIdSchema });

  app.put("/api/cli/egress/profiles/:profileId", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI egress settings require the ADMIN role.");
    }
    assertCliVpnAvailable();
    const params = cliVpnProfileParamSchema.parse(request.params);
    const input = replaceCliVpnProfileInputSchema.parse(request.body ?? {});
    const connection = cliVpnConnectionSchema.parse(await cliVpnBroker.replaceProfile(params.profileId, input.config));
    await recordAudit(request, {
      action: "cli.egress.profile.replace",
      targetType: "cli_vpn_profile",
      targetId: params.profileId,
      metadata: {
        status: connection.status,
        profileFingerprint: connection.profileFingerprint,
        ipv4Verified: connection.egressIpv4 !== null,
        ipv6Verified: connection.egressIpv6 !== null
      }
    });
    return connection;
  });

  app.post("/api/cli/egress/profiles/:profileId/verify", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI egress settings require the ADMIN role.");
    }
    assertCliVpnAvailable();
    const params = cliVpnProfileParamSchema.parse(request.params);
    const connection = cliVpnConnectionSchema.parse(await cliVpnBroker.verifyProfile(params.profileId));
    await recordAudit(request, {
      action: "cli.egress.profile.verify",
      targetType: "cli_vpn_profile",
      targetId: params.profileId,
      metadata: { status: connection.status, profileFingerprint: connection.profileFingerprint }
    });
    return connection;
  });

  app.post("/api/cli/egress/profiles/mullvad/random-city", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI egress settings require the ADMIN role.");
    }
    assertCliVpnAvailable();
    const connection = cliVpnConnectionSchema.parse(await cliVpnBroker.rotateMullvadCity());
    await recordAudit(request, {
      action: "cli.egress.mullvad.city.rotate",
      targetType: "cli_vpn_profile",
      targetId: "mullvad",
      metadata: {
        status: connection.status,
        relay: connection.relay,
        egressIpv4: connection.egressIpv4
      }
    });
    return connection;
  });

  app.post("/api/cli/egress/profiles/nord/random-city", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI egress settings require the ADMIN role.");
    }
    assertCliVpnAvailable();
    const connection = cliVpnConnectionSchema.parse(await cliVpnBroker.rotateNordCity());
    await recordAudit(request, {
      action: "cli.egress.nord.city.rotate",
      targetType: "cli_vpn_profile",
      targetId: "nord",
      metadata: {
        status: connection.status,
        relay: connection.relay,
        egressIpv4: connection.egressIpv4
      }
    });
    return connection;
  });

  app.delete("/api/cli/egress/profiles/:profileId", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI egress settings require the ADMIN role.");
    }
    assertCliVpnAvailable();
    const params = cliVpnProfileParamSchema.parse(request.params);
    const connection = cliVpnConnectionSchema.parse(await cliVpnBroker.removeProfile(params.profileId));
    await recordAudit(request, {
      action: "cli.egress.profile.remove",
      targetType: "cli_vpn_profile",
      targetId: params.profileId,
      metadata: { status: connection.status }
    });
    return connection;
  });
}
