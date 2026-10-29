import { z } from "zod";

/**
 * The scope the root-owned auth broker (deploy/space-auth-broker) signs into an agent's short-lived operator session
 * (hardening plan clipboard:sFj1wGEY473i step 4): the broker refuses a request without one, and the API refuses every
 * route the scope does not cover. `ADMIN_ACTION:<name>` is one `scripts/space-admin-action.mjs` action and reaches only
 * that action's routes below; `UI_PROOF` (authenticated proofs and agent tooling that drives the app) is a full UI
 * session without the operator-only routes in `uiProofDeniedRoutes`.
 */
export const brokerScopeSchema = z.string().regex(/^(?:UI_PROOF|ADMIN_ACTION:[a-z0-9][a-z0-9-]{0,47})$/);
export type BrokerScope = z.infer<typeof brokerScopeSchema>;

// "METHOD /path": `:name` is one path segment; `?k=v` requires that query value; any other query is ignored.
const copilot = (name: string) => ({
  [`${name}-room-create`]: ["POST /api/rooms"],
  [`${name}-pane-open`]: ["POST /api/rooms/:room/panes"],
  [`${name}-cli-start`]: ["POST /api/panes/:pane/cli/session"],
  [`${name}-brief`]: [`POST /api/panes/:pane/${name}-copilot/briefs`],
  [`${name}-run`]: [`POST /api/panes/:pane/${name}-copilot/run/:action`],
  [`${name}-state`]: [`GET /api/panes/:pane/${name}-copilot/run`],
  [`${name}-read`]: [`GET /api/panes/:pane/${name}-copilot/settings`, `GET /api/${name}-copilot/:view`],
  [`${name}-events`]: [`GET /api/${name}-copilot/events`],
  [`${name}-memory`]: [`POST /api/${name}-copilot/memory`]
});
const gatewayKeyRotation = ["GET /api/admin/gateway/keys", "POST /api/admin/gateway/keys", "PATCH /api/admin/gateway/keys/:key", "POST /api/admin/gateway/keys/:key/regenerate"];

/** Every space-admin-action action and the only routes its session may call (plus GET /api/auth/csrf). */
export const adminActionRoutes: Readonly<Record<string, readonly string[]>> = {
  "gateway-account-test": ["POST /api/admin/gateway/accounts/:account/test"],
  "gateway-settings": ["PATCH /api/admin/gateway/settings"],
  "gateway-key-models": ["PATCH /api/admin/gateway/keys/:key"],
  "memory-embedding-smoke": ["POST /api/admin/memory/embedding-smoke"],
  "memory-embedding-status": ["GET /api/admin/memory/embedding-status"],
  "memory-search": ["GET /api/memory"],
  "gateway-status": ["GET /api/admin/gateway/status"],
  "gateway-keys": ["GET /api/admin/gateway/keys"],
  "gateway-accounts": ["GET /api/admin/gateway/accounts"],
  "gateway-logs": ["GET /api/admin/gateway/logs"],
  "gateway-claude-api-key": ["GET /api/admin/gateway/claude-api-key"],
  "gateway-anthropic-billing": ["GET /api/admin/gateway/anthropic-billing"],
  "claude-usage-accounts": ["GET /api/admin/claude-usage-accounts"],
  "token-usage": ["GET /api/admin/system-analytics/models"],
  "gateway-report": ["GET /api/admin/gateway/reports"],
  "live-history": ["GET /api/live/history"],
  "live-settings": ["GET /api/user-settings"],
  "live-personal-memory": ["GET /api/live/personal-memory"],
  "live-personal-memory-save": ["POST /api/live/personal-memory"],
  "live-personal-memory-delete": ["DELETE /api/live/personal-memory/:key"],
  "job-apply-run": ["GET /api/panes/:pane/job-apply/run"],
  "job-apply-photo-from-cv": ["POST /api/job-apply/profile/photo-from-cv"],
  "job-apply-events": ["GET /api/job-apply/events"],
  "job-apply-applications": ["GET /api/job-apply/applications"],
  "job-apply-settings": ["GET /api/panes", "GET /api/panes/:pane/job-apply/settings", "PUT /api/panes/:pane/job-apply/settings"],
  "mail-copilot-habits": ["GET /api/mail-copilot/habits"],
  "mail-copilot-actions": ["GET /api/mail-copilot/actions"],
  "mail-copilot-events": ["GET /api/mail-copilot/events"],
  "plan-create": ["POST /api/clipboard-items"],
  "plan-list": ["GET /api/clipboard-items"],
  "plan-progress": ["PATCH /api/clipboard-items/:item/progress"],
  clipboard: ["GET /api/clipboard-items", "POST /api/clipboard-items", "PATCH /api/clipboard-items/:item", "PATCH /api/clipboard-items/:item/progress", "DELETE /api/clipboard-items/:item"],
  "push-device-register": ["POST /api/notifications/push-devices"],
  "push-device-remove": ["DELETE /api/notifications/push-devices"],
  "notification-test": ["POST /api/notifications/test"],
  control: ["POST /api/control/v1/mcp", "GET /api/rooms"],
  "release-train": ["POST /api/release-trains"],
  "room-agent-events": ["GET /api/rooms/:room/room-agent/events"],
  "nous-pane-board": ["GET /api/nous/pane-board"],
  "nous-turn-costs": ["GET /api/nous/turn-costs"],
  "vault-broker-reinstall": ["POST /api/nous/decisions/vault-broker-reinstall"],
  "proof-room-create": ["POST /api/proof-rooms"],
  "proof-room-agent": ["GET /api/rooms", "GET /api/rooms/:room/room-agent"],
  "proof-room-delete": ["DELETE /api/rooms/:room?kind=AGENT_PROOF"],
  "cli-runtime-enable": ["PATCH /api/cli/runtime-settings/:runtime"],
  "cli-runtime-disable-preview": ["POST /api/cli/runtime-settings/:runtime/disable-preview"],
  "cli-runtime-disable": ["PATCH /api/cli/runtime-settings/:runtime"],
  "configuration-export": ["POST /api/configuration/export"],
  "council-models": ["GET /api/council/models"],
  "council-runs": ["GET /api/council/runs"],
  "council-run": ["GET /api/council/runs/:run"],
  "council-start": ["POST /api/council/runs"],
  "council-action": ["POST /api/council/runs/:run/:action"],
  "nous-state": ["GET /api/nous"],
  "nous-decisions": ["GET /api/nous/decisions"],
  "nous-messages": ["GET /api/nous/messages"],
  "nous-progress": ["GET /api/nous/progress"],
  "nous-failures": ["GET /api/nous/progress"],
  "nous-attachment-check": ["POST /api/nous/attachments", "GET /api/nous/attachments/:attachment", "DELETE /api/nous/attachments/:attachment"],
  "nous-ask": ["POST /api/nous/messages"],
  "streaming-bot-key-update": ["PATCH /api/admin/gateway/keys/:key"],
  "claude-api-cli-key": ["GET /api/admin/gateway/claude-api-key", "POST /api/admin/gateway/keys"],
  "summary-tools-key": ["GET /api/admin/gateway/accounts", ...gatewayKeyRotation],
  "memory-audit-key": ["GET /api/admin/gateway/accounts", ...gatewayKeyRotation],
  "design-key": gatewayKeyRotation,
  "opencode-claude-provider-enable": ["PATCH /api/cli/providers/:provider"],
  "lab-gateway-key": ["POST /api/admin/gateway/keys"],
  "lab-codex-key": ["GET /api/admin/gateway/accounts", ...gatewayKeyRotation],
  "gateway-key-create": ["GET /api/admin/gateway/keys", "GET /api/admin/gateway/accounts", "POST /api/admin/gateway/keys"],
  "lab-gateway-key-disable": ["GET /api/admin/gateway/keys", "PATCH /api/admin/gateway/keys/:key"],
  "streaming-bot-status": ["GET /api/admin/streaming/bot/status"],
  "streaming-catalog": ["GET /api/admin/streaming/catalog"],
  "streaming-account-verify": ["POST /api/admin/streaming/accounts/:account/verify"],
  "streaming-oauth-start": ["POST /api/admin/streaming/providers/:provider/oauth/start"],
  "streaming-moderation": ["GET /api/admin/streaming/bot/moderation"],
  "streaming-bot-test": ["POST /api/admin/streaming/bot/test"],
  "streaming-bot-key": ["POST /api/admin/gateway/keys"],
  "freelance-mailbox-connect": ["PUT /api/freelance-copilot/mailbox"],
  "rooms-list": ["GET /api/rooms", "GET /api/panes"],
  ...copilot("freelance"),
  ...copilot("marketing"),
  "marketing-campaign": ["POST /api/panes/:pane/marketing-copilot/campaigns"],
  "marketing-bookmark-delete": ["DELETE /api/marketing-copilot/bookmarks/:id"],
  "freelance-account": ["POST /api/freelance-copilot/accounts"],
  "freelance-browser-private": ["PUT /api/panes/:pane/browser/accounts"],
  "user-appearance": ["PATCH /api/user-settings"],
  "user-appearance-get": ["GET /api/user-settings"],
  "notifications-pending": ["GET /api/notifications/pending"],
  "vault-broker-audit": ["GET /api/space-vault/broker-audit"],
  "notifications-list": ["GET /api/notifications"],
  "browser-handoff": ["GET /api/panes/:pane/browser/handoff"],
  "browser-census": ["GET /api/admin/browser-census"],
  "video-tools-status": ["GET /api/video/tools"]
};

/**
 * Operator-only routes a UI_PROOF session never reaches (prefix match, any method unless one is named): the Vault,
 * user accounts, configuration bundles with credentials, releases (promote, hotfix approval), release trains, gateway
 * keys and settings, Google sign-in configuration, signing out every session, and First Setup's Live provider keys.
 */
export const uiProofDeniedRoutes: readonly string[] = [
  // The app reads the user list on start (an ADMIN's Settings), so only user changes are refused.
  "* /api/space-vault", "POST /api/admin/users", "PATCH /api/admin/users", "DELETE /api/admin/users",
  "* /api/configuration/export", "POST /api/configuration/import", "POST /api/admin/releases", "* /api/release-trains",
  "POST /api/admin/gateway/keys", "PATCH /api/admin/gateway/keys", "DELETE /api/admin/gateway/keys", "PATCH /api/admin/gateway/settings",
  "PUT /api/admin/gateway", "POST /api/auth/google/configure", "POST /api/auth/logout-all", "POST /api/setup/voice/credentials"
];

const alwaysAllowed = new Set(["GET /api/auth/csrf"]);

// A pattern's `:name` matches a route parameter or a concrete segment; its literal segments match only themselves, never a
// route parameter or wildcard.
function matches(pattern: string, method: string, path: string, query: URLSearchParams): boolean {
  const [patternMethod, target] = pattern.split(" ", 2) as [string, string];
  if (patternMethod !== method) return false;
  const [patternPath, required] = target.split("?", 2) as [string, string | undefined];
  const want = patternPath.split("/");
  const have = path.split("/");
  if (want.length !== have.length || want.some((part, index) => {
    const segment = have[index]!;
    if (!part.startsWith(":")) return part !== segment;
    return !segment || segment === "*" || /^(?:\.|%2e){1,2}$/i.test(segment);
  })) return false;
  return [...new URLSearchParams(required ?? "")].every(([key, value]) => query.get(key) === value);
}

/**
 * Whether a session signed with this broker scope may call `METHOD path?query`. The API passes the route the router
 * matched (`request.routeOptions.url`, e.g. /api/panes/:id/cli/session) and the parsed query, never the raw URL: the
 * router decodes %XX and stops at #, so a raw-URL check could be steered around (security review 2026-10-19).
 */
export function brokerScopeAllows(scope: string, method: string, url: string): boolean {
  const upper = method.toUpperCase();
  const [rawPath = "", search = ""] = url.split("?", 2);
  const path = rawPath.replace(/\/+$/, "") || "/";
  if (alwaysAllowed.has(`${upper} ${path}`)) return true;
  if (scope === "UI_PROOF") {
    return !uiProofDeniedRoutes.some((entry) => {
      const [deniedMethod, prefix] = entry.split(" ", 2) as [string, string];
      return (deniedMethod === "*" || deniedMethod === upper) && (path === prefix || path.startsWith(`${prefix}/`));
    });
  }
  const action = /^ADMIN_ACTION:([a-z0-9-]+)$/.exec(scope)?.[1];
  const routes = action && Object.hasOwn(adminActionRoutes, action) ? adminActionRoutes[action] : undefined;
  if (!routes) return false;
  const query = new URLSearchParams(search);
  return routes.some((pattern) => matches(pattern, upper, path, query));
}
