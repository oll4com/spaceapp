import type {} from "./request-context.js";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import type { SpaceStore } from "@space/runtime";
import { TENANT_LOCAL } from "@space/db";
import { AccountStateError, type AccountLifecycle } from "./computer/accounts.js";
import { sendApiError } from "./http-errors.js";
import { recordAudit } from "./request-audit.js";

// K2 design §3.2 "account" group (plan clipboard:ZGz1LnD51ELH step 7): the Nous app's own account, its deletion (GDPR Art. 17,
// with the export of Art. 20) and the 7-day undo. Registered only headless and with a lifecycle (createApp option accountLifecycle);
// staff suspension is not a user route. The parent keeps authentication, CSRF, errors and rate limits.
export function registerAccountRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  lifecycle: AccountLifecycle;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { store, lifecycle, routeOptions } = options;

  /** The signed-in user's tenant; the self-hosted one tenant is never an account to delete. */
  async function tenantOf(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const tenantId = request.user && store.getUserTenantId ? await store.getUserTenantId(request.user.id) : null;
    if (!tenantId || tenantId === TENANT_LOCAL) {
      void sendApiError(reply, 403, "ACCOUNT_UNAVAILABLE", "This sign-in has no Nous Computer account.");
      return null;
    }
    return tenantId;
  }
  async function act(request: FastifyRequest, reply: FastifyReply, action: string, run: (tenantId: string) => Promise<unknown>) {
    const tenantId = await tenantOf(request, reply);
    if (!tenantId) return reply;
    const account = await lifecycle.account(tenantId);
    // A team account is closed by its admin only; a personal one by its user.
    if (account.kind !== "PERSONAL" && request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ACCOUNT_ADMIN_REQUIRED", "Only the team's admin may do this.");
    try {
      const result = await run(tenantId);
      await recordAudit(store, request, { action, targetType: "tenant", targetId: tenantId });
      return { ...(await lifecycle.account(tenantId)), ...(result ?? {}) };
    } catch (error) {
      if (error instanceof AccountStateError) return sendApiError(reply, 409, "ACCOUNT_STATE", error.message);
      throw error;
    }
  }

  app.get("/api/account", routeOptions, async (request, reply) => {
    const tenantId = await tenantOf(request, reply);
    return tenantId ? lifecycle.account(tenantId) : reply;
  });
  app.delete("/api/account", routeOptions, (request, reply) =>
    act(request, reply, "account.deletion_requested", async (tenantId) => {
      const { exportKey } = await lifecycle.requestDeletion(tenantId, `requested by ${request.user!.id}`);
      return { exportReady: exportKey !== null };
    }));
  app.post("/api/account/deletion/cancel", routeOptions, (request, reply) =>
    act(request, reply, "account.deletion_cancelled", (tenantId) => lifecycle.cancelDeletion(tenantId, `cancelled by ${request.user!.id}`)));
}
