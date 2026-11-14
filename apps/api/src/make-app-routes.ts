import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { SPACE_AGENT_HOME, SPACE_INSTALL_ROOT, createTaskItemRequestSchema } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { NotificationService } from "./notifications/service.js";
import type { NousWiring } from "./nous/wiring.js";
import type { TaskScheduleRunnerDeps } from "./task-schedules.js";
import { recordAudit } from "./request-audit.js";
import { sendApiError } from "./http-errors.js";

// Plan clipboard:F1nJVLcoWdd- step 6: the SpaceApp app in Make (integrations/make-app) calls these routes with the key in
// secrets/space-make-app.key (installed from the Vault, docs/agents/make-app.md). No key file: every route answers 404. They act as the
// instance's operator (the ADMIN with the operator e-mail, else the first ADMIN) and every write is audited.
export const MAKE_APP_PATHS = ["/api/make/v1/me", "/api/make/v1/tasks", "/api/make/v1/nous/messages", "/api/make/v1/briefs", "/api/make/v1/done", "/api/make/v1/approvals"];

const KEY_MIN = 32;
const taskSchema = createTaskItemRequestSchema.pick({ title: true, objective: true, schedule: true });
const messageSchema = z.object({ content: z.string().trim().min(1).max(20_000) }).strict();
const briefSchema = z.object({ paneId: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(20_000) }).strict();
// 200 is the notification store's page size; Make's trigger pages on with `before`.
const doneQuery = z.object({ since: z.string().datetime().optional(), before: z.string().datetime().optional() });

export type MakeAppRouteDeps = {
  store: Pick<SpaceStore, "listUsersWithRoomCounts" | "upsertTaskItem" | "getPane" | "upsertUser" | "recordAuditEvent">;
  operatorEmail?: string | null;
  nous: () => Pick<NousWiring, "service"> | null;
  notifications: Pick<NotificationService, "list">;
  brief: () => TaskScheduleRunnerDeps["brief"] | null;
  roomOwner: (roomId: string) => Promise<string | null>;
  routeOptions: Record<string, unknown>;
  /** Tests only; by default `${SPACE_INSTALL_ROOT}/secrets/space-make-app.key`, then `${SPACE_AGENT_HOME}/.config/space/make-app.key`. */
  keyFiles?: string[];
};

const digest = (text: string) => createHash("sha256").update(text).digest();

export function registerMakeAppRoutes(app: FastifyInstance, deps: MakeAppRouteDeps) {
  const files = deps.keyFiles ?? [join(SPACE_INSTALL_ROOT, "secrets", "space-make-app.key"), join(SPACE_AGENT_HOME, ".config/space", "make-app.key")];
  const key = async () => {
    for (const file of files) {
      const text = (await readFile(file, "utf8").catch(() => "")).trim();
      if (text) return text.length >= KEY_MIN ? text : "";
    }
    return "";
  };
  /** The operator's id, or null after the reply was sent (off, wrong key, no ADMIN). */
  async function owner(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const expected = await key();
    if (!expected) { sendApiError(reply, 404, "NOT_FOUND", "The Make app is not enabled on this instance."); return null; }
    const given = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization ?? ""))?.[1]?.trim() ?? "";
    if (!given || !timingSafeEqual(digest(given), digest(expected))) { sendApiError(reply, 401, "MAKE_KEY_INVALID", "A valid SpaceApp key is required."); return null; }
    const admins = ((await deps.store.listUsersWithRoomCounts?.()) ?? []).filter((user) => user.role === "ADMIN" && !user.disabled);
    const user = admins.find((entry) => deps.operatorEmail && entry.email.toLowerCase() === deps.operatorEmail.toLowerCase()) ?? admins[0];
    if (!user) { sendApiError(reply, 503, "NO_OPERATOR", "This instance has no operator account yet."); return null; }
    return user.id;
  }
  const audit = (request: FastifyRequest, actorUserId: string, action: string, targetType: string, targetId: string | null, metadata: Record<string, unknown> = {}) =>
    recordAudit(deps.store, request, { action, targetType, targetId, actorUserId, metadata: { ...metadata, via: "make-app" } });

  app.get("/api/make/v1/me", deps.routeOptions, async (request, reply) => {
    const id = await owner(request, reply);
    return id && { ok: true, app: "SpaceApp" };
  });

  app.post("/api/make/v1/tasks", deps.routeOptions, async (request, reply) => {
    const id = await owner(request, reply);
    if (!id) return reply;
    const input = taskSchema.parse(request.body ?? {});
    const item = await deps.store.upsertTaskItem({ ...input, ownerUserId: id, status: "OPEN", source: "AGENT", roomId: null, paneId: null, paneTitle: null });
    await audit(request, id, "make.task.create", "task", item.id, { scheduled: Boolean(item.schedule) });
    return reply.code(201).send({ id: item.id, title: item.title, status: item.status, createdAt: item.createdAt });
  });

  app.post("/api/make/v1/nous/messages", deps.routeOptions, async (request, reply) => {
    const id = await owner(request, reply);
    if (!id) return reply;
    const { content } = messageSchema.parse(request.body ?? {});
    const nous = deps.nous();
    if (!nous) return sendApiError(reply, 503, "NOUS_UNAVAILABLE", "Nous is not available on this instance.");
    // Not the operator's own words: person false, and the text says where it came from.
    const message = await nous.service.send(id, `From Make: ${content}`, { person: false });
    await audit(request, id, "make.nous.message", "nous_message", message.id);
    return reply.code(201).send({ id: message.id, createdAt: message.createdAt });
  });

  app.post("/api/make/v1/briefs", deps.routeOptions, async (request, reply) => {
    const id = await owner(request, reply);
    if (!id) return reply;
    const input = briefSchema.parse(request.body ?? {});
    const pane = await Promise.resolve(deps.store.getPane(input.paneId)).catch(() => null);
    if (!pane || (await deps.roomOwner(pane.roomId)) !== id) return sendApiError(reply, 404, "PANE_NOT_FOUND", "No such pane in the operator's rooms.");
    const brief = deps.brief();
    if (!brief) return sendApiError(reply, 503, "COPILOTS_UNAVAILABLE", "The copilots are not available here.");
    try {
      await brief(pane, id, input.text);
    } catch (error) {
      return sendApiError(reply, 409, "BRIEF_REFUSED", error instanceof Error ? error.message : "The pane took no brief.");
    }
    await audit(request, id, "make.brief.create", "pane", pane.id, { mode: pane.mode });
    return reply.code(201).send({ ok: true, paneId: pane.id, mode: pane.mode });
  });

  app.get("/api/make/v1/done", deps.routeOptions, async (request, reply) => {
    const id = await owner(request, reply);
    if (!id) return reply;
    const query = doneQuery.parse(request.query ?? {});
    const page = await deps.notifications.list(id, { status: "ALL", source: "NOUS", kind: "REQUEST_DONE", limit: 200, ...(query.before ? { before: query.before } : {}) });
    const items = page.filter((record) => !query.since || record.createdAt > query.since)
      .map((record) => ({ id: record.id, title: record.title, body: record.body, createdAt: record.createdAt, roomId: record.roomId, paneId: record.paneId }));
    return { items, next: page.length === 200 && items.length === page.length ? page.at(-1)!.createdAt : null };
  });

  app.get("/api/make/v1/approvals", deps.routeOptions, async (request, reply) => {
    const id = await owner(request, reply);
    if (!id) return reply;
    const nous = deps.nous();
    if (!nous) return sendApiError(reply, 503, "NOUS_UNAVAILABLE", "Nous is not available on this instance.");
    const items = (await nous.service.decisions(id)).filter((decision) => decision.status === "OPEN")
      .map((decision) => ({ id: decision.id, category: decision.category, title: decision.title, body: decision.body, options: decision.options, recommendation: decision.recommendation, createdAt: decision.createdAt }));
    return { items };
  });
}
