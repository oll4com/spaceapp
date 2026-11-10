import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { acceptLanguages, notificationIdSchema, notificationListQuerySchema, pushDeviceIdSchema, pushDeviceRegistrationSchema, pushDeviceRemovalSchema, pushDeviceTokenSchema } from "@space/contracts";
import { SpaceNotFoundError } from "@space/runtime";
import type { NotificationService } from "./service.js";

export interface NotificationRouteDependencies {
  routeOptions: Record<string, unknown>;
  authenticatedOwner(request: FastifyRequest): Promise<string>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
}

const idParams = z.object({ id: notificationIdSchema }).strict();

/** The owner's notifications: list, what waits, read / acknowledge, and a test notification for the settings card. */
export function registerNotificationRoutes(app: FastifyInstance, service: NotificationService, deps: NotificationRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;

  app.get("/api/notifications", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const raw = (request.query ?? {}) as Record<string, string | undefined>;
    const query = parseQuery(notificationListQuerySchema, { ...raw, ...(raw.limit !== undefined ? { limit: Number(raw.limit) } : {}) });
    return { notifications: await service.list(owner, query, acceptLanguages(request.headers["accept-language"])) };
  });

  app.get("/api/notifications/pending", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    return service.pending(owner);
  });

  app.post("/api/notifications/read-all", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    return { read: await service.readAll(owner) };
  });

  app.post("/api/notifications/test", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const notification = await service.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "SYSTEM", kind: "TEST", severity: "ATTENTION",
      title: "Test notification", body: "This is how Space notifies you. You can turn each channel on or off in Settings → Notifications.", link: {}, dedupeKey: null, payload: {}, telegram: null });
    return { notification };
  });

  // The Android app's FCM token: registered while "Push notifications on this device" is on; `available` says whether this server can push.
  app.post("/api/notifications/push-devices", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    await service.registerPushDevice(owner, parseBody(pushDeviceRegistrationSchema, request.body));
    return { registered: true, available: service.pushAvailable() };
  });
  app.delete("/api/notifications/push-devices", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    return { removed: await service.removePushDevice(owner, parseBody(pushDeviceRemovalSchema, request.body).token) };
  });
  // The user's own push devices (Settings › Notifications); a phone sends its token in X-Space-Push-Token to be marked current.
  app.get("/api/notifications/push-devices", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const current = pushDeviceTokenSchema.safeParse(request.headers["x-space-push-token"]);
    return await service.listPushDevices(owner, current.success ? current.data : null);
  });
  app.delete("/api/notifications/push-devices/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const { id } = parseQuery(z.object({ id: pushDeviceIdSchema }), request.params);
    if (!await service.removePushDeviceById(owner, id)) throw new SpaceNotFoundError(`Push device ${id} was not found.`);
    return { removed: true };
  });

  // One record by id: what a native notification tap carries back into the app.
  app.get("/api/notifications/:id", routeOptions, async (request) => {
    const owner = await deps.authenticatedOwner(request);
    const params = parseQuery(idParams, request.params);
    const notification = await service.get(owner, params.id);
    if (!notification) throw new SpaceNotFoundError(`Notification ${params.id} was not found.`);
    return { notification };
  });
  for (const status of ["read", "ack"] as const) {
    app.post(`/api/notifications/:id/${status}`, routeOptions, async (request) => {
      const owner = await deps.authenticatedOwner(request);
      const params = parseQuery(idParams, request.params);
      const notification = await service.setStatus(owner, params.id, status === "read" ? "READ" : "ACKED");
      if (!notification) throw new SpaceNotFoundError(`Notification ${params.id} was not found.`);
      return { notification };
    });
  }
}
