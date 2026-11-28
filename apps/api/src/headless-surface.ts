import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// K2 §3 (plan clipboard:ZGz1LnD51ELH step 7): a headless (Nous Computer) control plane serves only these routes, by the router's own
// pattern. Every other route keeps its path but loses its handler, schema and route hooks to the not-found handler, so none of its code
// runs, and a new route is off until it is added here (reviewed; guard: tests/headless-surface.test.ts). Self-hosted is unchanged.
// The routes K2 §3.2 names that are not built yet (account export and usage, billing, connect, computer) join when they are.
type HeadlessRule = true | { query: Record<string, string> };
export const HEADLESS_ROUTES: Readonly<Record<string, HeadlessRule>> = {
  // health (load balancer)
  "GET /healthz": true, "GET /readyz": true,
  // auth-public, auth-app, devices (sign-in by Google, the app handoff, the device list)
  "GET /api/auth/me": true, "GET /api/auth/csrf": true, "POST /api/auth/logout": true, "GET /api/auth/google/start": true,
  "GET /api/auth/google/callback": true, "POST /api/auth/app-handoff": true, "GET /api/auth/devices": true, "POST /api/auth/devices/:id/revoke": true,
  // nous (no pane board: the user's VM has no rooms of panes)
  "GET /api/nous": true, "GET /api/nous/messages": true, "GET /api/nous/messages/operator-index": true, "GET /api/nous/attachments/:id": true,
  "GET /api/nous/decisions": true, "GET /api/nous/decisions/:id/files": true, "GET /api/nous/overview": true, "GET /api/nous/progress": true,
  "GET /api/nous/goals": true, "GET /api/nous/goals/:id/history": true, "GET /api/nous/requests": true, "GET /api/nous/shared-files": true,
  "POST /api/nous/messages": true, "POST /api/nous/stop": true, "PUT /api/nous/read-mark": true, "POST /api/nous/attachments": true, "POST /api/nous/goals": true,
  "POST /api/nous/goals/reorder": true, "POST /api/nous/decisions/:id/answer": true, "POST /api/nous/decisions/:id/feedback": true,
  "POST /api/nous/away": true, "PATCH /api/nous/goals/:id": true, "DELETE /api/nous/goals/:id": true, "PATCH /api/nous/settings": true,
  "DELETE /api/nous/messages": true, "DELETE /api/nous/attachments/:id": true, "DELETE /api/nous/shared-files/:shareId": true,
  // nous turn MCP: a cell's turn calls it through its relay with the turn's token (mcp.ts cellProven); GET only answers 405
  "POST /api/cli/nous/mcp": true, "GET /api/cli/nous/mcp": true,
  // notifications
  "GET /api/notifications": true, "GET /api/notifications/pending": true, "GET /api/notifications/:id": true,
  "POST /api/notifications/:id/answer": true, "POST /api/notifications/:id/read": true, "POST /api/notifications/:id/ack": true,
  "POST /api/notifications/read-all": true,
  // tasks-runs, plans-read, agent-files
  "GET /api/tasks/runs": true,
  "GET /api/clipboard-items": { query: { source: "PLAN" } },
  "GET /api/artifacts": { query: { collection: "AGENT_FILES" } },
  "GET /api/artifacts/:id/preview": true, "GET /api/artifacts/:id/file": true, "GET /api/artifacts/:id/metadata": true,
  // account (K4), mobile-channel
  "GET /api/account": true, "DELETE /api/account": true, "POST /api/account/deletion/cancel": true,
  "GET /api/account/ai": true, "PUT /api/account/ai": true, "DELETE /api/account/ai": true,
  "GET /api/mobile/channel": true
};

const ROUTE_HOOKS = ["onRequest", "preParsing", "preValidation", "preHandler", "preSerialization", "onSend", "onResponse", "onTimeout", "onError"] as const;
const disabledHeadlessRoute = async (_request: FastifyRequest, reply: FastifyReply) => reply.callNotFound();

/** Called on the app before any route registers: onRoute sees only later routes. */
export function restrictToHeadlessSurface(app: FastifyInstance) {
  app.addHook("onRoute", (route) => {
    const keys = [route.method].flat().map((method) => `${method === "HEAD" ? "GET" : method} ${route.url}`);
    const rules = keys.map((key) => HEADLESS_ROUTES[key]);
    if (rules.every(Boolean)) {
      const query = rules.find((rule): rule is { query: Record<string, string> } => rule !== true)?.query;
      if (query) {
        const only = async (request: FastifyRequest, reply: FastifyReply) => {
          const asked = request.query as Record<string, unknown>;
          if (Object.entries(query).some(([name, value]) => asked?.[name] !== value)) return reply.callNotFound();
        };
        route.onRequest = [only, ...[route.onRequest ?? []].flat()];
      }
      return;
    }
    const disabled = route as unknown as Record<string, unknown>;
    for (const hook of ROUTE_HOOKS) delete disabled[hook];
    delete disabled.schema;
    delete disabled.wsHandler;
    disabled.websocket = false;
    route.handler = disabledHeadlessRoute;
  });
}
