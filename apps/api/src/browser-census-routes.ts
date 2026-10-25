import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import type { BrowserControlLease, PaneBrowserSession } from "@space/contracts";
import { redactMemoryText, type SpaceStore } from "@space/runtime";
import type { BrowserSessionManager } from "./browser-sessions.js";
import { sendApiError } from "./http-errors.js";
import { vaultFencedTargets } from "./vault/fence-hooks.js";
import { freelanceProfileKey, youtubeAccountProfileKey } from "./youtube-accounts.js";

type CensusStore = Pick<SpaceStore, "listActivePaneBrowserSessions" | "getPane" | "getActiveBrowserControlLease" | "getActiveBrowserHandoffRequest"
  | "getRoom" | "listGoogleAccounts" | "listCliAccountProfiles">;
/** The Gemini accounts' emails Space already reads for the pane account menu (its cached identity reader). */
type GeminiEmails = (profileIds: string[]) => Promise<Map<string, string | null>>;

/** Which Chrome a session runs in, as the census script matches it against `--user-data-dir`. */
export function browserProfileLabel(profilePath: string): string {
  const parts = profilePath.split("/");
  const at = (name: string) => parts.lastIndexOf(name);
  if (at("cli-accounts") >= 0) return `cli-accounts/${parts[at("cli-accounts") + 1]?.slice(0, 12) ?? ""}`;
  if (at("google-accounts") >= 0) return `google-accounts/${parts.slice(at("google-accounts") + 1).map((part) => part.slice(0, 8)).join("/")}`;
  return /^room_[^/]+\/pane_[^/]+$/.test(parts.slice(-2).join("/")) ? "pane" : "other";
}

/**
 * The account a session's Chrome is signed in as, from the API's own records only: the selected Google account's email
 * (`google-account:<id>`), or the email of the Gemini or Google account whose shared or Freelance profile key it carries
 * (`cli-account:<key>`). A pane's own profile has none. Never reads Chrome profile files or cookies.
 */
async function accountEmailResolver(store: CensusStore, geminiEmails: GeminiEmails | undefined) {
  const owners = new Map<string, Promise<Map<string, string | null>>>();
  const keysFor = (owner: string) => {
    let known = owners.get(owner);
    if (!known) {
      known = (async () => {
        const keys = new Map<string, string | null>();
        const google = await Promise.resolve(store.listGoogleAccounts(owner)).catch(() => []);
        for (const account of google) keys.set(freelanceProfileKey(owner, account.id), account.email);
        const gemini = await Promise.resolve(store.listCliAccountProfiles("cli:gemini")).catch(() => []);
        const emails = gemini.length && geminiEmails ? await geminiEmails(gemini.map((profile) => profile.profileId)).catch(() => new Map()) : new Map();
        for (const { profileId } of gemini) {
          const email = emails.get(profileId) ?? null;
          keys.set(freelanceProfileKey(owner, profileId), email);
          try { keys.set(youtubeAccountProfileKey(owner, profileId)!, email); } catch { /* not a valid profile id */ }
        }
        return keys;
      })();
      owners.set(owner, known);
    }
    return known;
  };
  return async (session: PaneBrowserSession): Promise<string | null> => {
    const owner = await Promise.resolve(store.getRoom(session.roomId)).then((room) => room.ownerUserId ?? null).catch(() => null);
    if (!owner) return null;
    if (session.profileId.startsWith("google-account:")) {
      const accountId = session.profileId.slice("google-account:".length);
      return (await Promise.resolve(store.listGoogleAccounts(owner)).catch(() => [])).find((account) => account.id === accountId)?.email ?? null;
    }
    if (session.profileId.startsWith("cli-account:")) return (await keysFor(owner)).get(session.profileId.slice("cli-account:".length)) ?? null;
    return null;
  };
}

const origin = (url: string | null) => {
  if (!url) return null;
  try { const parsed = new URL(url); return parsed.protocol.startsWith("http") ? `${parsed.origin}${parsed.pathname}` : parsed.protocol; } catch { return null; }
};

/**
 * Read only: the API's own records of every live pane browser (no Browser Host call, nothing started, attached or
 * navigated). A tab a Vault or handoff fence covers shows neither title nor address.
 */
export async function browserCensus(deps: {
  store: CensusStore;
  capacity?: () => unknown;
  operatorIdleMs?: (lease: Pick<BrowserControlLease, "leaseId" | "acquiredAt">) => number;
  fencedTargets?: (paneId: string) => Promise<string[]>;
  geminiEmails?: GeminiEmails;
}) {
  const sessions: PaneBrowserSession[] = await deps.store.listActivePaneBrowserSessions();
  const accountEmailOf = await accountEmailResolver(deps.store, deps.geminiEmails);
  const fenced = deps.fencedTargets ?? (async (paneId: string) => vaultFencedTargets(deps.store, paneId));
  const rows = await Promise.all(sessions.map(async (session) => {
    const [pane, lease, handoff, fence, accountEmail] = await Promise.all([
      Promise.resolve(deps.store.getPane(session.paneId)).catch(() => null),
      Promise.resolve(deps.store.getActiveBrowserControlLease(session.sessionId)).catch(() => null),
      Promise.resolve(deps.store.getActiveBrowserHandoffRequest(session.sessionId)).catch(() => null),
      fenced(session.paneId),
      accountEmailOf(session).catch(() => null)
    ]);
    const fencedTabs = new Set(fence);
    return {
      paneId: session.paneId,
      roomId: session.roomId,
      paneName: pane?.paneName ?? null,
      title: pane?.title ?? null,
      mode: pane?.mode ?? null,
      paneClosed: pane?.isClosed ?? null,
      profile: browserProfileLabel(session.profilePath),
      accountEmail,
      status: session.status,
      runtimeState: session.runtimeState,
      capacityState: session.capacityState,
      controlState: session.controlState,
      control: lease ? {
        holderType: lease.holderType, heartbeatAt: lease.heartbeatAt,
        operatorIdleSeconds: lease.holderType === "OPERATOR" && deps.operatorIdleMs ? Math.round(deps.operatorIdleMs(lease) / 1000) : null
      } : null,
      handoff: handoff ? { status: handoff.status, requestedAt: handoff.requestedAt } : null,
      fencedTabs: fencedTabs.size,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      lastFrameAt: session.lastFrameAt,
      tabs: session.pages.map((page) => fencedTabs.has(page.pageId)
        ? { fenced: true, isActive: page.isActive }
        : {
            title: page.title ? redactMemoryText(page.title).slice(0, 120) : null,
            url: origin(page.url),
            isActive: page.isActive,
            ...(page.account ? { account: page.account.label ?? page.account.profileId } : {})
          })
    };
  }));
  return { capacity: deps.capacity?.() ?? null, sessions: rows, totalTabs: rows.reduce((sum, row) => sum + row.tabs.length, 0) };
}

export function registerBrowserCensusRoutes(app: FastifyInstance, options: {
  store: CensusStore;
  browserSessionManager: Pick<BrowserSessionManager, "status">;
  controlActivity: { idleMs(lease: Pick<BrowserControlLease, "leaseId" | "acquiredAt">): number };
  geminiEmails?: GeminiEmails;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  app.get("/api/admin/browser-census", options.routeOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Administrator permissions are required.");
    return browserCensus({
      store: options.store,
      capacity: () => options.browserSessionManager.status().capacity ?? null,
      operatorIdleMs: (lease) => options.controlActivity.idleMs(lease),
      geminiEmails: options.geminiEmails
    });
  });
}
