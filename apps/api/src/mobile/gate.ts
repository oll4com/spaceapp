import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { NOUS_CLIENT_HEADER, mobileAppUpdateRequired, mobileBodyProblem, mobileRouteAllows, parseNousClientHeader } from "@space/contracts";
import type { MobileChecks } from "./checks.js";
import { cookieName, signedSessionPayload } from "../auth.js";
import { sendApiError } from "../http-errors.js";
import { headerString, secureTokenMatches } from "../request-helpers.js";

// The mobile gate (plan clipboard:kTV3y2lwO-99 phase 1b, ADR-013 §5-7, design §6.1): a request carrying a phone's channel session runs only
// with this process's secret header (so a leaked token is useless outside the API) and only on the routes MOBILE_ROUTE_SCOPES lists for its
// scopes, matched on the router's own pattern. Root hooks run for every route, plugins too; mobile-gate.test.ts checks each registered one.

export const MOBILE_INVOKE_HEADER = "x-space-mobile-invoke";
const secrets = new WeakMap<FastifyInstance, string>();
/** The in-process secret the channel sends with every request it injects (1b-5). */
export const mobileInvokeSecret = (app: FastifyInstance) => secrets.get(app);
const checks = new WeakMap<FastifyInstance, MobileChecks>();
/** The per-request checks (checks.ts); without them the routes that need one stay refused. */
export const setMobileChecks = (app: FastifyInstance, check: MobileChecks) => { checks.set(app, check); };

const UPDATE_ROUTES = new Set(["GET /api/artifacts", "GET /api/artifacts/:id/file"]);

export function installMobileGate(app: FastifyInstance, options: { sessionSecret: string }) {
  const secret = randomBytes(32).toString("base64url");
  secrets.set(app, secret);
  app.addHook("onRequest", async (request, reply) => {
    const mobile = signedSessionPayload(request.cookies[cookieName], options.sessionSecret)?.mobile;
    if (!mobile) return;
    if (!secureTokenMatches(secret, request.headers[MOBILE_INVOKE_HEADER])) return sendApiError(reply, 401, "MOBILE_INVOKE", "A phone reaches SpaceApp only through its channel.");
    // The auth hook ran first: no user means the token expired or its device was revoked.
    if (!request.user) return sendApiError(reply, 401, "MOBILE_SESSION", "This phone's session ended; it reconnects.");
    const rule = mobileRouteAllows(mobile.scopes, request.method, request.routeOptions.url, request.query as Record<string, unknown>);
    if (!rule) return sendApiError(reply, 403, "MOBILE_SCOPE_DENIED", "A phone cannot do this; use SpaceApp on a computer.");
    request.mobileDevice = { id: mobile.device, scopes: mobile.scopes, person: rule.person === true, rule };
    request.user.mobile = { device: mobile.device, person: rule.person === true };
  });
  // CODE-2 update floor (MASVS L2, mobileAppUpdateRequired): an app session (Google sign-in or channel) whose X-Space-Client names a
  // version below the floor gets 426, except the auth routes and the two its own update needs (list Agent Files, download the APK).
  // A request without a version passes: the header only describes, and a modified app could lie anyway; the channel checks the
  // version its hello and pair request carry.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.appSession) return;
    const version = parseNousClientHeader(headerString(request.headers[NOUS_CLIENT_HEADER])).version;
    const update = version ? mobileAppUpdateRequired(request.appSession, version) : null;
    const route = `${request.method} ${request.routeOptions.url ?? ""}`;
    if (!update || UPDATE_ROUTES.has(route) || request.url.startsWith("/api/auth/")) return;
    return sendApiError(reply, 426, update.code, `Update the Nous app to ${update.minVersion} or newer.`, { minVersion: update.minVersion, minVersionCode: update.minVersionCode });
  });
  // Body rules on the object the handler reads (the channel also checks and re-serializes before injecting, security review P2-3).
  app.addHook("preHandler", async (request, reply) => {
    const rule = request.mobileDevice?.rule;
    const problem = rule?.body ? mobileBodyProblem(rule.body, request.body) : null;
    if (problem) return sendApiError(reply, 400, "MOBILE_BODY", problem);
    if (rule?.artifactById || rule?.askRisk || rule?.decisionSignature || rule?.goalSignature || rule?.adminSignature) {
      const check = checks.get(app);
      const refused = check ? await check(request, rule) : { status: 403, code: "MOBILE_SCOPE_DENIED", message: "Open this on a computer." };
      if (refused) return sendApiError(reply, refused.status, refused.code, refused.message);
    }
  });
}
