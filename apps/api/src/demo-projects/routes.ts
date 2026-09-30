import { request as httpRequest } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createDemoOperationInputSchema,
  demoAccountsQuerySchema,
  demoGoogleSettingsInputSchema,
  demoOperationRetryInputSchema,
  demoSalesforceSettingsInputSchema,
  demoSelectionInputSchema,
  demoSheetsTargetInputSchema,
  demoStartRunInputSchema,
  demoRunTokenHeader
} from "@space/contracts";
import type { DemoProjectsService } from "./service.js";

const providerParamSchema = z.object({ provider: z.enum(["salesforce", "google-sheets"]) });
const runParamSchema = z.object({ runId: z.string().trim().min(3).max(120) });
const operationParamSchema = z.object({ id: z.string().trim().min(3).max(120) });
const variantQuerySchema = z.object({
  variantId: z.string().trim().min(3).max(80),
  projectId: z.string().trim().min(3).max(80).optional()
});
const fileQuerySchema = variantQuerySchema.extend({ path: z.string().trim().min(1).max(300) });
const logsQuerySchema = z.object({ since: z.coerce.number().int().min(0).max(1_000_000).optional() });
const operationsQuerySchema = z.object({ projectId: z.string().trim().min(3).max(80).optional() });
const testsQuerySchema = z.object({ projectId: z.string().trim().min(3).max(80).optional() });
const testsRunInputSchema = z.object({ projectId: z.string().trim().min(3).max(80).optional(), variantId: z.string().trim().min(3).max(80).optional() }).strict();
const createSheetsTargetSchema = z
  .object({ title: z.string().trim().min(3).max(200).nullable().optional(), tab: z.string().trim().min(1).max(120).nullable().optional() })
  .strict();

export interface DemoProjectsRouteDependencies {
  service: DemoProjectsService;
  enabled: boolean;
  resolvePublicOrigin: (request: FastifyRequest) => string;
  sessionToken: (request: FastifyRequest) => string;
  rateLimitOptions: Record<string, unknown>;
  ownerId: (request: FastifyRequest) => Promise<string>;
}

function sendError(reply: FastifyReply, error: { code: string; message: string; statusCode: number }): FastifyReply {
  return reply.status(error.statusCode).send({
    error: {
      code: error.code,
      message: error.message,
      requestId: reply.request.requestIdForSpace
    }
  });
}

function parse<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    reply.status(400).send({
      error: { code: "DEMO_INVALID_INPUT", message: parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 300) }
    });
    return null;
  }
  return parsed.data;
}

const oauthCallbackQuerySchema = z
  .object({
    code: z.string().min(1).max(4096).optional(),
    state: z.string().min(1).max(1024).optional(),
    error: z.string().max(200).optional(),
    scope: z.string().max(1024).optional()
  })
  .loose();

function demoOAuthPopupHtml(provider: string, ok: boolean, errorCode: string | null): string {
  const payload = JSON.stringify({ type: "space.demo-projects.oauth", provider, ok, errorCode }).replaceAll("<", "\\u003c");
  const heading = ok ? "Connection complete" : "Connection failed";
  const detail = ok ? "You can close this window and return to Space." : "Return to the Demo Projects pane for safe details.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title></head><body><main><h1>${heading}</h1><p>${detail}</p></main><script>window.opener?.postMessage(${payload}, window.location.origin);window.close();</script></body></html>`;
}

export function registerDemoProjectsRoutes(app: FastifyInstance, dependencies: DemoProjectsRouteDependencies): void {
  const { service, enabled, rateLimitOptions, resolvePublicOrigin, sessionToken, ownerId } = dependencies;
  const guard = async (reply: FastifyReply): Promise<boolean> => {
    if (!enabled) {
      reply.status(404).send({
        error: {
          code: "DEMO_PROJECTS_DISABLED",
          message: "Demo Projects is disabled on this Space instance.",
          requestId: reply.request.requestIdForSpace
        }
      });
      return false;
    }
    try {
      await service.initialize();
      return true;
    } catch (error) {
      app.log.error({ err: error }, "Demo Projects could not initialize.");
      reply.status(503).send({
        error: {
          code: "DEMO_PROJECTS_UNAVAILABLE",
          message: "Demo Projects storage is unavailable on this Space instance.",
          requestId: reply.request.requestIdForSpace
        }
      });
      return false;
    }
  };
  const runToken = (request: FastifyRequest): string => {
    const header = request.headers[demoRunTokenHeader];
    return Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
  };

  app.get("/api/demo-projects/state", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    try {
      const owner = await ownerId(request);
      return await service.state(owner, resolvePublicOrigin(request));
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.put("/api/demo-projects/selection", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const input = parse(demoSelectionInputSchema, request.body, reply);
    if (!input) return reply;
    try {
      const owner = await ownerId(request);
      const selection = await service.saveSelection(owner, input);
      return { selection };
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.post("/api/demo-projects/runs", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const input = parse(demoStartRunInputSchema, request.body, reply);
    if (!input) return reply;
    try {
      const owner = await ownerId(request);
      const started = await service.runs.start({
        ownerUserId: owner,
        projectId: input.projectId,
        variantId: input.variantId,
        mode: input.mode,
        connectionStatus: async (provider) => service.connections.isConnected(owner, provider)
      });
      return { run: service.publicRun(started.run) };
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.post("/api/demo-projects/runs/:runId/stop", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const params = parse(runParamSchema, request.params, reply);
    if (!params) return reply;
    try {
      const owner = await ownerId(request);
      const run = await service.runs.stop(owner, params.runId);
      return { run: service.publicRun(run) };
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.post("/api/demo-projects/runs/:runId/restart", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const params = parse(runParamSchema, request.params, reply);
    if (!params) return reply;
    try {
      const owner = await ownerId(request);
      const started = await service.runs.restart(owner, params.runId);
      return { run: service.publicRun(started.run) };
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.get("/api/demo-projects/runs/:runId/logs", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const params = parse(runParamSchema, request.params, reply);
    const query = parse(logsQuerySchema, request.query, reply);
    if (!params || !query) return reply;
    try {
      const owner = await ownerId(request);
      const logs = await service.runs.readLogs(owner, params.runId, query.since ?? 0);
      return { runId: params.runId, entries: logs.entries, nextSeq: logs.nextSeq, dropped: logs.dropped };
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.get("/api/demo-projects/files", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const query = parse(variantQuerySchema, request.query, reply);
    if (!query) return reply;
    try {
      await ownerId(request);
      return await service.listVariantFiles(query.variantId, query.projectId);
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.get("/api/demo-projects/files/content", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const query = parse(fileQuerySchema, request.query, reply);
    if (!query) return reply;
    try {
      await ownerId(request);
      return await service.readVariantFile(query.variantId, query.path, query.projectId);
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.put("/api/demo-projects/connections/:provider/settings", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const params = parse(providerParamSchema, request.params, reply);
    if (!params) return reply;
    try {
      const owner = await ownerId(request);
      const schema = params.provider === "salesforce" ? demoSalesforceSettingsInputSchema : demoGoogleSettingsInputSchema;
      const input = parse(schema, request.body, reply);
      if (!input) return reply;
      await service.connections.saveSettings(owner, params.provider, input);
      const connections = await service.catalogConnections(owner, resolvePublicOrigin(request));
      return { connections };
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.post("/api/demo-projects/connections/:provider/authorize", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const params = parse(providerParamSchema, request.params, reply);
    if (!params) return reply;
    try {
      const owner = await ownerId(request);
      const result = await service.connections.startOAuth({
        ownerUserId: owner,
        provider: params.provider,
        sessionToken: sessionToken(request),
        publicOrigin: resolvePublicOrigin(request)
      });
      return result;
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.delete("/api/demo-projects/connections/:provider", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const params = parse(providerParamSchema, request.params, reply);
    if (!params) return reply;
    try {
      const owner = await ownerId(request);
      await service.connections.disconnect(owner, params.provider);
      const connections = await service.catalogConnections(owner, resolvePublicOrigin(request));
      return { connections };
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.put("/api/demo-projects/sheets/target", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const input = parse(demoSheetsTargetInputSchema, request.body, reply);
    if (!input) return reply;
    try {
      const owner = await ownerId(request);
      const target = await service.operations.selectSheetsTarget(owner, input);
      return { sheets: service.publicSheetsTarget(target) };
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.post("/api/demo-projects/sheets/create", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const input = parse(createSheetsTargetSchema, request.body ?? {}, reply);
    if (!input) return reply;
    try {
      const owner = await ownerId(request);
      const target = await service.operations.createSheetsTarget(owner, input);
      return { sheets: service.publicSheetsTarget(target) };
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.post("/api/demo-projects/sheets/verify", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    try {
      const owner = await ownerId(request);
      const target = await service.operations.verifySheetsTarget(owner);
      if (!target) {
        return sendError(reply, { code: "DEMO_SHEET_NOT_SELECTED", message: "Select a spreadsheet first.", statusCode: 409 });
      }
      return { sheets: service.publicSheetsTarget(target) };
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.get("/api/demo-projects/operations", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const query = parse(operationsQuerySchema, request.query, reply);
    if (!query) return reply;
    try {
      const owner = await ownerId(request);
      return await service.operations.listOperations(owner, { projectId: query.projectId, limit: 50 });
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.post("/api/demo-projects/operations/:id/retry", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const params = parse(operationParamSchema, request.params, reply);
    if (!params) return reply;
    const input = parse(demoOperationRetryInputSchema, request.body ?? {}, reply);
    if (!input) return reply;
    try {
      const owner = await ownerId(request);
      const operation = await service.operations.retryOperation(owner, params.id, { attemptNow: input.attemptNow });
      return { operation };
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.get("/api/demo-projects/accounts", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const query = parse(
      demoAccountsQuerySchema.extend({ projectId: z.string().trim().min(3).max(80), variantId: z.string().trim().min(3).max(80), mode: z.enum(["SAMPLE", "LIVE"]) }),
      request.query,
      reply
    );
    if (!query) return reply;
    try {
      const owner = await ownerId(request);
      return await service.operations.listAccounts({
        ownerUserId: owner,
        variantId: query.variantId,
        mode: query.mode,
        search: query.search,
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 25
      });
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.post("/api/demo-projects/tests/run", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const input = parse(testsRunInputSchema, request.body ?? {}, reply);
    if (!input) return reply;
    try {
      const owner = await ownerId(request);
      const selection = await service.selection(owner);
      const projectId = input.projectId ?? selection.projectId;
      const variantId = input.variantId ?? selection.variantId;
      const runs = await service.ownedRuns(owner, 20);
      const run = runs.find((candidate) => candidate.projectId === projectId && candidate.variantId === variantId && candidate.status === "RUNNING");
      if (!run) {
        return sendError(reply, { code: "DEMO_RUN_NOT_RUNNING", message: "Start the demo before running the checks.", statusCode: 409 });
      }
      const result = await service.testRunner.run({ ownerUserId: owner, run, variantId, projectId });
      return { testRun: result };
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.get("/api/demo-projects/tests", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const query = parse(testsQuerySchema, request.query, reply);
    if (!query) return reply;
    try {
      const owner = await ownerId(request);
      const selection = await service.selection(owner);
      const runs = await service.testRunner.list(owner, query.projectId ?? selection.projectId, 10);
      const data = runs.map((run) => ({
        id: run.id,
        projectId: run.projectId,
        variantId: run.variantId,
        mode: run.mode,
        status: run.status,
        steps: run.steps.map((step) => ({ ...step })),
        startedAt: run.startedAt,
        finishedAt: run.finishedAt
      }));
      return { data, lastRun: data[0] ?? null };
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  // --- Run-token surface used by the demo process itself -------------------
  app.get("/api/demo-projects/runs/:runId/connector/status", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const params = parse(runParamSchema, request.params, reply);
    if (!params) return reply;
    const run = await service.runTokenTarget(params.runId, runToken(request));
    if (!run) return sendError(reply, { code: "DEMO_RUN_TOKEN_INVALID", message: "The demo run token is invalid or the run is not active.", statusCode: 401 });
    const connections = await service.connections.connectedProviders(run.ownerUserId);
    const counters = await service.operations.countsForRun(run.ownerUserId, run.projectId);
    return {
      mode: run.mode,
      accountsSource: run.mode === "LIVE" ? "salesforce" : "sample",
      sheetsReady: connections.includes("google-sheets"),
      sheetsRowCount: null,
      salesforceInstanceUrl: connections.includes("salesforce") ? "connected" : null,
      sampleData: run.mode !== "LIVE",
      pending: counters.pending,
      failed: counters.failed
    };
  });

  app.get("/api/demo-projects/runs/:runId/connector/accounts", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const params = parse(runParamSchema, request.params, reply);
    if (!params) return reply;
    const run = await service.runTokenTarget(params.runId, runToken(request));
    if (!run) return sendError(reply, { code: "DEMO_RUN_TOKEN_INVALID", message: "The demo run token is invalid or the run is not active.", statusCode: 401 });
    const query = parse(demoAccountsQuerySchema, request.query, reply);
    if (!query) return reply;
    try {
      return await service.operations.listAccounts({
        ownerUserId: run.ownerUserId,
        variantId: run.variantId,
        mode: run.mode,
        search: query.search,
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 25
      });
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.post("/api/demo-projects/runs/:runId/connector/operations", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const params = parse(runParamSchema, request.params, reply);
    if (!params) return reply;
    const run = await service.runTokenTarget(params.runId, runToken(request));
    if (!run) return sendError(reply, { code: "DEMO_RUN_TOKEN_INVALID", message: "The demo run token is invalid or the run is not active.", statusCode: 401 });
    const input = parse(createDemoOperationInputSchema, request.body, reply);
    if (!input) return reply;
    try {
      const result = await service.operations.createOperation({
        ownerUserId: run.ownerUserId,
        projectId: run.projectId,
        variantId: run.variantId,
        mode: run.mode === "LIVE" ? "LIVE" : "SAMPLE",
        operation: input
      });
      return reply.status(result.created ? 201 : 200).send({ operation: result.operation, created: result.created });
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.get("/api/demo-projects/runs/:runId/connector/operations", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const params = parse(runParamSchema, request.params, reply);
    if (!params) return reply;
    const run = await service.runTokenTarget(params.runId, runToken(request));
    if (!run) return sendError(reply, { code: "DEMO_RUN_TOKEN_INVALID", message: "The demo run token is invalid or the run is not active.", statusCode: 401 });
    try {
      return await service.operations.listOperations(run.ownerUserId, { projectId: run.projectId, limit: 50 });
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.post("/api/demo-projects/runs/:runId/connector/operations/:id/retry", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const params = parse(runParamSchema.extend({ id: z.string().trim().min(3).max(120) }), request.params, reply);
    if (!params) return reply;
    const run = await service.runTokenTarget(params.runId, runToken(request));
    if (!run) return sendError(reply, { code: "DEMO_RUN_TOKEN_INVALID", message: "The demo run token is invalid or the run is not active.", statusCode: 401 });
    try {
      const operation = await service.operations.retryOperation(run.ownerUserId, params.id, { attemptNow: true });
      return { operation };
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.delete("/api/demo-projects/runs/:runId/connector/accounts/:accountId", rateLimitOptions, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const params = parse(runParamSchema.extend({ accountId: z.string().trim().min(3).max(120) }), request.params, reply);
    if (!params) return reply;
    const run = await service.runTokenTarget(params.runId, runToken(request));
    if (!run) return sendError(reply, { code: "DEMO_RUN_TOKEN_INVALID", message: "The demo run token is invalid or the run is not active.", statusCode: 401 });
    const body = (request.body ?? {}) as { contactId?: string };
    const contactId = typeof body.contactId === "string" && body.contactId.trim().length > 3 ? body.contactId.trim() : null;
    try {
      await service.operations.deleteAccount({ ownerUserId: run.ownerUserId, accountId: params.accountId, contactId });
      return reply.status(204).send();
    } catch (error) {
      return sendError(reply, service.describeError(error));
    }
  });

  app.get("/api/demo-projects/connections/:provider/callback", { config: { rateLimit: { max: 30, timeWindow: "10 minutes" } } }, async (request, reply) => {
    if (!(await guard(reply))) return reply;
    const params = providerParamSchema.safeParse(request.params);
    const provider = params.success ? params.data.provider : "salesforce";
    const html = demoOAuthPopupHtml(provider, true, null);
    if (!params.success || !request.user) return reply.type("text/html; charset=utf-8").send(demoOAuthPopupHtml(provider, false, "DEMO_OAUTH_SESSION_REQUIRED"));
    const query = oauthCallbackQuerySchema.safeParse(request.query);
    if (!query.success || query.data.error || !query.data.code || !query.data.state) {
      return reply.type("text/html; charset=utf-8").send(demoOAuthPopupHtml(provider, false, query.success ? query.data.error ?? "DEMO_OAUTH_CANCELLED" : "DEMO_OAUTH_INVALID"));
    }
    try {
      await service.connections.completeOAuth({
        provider,
        code: query.data.code,
        state: query.data.state,
        sessionToken: sessionToken(request),
        publicOrigin: resolvePublicOrigin(request)
      });
      return reply.type("text/html; charset=utf-8").send(html);
    } catch (error) {
      const described = service.describeError(error);
      request.log.info({ code: described.code, requestId: request.requestIdForSpace, provider }, "demo projects OAuth callback failed");
      return reply.type("text/html; charset=utf-8").send(demoOAuthPopupHtml(provider, false, described.code));
    }
  });

  // --- Preview gateway -----------------------------------------------------
  app.all("/api/demo-projects/preview/:runId/:token", rateLimitOptions, async (request, reply) => {
    const params = request.params as { runId?: string; token?: string };
    return reply.redirect(`/api/demo-projects/preview/${params.runId ?? ""}/${params.token ?? ""}/`, 307);
  });

  app.all("/api/demo-projects/preview/:runId/:token/*", rateLimitOptions, async (request, reply) => {
    if (request.method.toUpperCase() === "OPTIONS") {
      return reply
        .status(204)
        .headers({
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS"
        })
        .send();
    }
    if (!(await guard(reply))) return reply;
    const params = request.params as { runId?: string; token?: string; "*"?: string };
    const runId = params.runId ?? "";
    const token = params.token ?? "";
    const target = await service.previewTarget(runId, token);
    if (!target || !target.port) {
      return sendError(reply, { code: "DEMO_PREVIEW_UNAVAILABLE", message: "The demo preview is not running.", statusCode: 404 });
    }
    const suffix = request.url.split("/").slice(6).join("/");
    const path = suffix.length > 0 ? `/${suffix}` : "/";
    proxyToDemoRun(request, reply, target.port, path);
    // Returning the reply keeps Fastify from sending an empty response while the
    // proxied stream is still being written.
    return reply;
  });
}

function proxyToDemoRun(request: FastifyRequest, reply: FastifyReply, port: number, path: string): void {
  const method = request.method.toUpperCase();
  const headers: Record<string, string> = {
    host: `127.0.0.1:${port}`,
    accept: typeof request.headers.accept === "string" ? request.headers.accept : "*/*",
    "user-agent": "space-demo-preview"
  };
  if (typeof request.headers["content-type"] === "string") headers["content-type"] = request.headers["content-type"];
  if (typeof request.headers.origin === "string") headers.origin = request.headers.origin;

  let bodyPayload: Buffer | undefined;
  if (request.body !== undefined && method !== "GET" && method !== "HEAD") {
    const bodyStr = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    bodyPayload = Buffer.from(bodyStr);
    headers["content-length"] = String(bodyPayload.byteLength);
  }

  // The demo process is untrusted: hand the stream to Fastify (the proven proxy
  // pattern in this codebase) and never write to the raw reply ourselves, so a
  // hostile or half-dead upstream can only fail its own request.
  let settled = false;
  const fail = (): void => {
    if (settled || reply.sent) return;
    settled = true;
    void reply.status(502).send({
      error: {
        code: "DEMO_PREVIEW_UNREACHABLE",
        message: "The demo preview did not answer.",
        requestId: request.requestIdForSpace
      }
    });
  };

  const upstream = httpRequest(
    { host: "127.0.0.1", port, method, path, headers, timeout: 15_000 },
    (response) => {
      if (settled || reply.sent) {
        response.destroy();
        return;
      }
      settled = true;
      const responseHeaders: Record<string, string> = {
        "cache-control": "no-store",
        "x-frame-options": "SAMEORIGIN",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'self' 'unsafe-inline' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
        "cross-origin-resource-policy": "cross-origin"
      };
      const contentType = response.headers["content-type"];
      if (typeof contentType === "string") responseHeaders["content-type"] = contentType;
      const status = response.statusCode ?? 502;
      if (status === 204 || status === 304) {
        response.resume();
        void reply.status(status).headers(responseHeaders).send();
        return;
      }
      void reply.status(status).headers(responseHeaders).send(response);
    }
  );
  upstream.once("timeout", () => upstream.destroy(new Error("DEMO_PREVIEW_TIMEOUT")));
  upstream.once("error", fail);
  // Note: ServerResponse 'close' fires before the reply is written in this
  // stack, so client aborts are handled by Fastify plus the upstream timeout.

  try {
    if (bodyPayload) {
      upstream.write(bodyPayload);
    }
    upstream.end();
  } catch {
    fail();
  }
}
