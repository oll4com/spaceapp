import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import type { SpaceStore } from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";
import { sendApiError } from "./http-errors.js";
import { recordAudit } from "./request-audit.js";
import { parseBody } from "./route-parsing.js";
import { createTransferService, TransferError, transferPairSchema, transferRunSchema } from "./transfer-service.js";

/** Settings → Transfer (plan clipboard:HO2VBvn_aaPI step 4), ADMIN only; the parent keeps authentication, CSRF and rate limits. */
export function registerTransferRoutes(app: FastifyInstance, options: {
  store: SpaceStore; config: Pick<SpaceApiConfig, "installRoot" | "databaseUrl">; routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const transfer = createTransferService({ installRoot: options.config.installRoot, databaseUrl: options.config.databaseUrl });
  const admin = (role: string | undefined) => role === "ADMIN";
  app.get("/api/transfer", options.routeOptions, async (request, reply) => {
    if (!admin(request.user?.role)) return sendApiError(reply, 403, "ADMIN_REQUIRED", "Transfer requires the ADMIN role.");
    return transfer.status();
  });
  app.post("/api/transfer/pair", options.routeOptions, async (request, reply) => {
    if (!admin(request.user?.role)) return sendApiError(reply, 403, "ADMIN_REQUIRED", "Transfer requires the ADMIN role.");
    try {
      const paired = await transfer.pair(parseBody(transferPairSchema, request.body));
      await recordAudit(options.store, request, { action: "transfer.pair", targetType: "transfer_target", targetId: paired.pairingCode });
      return paired;
    } catch (error) {
      if (error instanceof TransferError) return sendApiError(reply, 409, "TRANSFER_REFUSED", error.message);
      throw error;
    }
  });
  app.post("/api/transfer/run", options.routeOptions, async (request, reply) => {
    if (!admin(request.user?.role)) return sendApiError(reply, 403, "ADMIN_REQUIRED", "Transfer requires the ADMIN role.");
    const input = parseBody(transferRunSchema, request.body);
    try {
      const { job, done } = await transfer.start(input);
      const audit = () => recordAudit(options.store, request, { action: `transfer.${input.action}`, targetType: "transfer", targetId: job.startedAt,
        metadata: { dryRun: job.dryRun } });
      // Cut over, this database is read-only: a rollback's audit row waits until the rollback has made it writable again.
      if (input.action === "rollback" && !job.dryRun) await done.then(audit); else await audit();
      return { job };
    } catch (error) {
      if (error instanceof TransferError) return sendApiError(reply, 409, "TRANSFER_REFUSED", error.message);
      throw error;
    }
  });
}
