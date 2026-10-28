import type {} from "../request-context.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  securityActionBeginSchema, securityActionFinishSchema, securityActionIdSchema, securityEventIdSchema, securityFindingIdSchema, securityFindingUpdateSchema,
  securityHostAliasSchema, securityHostIdSchema, securityHostReachSchema, securityHostStatusSchema, securityImageScanSchema, securityInventorySchema, securityMemoryCreateSchema,
  securityMemoryIdSchema, securityMemoryKindSchema, securityMemoryUpdateSchema, securityOsFamilySchema, type Pane, type SecurityHost
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { SecurityCopilotService } from "./service.js";

// Agent-facing routes of the Security Copilot pane, reached with the pane-scoped CLI bridge token: only the CLI session of a
// Security Copilot pane (space_securitycopilot). Answers carry structured fields; page text comes back marked as data.
export const cliSecurityCopilotPathPrefix = "/api/cli/security-copilot/";

interface CliBridgeClaims { roomId: string; paneId: string; cliSessionId: string }
export interface SecurityCopilotAgentRouteDependencies {
  store: Pick<SpaceStore, "getRoom" | "getPane">;
  routeOptions: Record<string, unknown>;
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: CliBridgeClaims } | null>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
}

const text = (max: number) => z.string().trim().min(1).max(max);
/** A host row for the agent: its inventory body stays on the server. */
const withoutInventory = (host: SecurityHost): Omit<SecurityHost, "inventory"> => { const copy: Partial<SecurityHost> = { ...host }; delete copy.inventory; return copy as Omit<SecurityHost, "inventory">; };
/** The whole fleet's npm/PyPI list is the largest body (about 2 MB for 20,000 libraries). */
const INVENTORY_BODY_LIMIT = 16 * 1024 * 1024;

export function registerSecurityCopilotAgentRoutes(app: FastifyInstance, service: SecurityCopilotService, deps: SecurityCopilotAgentRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;
  type Bridge = { owner: string; pane: Pane };

  function handle(method: "get" | "post" | "patch" | "delete", path: string, handler: (bridge: Bridge, request: FastifyRequest) => Promise<unknown>, extra: Record<string, unknown> = {}) {
    app[method](`${cliSecurityCopilotPathPrefix}${path}`, { ...routeOptions, ...extra }, async (request, reply) => {
      const bridge = await deps.requireBridge(request, reply);
      if (!bridge) return reply;
      const room = await deps.store.getRoom(bridge.claims.roomId);
      if (!room.ownerUserId) throw new SpaceConflictError("This room has no owner; the Security Copilot works in a signed-in operator's room.");
      const pane = await deps.store.getPane(bridge.claims.paneId);
      if (pane.mode !== "SECURITY_COPILOT") throw new SpaceConflictError("Security Copilot tools belong to the CLI session of a Security Copilot pane.");
      return handler({ owner: room.ownerUserId, pane }, request);
    });
  }
  const id = (request: FastifyRequest, schema: z.ZodType<string>): string => parseQuery(z.object({ id: schema }).strict(), request.params).id;

  handle("post", "next", async ({ owner, pane }) => service.next(owner, pane));
  handle("get", "summary", async ({ owner }) => service.summary(owner));

  // ---- hosts and inventory
  handle("get", "hosts", async ({ owner }) => ({ hosts: await service.hostList(owner) }));
  handle("post", "hosts", async ({ owner, pane }, request) => {
    const input = parseBody(z.object({ hosts: z.array(z.object({ alias: securityHostAliasSchema, label: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,79}$/),
      reach: securityHostReachSchema, status: securityHostStatusSchema, osFamily: securityOsFamilySchema }).strict()).min(1).max(200) }).strict(), request.body ?? {});
    const hosts = await service.registerHosts(owner, input.hosts);
    await deps.audit(request, "security_copilot.hosts.register", pane.id, { hosts: hosts.length });
    return { hosts: hosts.map(withoutInventory) };
  });
  handle("post", "inventory", async ({ owner, pane }, request) => {
    const result = await service.ingestInventory(owner, pane, parseBody(z.object({ inventory: securityInventorySchema }).strict(), request.body ?? {}).inventory);
    await deps.audit(request, "security_copilot.inventory", result.host.id, { paneId: pane.id, packages: result.packages, newFindings: result.newFindings });
    return result;
  }, { bodyLimit: INVENTORY_BODY_LIMIT });
  handle("get", "images", async ({ owner }, request) => service.imageScanDue(owner, parseQuery(z.object({ alias: securityHostAliasSchema }).strict(), request.query).alias));
  handle("post", "images", async ({ owner, pane }, request) => {
    const result = await service.recordImageScan(owner, pane, parseBody(securityImageScanSchema, request.body ?? {}));
    await deps.audit(request, "security_copilot.images", result.host.id, { paneId: pane.id, scanned: result.scanned, newFindings: result.newFindings });
    return result;
  }, { bodyLimit: INVENTORY_BODY_LIMIT });
  handle("post", "hosts/unreachable", async ({ owner }, request) => {
    const input = parseBody(z.object({ alias: securityHostAliasSchema, note: text(1000) }).strict(), request.body ?? {});
    return { host: withoutInventory(await service.markUnreachable(owner, input.alias, input.note)) };
  });

  // ---- findings and vendor pages
  handle("get", "findings", async ({ owner }, request) => {
    const query = parseQuery(z.object({ hostId: securityHostIdSchema.optional(), all: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).strict(), request.query);
    return { findings: await service.findings(owner, { hostId: query.hostId, open: query.all !== "true", limit: query.limit }) };
  });
  handle("post", "findings/:id", async ({ owner, pane }, request) => {
    const findingId = id(request, securityFindingIdSchema);
    const input = parseBody(securityFindingUpdateSchema, request.body ?? {});
    const finding = await service.updateFinding(owner, findingId, input, "AGENT");
    await deps.audit(request, "security_copilot.finding.update", findingId, { paneId: pane.id, status: input.status });
    return { finding };
  });
  handle("post", "findings/:id/confirm", async ({ owner }, request) => ({ finding: await service.confirm(owner, id(request, securityFindingIdSchema),
    parseBody(z.object({ url: z.string().url().max(500) }).strict(), request.body ?? {}).url) }));
  handle("post", "advisory", async (_bridge, request) => {
    const input = parseBody(z.object({ url: z.string().url().max(500), offset: z.number().int().min(0).max(2_000_000).default(0) }).strict(), request.body ?? {});
    return service.readAdvisory(input.url, input.offset);
  });

  // ---- the gate
  handle("post", "actions/begin", async ({ owner, pane }, request) => {
    const input = parseBody(securityActionBeginSchema, request.body ?? {});
    const result = await service.beginAction(owner, pane, input);
    await deps.audit(request, "security_copilot.action.begin", result.actionId, { paneId: pane.id, kind: input.kind, hostId: input.hostId, gate: result.gate });
    return result;
  });
  handle("post", "actions/:id/start", async ({ owner, pane }, request) => {
    const action = await service.startApproved(owner, pane, id(request, securityActionIdSchema));
    await deps.audit(request, "security_copilot.action.start", action.id, { paneId: pane.id, kind: action.kind });
    return { action };
  });
  handle("post", "actions/:id/finish", async ({ owner, pane }, request) => {
    const actionId = id(request, securityActionIdSchema);
    const input = parseBody(securityActionFinishSchema, request.body ?? {});
    const action = await service.finishAction(owner, pane, actionId, input);
    await deps.audit(request, "security_copilot.action.finish", actionId, { paneId: pane.id, status: input.status });
    return { action };
  });
  handle("post", "actions/:id/hotfix-grant", async ({ owner, pane }, request) => {
    const actionId = id(request, securityActionIdSchema);
    const { ticket } = parseBody(z.object({ ticket: z.string().regex(/^q-\d{8}-\d{6}-[0-9a-f]{4}$/) }).strict(), request.body ?? {});
    const result = await service.hotfixGrant(owner, pane, actionId, ticket);
    await deps.audit(request, "security_copilot.hotfix_grant", actionId, { paneId: pane.id, ticket });
    return result;
  });
  handle("get", "actions", async ({ owner }, request) => {
    const query = parseQuery(z.object({ hostId: securityHostIdSchema.optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).strict(), request.query);
    return { actions: await service.actions(owner, query) };
  });

  // ---- briefs, questions, notes
  handle("post", "briefs/:id/done", async ({ owner, pane }, request) => {
    const briefId = id(request, securityEventIdSchema);
    const input = parseBody(z.object({ summary: text(2000), failed: z.boolean().default(false) }).strict(), request.body ?? {});
    return { event: await service.finishBrief(owner, pane, briefId, input) };
  });
  handle("post", "ask", async ({ owner, pane }, request) => {
    const input = parseBody(z.object({ question: text(2000), options: z.array(text(200)).max(6).optional() }).strict(), request.body ?? {});
    return { question: await service.ask(owner, pane, input) };
  });
  handle("post", "events/:id/wait", async ({ owner, pane }, request) => service.waitForAnswer(owner, pane, id(request, securityEventIdSchema),
    parseBody(z.object({ waitMs: z.number().int().min(0).max(50_000).default(30_000) }).strict(), request.body ?? {}).waitMs));
  handle("post", "note", async ({ owner, pane }, request) => ({ event: await service.note(owner, pane, parseBody(z.object({ message: text(2000) }).strict(), request.body ?? {}).message) }));

  // ---- memory
  handle("post", "memory/recall", async ({ owner }, request) => {
    const query = parseBody(z.object({ query: z.string().max(300).optional(), hostId: securityHostIdSchema.optional(), kinds: z.array(securityMemoryKindSchema).max(7).optional(),
      limit: z.number().int().min(1).max(50).optional() }).strict(), request.body ?? {});
    return { memories: await service.recall(owner, query) };
  });
  handle("post", "memory", async ({ owner }, request) => ({ memory: await service.remember(owner, parseBody(securityMemoryCreateSchema, request.body ?? {}), "AGENT") }));
  handle("patch", "memory/:id", async ({ owner }, request) => ({ memory: await service.updateMemory(owner, id(request, securityMemoryIdSchema), parseBody(securityMemoryUpdateSchema, request.body ?? {})) }));
  handle("delete", "memory/:id", async ({ owner }, request) => service.forget(owner, id(request, securityMemoryIdSchema)));
}
