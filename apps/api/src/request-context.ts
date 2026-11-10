import "fastify";
import type { RequestTraceContext } from "./trace-context.js";

declare module "fastify" {
  interface FastifyRequest {
    requestIdForSpace: string;
    /** W3C trace context of this request (inbound traceparent or generated). */
    traceContext: RequestTraceContext;
    /** The signed session's own id when the API acts for it as another user (an agent's user:operator-proof session). */
    sessionPrincipal?: string;
    /** The mobile app whose device session this request carries (the session's `app` claim, app-signin.ts). */
    appSession?: string;
    /** A paired phone's request through the mobile channel, set only by the mobile gate after the in-process secret matched (ADR-013). */
    mobileDevice?: { id: string; scopes: string[]; person: boolean; rule: import("@space/contracts").MobileRouteRule };
    user: {
      id: string;
      email: string;
      role: "OPERATOR" | "ADMIN" | "USER";
      googleId?: string | null;
      avatarUrl?: string | null;
      proofScope?: "READ_ONLY";
      automationScope?: "APP_DIAGNOSTICS";
      brokerScope?: string;
      /** A phone: the operator in person only on the routes MOBILE_ROUTE_SCOPES marks `person` (Nous Pro security review P0-1). */
      mobile?: { device: string; person: boolean };
    } | null;
  }
}

