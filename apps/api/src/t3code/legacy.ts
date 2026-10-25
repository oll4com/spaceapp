import type { FastifyInstance } from "fastify";

// The former in-memory supervision simulator (static sessions, fake approval
// completion, demo seeding) is retired. Its routes answer 410 so stale clients
// fail visibly instead of receiving synthetic agent state.
export const T3CODE_LEGACY_ROUTES = [
  { method: "GET", url: "/api/t3code/sessions" },
  { method: "GET", url: "/api/t3code/panes/:paneId/state" },
  { method: "PATCH", url: "/api/t3code/panes/:paneId/policies" },
  { method: "POST", url: "/api/t3code/panes/:paneId/attach" },
  { method: "GET", url: "/api/t3code/panes/:paneId/events" },
  { method: "POST", url: "/api/t3code/panes/:paneId/events" },
  { method: "DELETE", url: "/api/t3code/panes/:paneId/events" },
  { method: "GET", url: "/api/t3code/panes/:paneId/approvals" },
  { method: "POST", url: "/api/t3code/panes/:paneId/approvals/:approvalId/decision" },
  { method: "POST", url: "/api/t3code/panes/:paneId/seed-demo" }
] as const;

export async function registerT3LegacyRetirement(app: FastifyInstance) {
  // Encapsulated: no hook or parser here can affect unrelated Space routes,
  // whatever the T3 feature flag says.
  await app.register(async (child) => {
    for (const route of T3CODE_LEGACY_ROUTES) {
      child.route({
        method: route.method,
        url: route.url,
        handler: async (_request, reply) => reply.code(410).header("cache-control", "no-store").send({
          error: {
            code: "T3CODE_LEGACY_API_RETIRED",
            message: "The T3 Code supervision API was retired. Open the T3 Code pane to use the managed T3 Code application."
          }
        })
      });
    }
  });
}
