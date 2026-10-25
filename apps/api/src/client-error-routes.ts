import type {} from "./request-context.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

/**
 * A browser error as the web client reports it: the error name and where in the
 * bundle it was thrown. Messages, URLs with queries, and any other text are not
 * accepted, so a report can never carry what the user typed or saw.
 */
export const clientErrorReportSchema = z.object({
  kind: z.enum(["error", "rejection"]),
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.$]{0,63}$/),
  locations: z.array(z.object({
    file: z.string().max(160).regex(/^\/[A-Za-z0-9/_.@-]*$/),
    line: z.number().int().min(1).max(10_000_000),
    column: z.number().int().min(1).max(10_000_000).optional()
  }).strict()).max(5),
  repeats: z.number().int().min(1).max(1_000).default(1)
}).strict();

export type ClientErrorReport = z.infer<typeof clientErrorReportSchema>;

/** Per user/IP: a page that throws in a loop is cut off long before it fills the journal. */
export const clientErrorRouteRateLimit = { max: 30, timeWindow: "1 minute" } as const;

/** Authenticated users only; the composition root installs authentication and CSRF. */
export function registerClientErrorRoutes(app: FastifyInstance) {
  app.post("/api/client-errors", { config: { rateLimit: clientErrorRouteRateLimit } }, async (request, reply) => {
    const report = clientErrorReportSchema.parse(request.body);
    request.log.warn({ event: "client.error", ...report, role: request.user?.role ?? null }, "Browser error reported.");
    return reply.code(204).send();
  });
}
