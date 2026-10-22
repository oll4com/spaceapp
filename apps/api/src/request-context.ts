import "fastify";
import type { RequestTraceContext } from "./trace-context.js";

declare module "fastify" {
  interface FastifyRequest {
    requestIdForSpace: string;
    /** W3C trace context of this request (inbound traceparent or generated). */
    traceContext: RequestTraceContext;
    /** The signed session's own id when the API acts for it as another user (an agent's user:operator-proof session). */
    sessionPrincipal?: string;
    user: {
      id: string;
      email: string;
      role: "OPERATOR" | "ADMIN" | "USER";
      googleId?: string | null;
      avatarUrl?: string | null;
      proofScope?: "READ_ONLY";
      automationScope?: "APP_DIAGNOSTICS";
      brokerScope?: string;
    } | null;
  }
}

