import type {} from "./request-context.js";
import type { FastifyInstance } from "fastify";
import { publicWaitlistRequestSchema, publicWaitlistResponseSchema } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { sendApiError } from "./http-errors.js";
import { parseBody } from "./route-parsing.js";

const publicWaitlistBodyLimitBytes = 2 * 1024;

/** The public waitlist (optional module "waitlist"): one e-mail per signup, a honeypot field, 5 an hour per client. */
export function registerPublicWaitlistRoute(app: FastifyInstance, options: { store: SpaceStore }) {
  const { store } = options;
  app.post(
    "/api/public/waitlist",
    {
      bodyLimit: publicWaitlistBodyLimitBytes,
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } }
    },
    async (request, reply) => {
      const input = parseBody(publicWaitlistRequestSchema, request.body);
      let outcome: "CREATED" | "DUPLICATE" | "HONEYPOT";
      if (input.website) {
        outcome = "HONEYPOT";
      } else {
        try {
          outcome = await store.upsertPublicWaitlistSignup({ email: input.email, source: input.source });
        } catch {
          request.log.warn(
            { event: "public.waitlist.submission", outcome: "FAILED" },
            "Public waitlist submission failed."
          );
          return sendApiError(reply, 500, "INTERNAL_ERROR", "The request could not be completed.");
        }
      }
      request.log.info(
        { event: "public.waitlist.submission", outcome },
        "Public waitlist submission accepted."
      );
      return reply.status(202).send(publicWaitlistResponseSchema.parse({ status: "ACCEPTED" }));
    }
  );
}
