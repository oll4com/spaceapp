/** Browser Host actor identities shared by the API route domains (moved verbatim from the composition root). */
import type {} from "./request-context.js";
import type { FastifyRequest } from "fastify";
import type { BrowserHostActorContext } from "@space/browser-host";

export function operatorBrowserActor(request: FastifyRequest): BrowserHostActorContext {
  return { holderType: "OPERATOR", holderId: request.user?.id ?? "operator:unknown" };
}
