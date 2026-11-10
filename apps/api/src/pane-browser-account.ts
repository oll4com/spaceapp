/** The Google account and profile a browser/YouTube pane opens with (moved verbatim from the composition root). */
import type { BrowserHostActorContext } from "@space/browser-host";
import type { Pane } from "@space/contracts";
import { SpaceConflictError, SpaceNotFoundError, type GoogleAccount, type SpaceStore } from "@space/runtime";
import type { FastifyBaseLogger } from "fastify";
import { googleBrowserProfilePathFor, sharedCliProfilePathFor, type BrowserSessionManager, type PaneProfileAdoptionResult } from "./browser-sessions.js";
import type { SpaceApiConfig } from "./config.js";
import { cliAccountBrowserStatus, readGoogleBrowserCheck, type GoogleBrowserStatusSummary } from "./google-browser-session-check.js";
import { privatePaneProfileId, youtubeAccountProfileKey, type YouTubeAccountStore } from "./youtube-accounts.js";

export interface PaneBrowserAccount { selectedProfileId: string | null; account?: GoogleAccount; profileKey: string | null; sharedProfileKey?: string }

/**
 * Which account a Browser, YouTube or copilot pane opens with (its choice, else the primary Google account, else its own profile),
 * the one-time move of a pane's verified sign-in into the account's shared profile, and the account menus with each sign-in state.
 */
export function createPaneBrowserAccounts(options: {
  store: SpaceStore;
  config: Pick<SpaceApiConfig, "browserSessionsProfileRoot">;
  log: Pick<FastifyBaseLogger, "warn">;
  browserSessionManager: Pick<BrowserSessionManager, "adoptPaneGoogleProfile">;
  youtubeAccountStore: YouTubeAccountStore;
  browserAccountStore: YouTubeAccountStore;
  youtubeAccountOperations: Map<string, Promise<unknown>>;
  readCachedCliAccountIdentity: (runtimeId: "cli:gemini", profileId: string) => Promise<{ email: string | null }>;
  googleAccountBrowserStatuses: (accounts: GoogleAccount[]) => Promise<Map<string, GoogleBrowserStatusSummary>>;
}) {
  const { store, config, log, browserSessionManager, youtubeAccountStore, browserAccountStore, youtubeAccountOperations, readCachedCliAccountIdentity, googleAccountBrowserStatuses } = options;
  async function withYouTubeAccountLock<T>(paneId: string, operation: () => Promise<T>): Promise<T> {
    const next = (youtubeAccountOperations.get(paneId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    youtubeAccountOperations.set(paneId, next);
    try { return await next; } finally { if (youtubeAccountOperations.get(paneId) === next) youtubeAccountOperations.delete(paneId); }
  }
  async function youtubeAccountOwner(userId: string, pane: Pane) {
    return (await store.getRoom(pane.roomId)).kind === "AGENT_PROOF" ? `${userId}:proof:${pane.roomId}` : userId;
  }

  async function selectedGoogleBrowserAccount(userId: string, pane: Pane, profileId: string | null) {
    if (!profileId?.startsWith("google_account:")) return undefined;
    if ((await store.getRoom(pane.roomId)).kind === "AGENT_PROOF") throw new SpaceConflictError("Real Google accounts are unavailable in proof rooms.");
    const account = (await store.listGoogleAccounts(userId)).find(account => account.id === profileId);
    if (!account) throw new SpaceNotFoundError("The selected Google account is no longer available.");
    return account;
  }
  async function paneGoogleAccountSelection(userId: string, pane: Pane): Promise<string | null> {
    const owner = await youtubeAccountOwner(userId, pane);
    const selectionStore = pane.mode === "YOUTUBE" ? youtubeAccountStore : browserAccountStore;
    return selectionStore.get(owner, pane.id);
  }
  /** Legacy scope of a stored pane profile id ("profile:<room>:<pane>[:<key>]"). */
  function paneProfileKeyOf(profileId: string): string | null {
    const key = profileId.split(":")[3];
    return key && /^[a-f0-9]{64}$/.test(key) ? key : null;
  }
  // What a pane opens: its explicit choice, else the user's primary Google account (one shared profile for every pane, Freelance
  // included since 2026-10-21: the Browser Host starts the account's Chrome with its routes), else the pane's own profile. `choice`: one tab's account.
  async function resolvePaneBrowserAccount(userId: string, pane: Pane, choice?: string | null): Promise<PaneBrowserAccount> {
    const selectedProfileId = choice !== undefined ? choice : await paneGoogleAccountSelection(userId, pane);
    if (selectedProfileId === privatePaneProfileId) return { selectedProfileId, profileKey: null };
    const account = await selectedGoogleBrowserAccount(userId, pane, selectedProfileId);
    if (account) return { selectedProfileId, account, profileKey: null };
    if (selectedProfileId !== null) {
      if (!await store.getCliAccountProfile("cli:gemini", selectedProfileId)) {
        throw new SpaceConflictError("The selected Google account is no longer available. Choose another account.");
      }
      const key = youtubeAccountProfileKey(await youtubeAccountOwner(userId, pane), selectedProfileId)!;
      // A CLI (Gemini) account is one Chrome profile for all of the user's panes; proof rooms stay per pane.
      // The per-pane key stays alongside so an older Browser Host keeps the pane's own legacy profile.
      if ((await store.getRoom(pane.roomId)).kind === "AGENT_PROOF") return { selectedProfileId, profileKey: key };
      return { selectedProfileId, profileKey: key, sharedProfileKey: key };
    }
    if ((await store.getRoom(pane.roomId)).kind !== "AGENT_PROOF") {
      const primary = (await store.listGoogleAccounts(userId)).find(candidate => candidate.isPrimary);
      if (primary) return { selectedProfileId: null, account: primary, profileKey: null };
    }
    return { selectedProfileId: null, profileKey: null };
  }
  // Before a pane opens: when its own profile is verifiably signed in to one of the
  // user's Google accounts, that sign-in moves once into the account's shared profile
  // so every Browser and YouTube pane reuses it.
  async function adoptPaneSignIn(userId: string, pane: Pane, resolved: PaneBrowserAccount, actor: BrowserHostActorContext): Promise<PaneBrowserAccount> {
    if (resolved.selectedProfileId === privatePaneProfileId || resolved.sharedProfileKey || (await store.getRoom(pane.roomId)).kind === "AGENT_PROOF") return resolved;
    const byDefault = Boolean(resolved.account) && resolved.selectedProfileId === null;
    const active = await store.getActivePaneBrowserSession(pane.id);
    if (active) {
      // A running pane keeps its profile until it next opens fresh; a reconnect (or a new
      // primary account) never swaps it silently.
      if (byDefault && active.profileId.startsWith("profile:")) return { selectedProfileId: null, profileKey: paneProfileKeyOf(active.profileId) };
      if (byDefault && active.profileId.startsWith("google-account:")) {
        const running = (await store.listGoogleAccounts(userId)).find(candidate => `google-account:${candidate.id}` === active.profileId);
        if (running) return { selectedProfileId: null, account: running, profileKey: null };
      }
      return resolved;
    }
    // Without the Browser Host move (older host), prefer the pane's own profile unless the shared one is verified.
    const ownProfileUnlessShared = async (): Promise<PaneBrowserAccount> => {
      if (!byDefault || !resolved.account) return resolved;
      const check = await readGoogleBrowserCheck(googleBrowserProfilePathFor(config.browserSessionsProfileRoot, userId, resolved.account.id)).catch(() => null);
      return check?.status === "CONNECTED" ? resolved : { selectedProfileId: null, profileKey: null };
    };
    if (!browserSessionManager.adoptPaneGoogleProfile) return ownProfileUnlessShared();
    const accounts = await store.listGoogleAccounts(userId);
    if (!accounts.length) return resolved;
    let profileKey: string | null = resolved.profileKey;
    if (resolved.account && resolved.selectedProfileId !== null) {
      // An explicit account choice: look at the pane profile it used before, if any.
      const prior = await store.getLatestPaneBrowserSession(pane.id);
      if (!prior?.profileId.startsWith("profile:")) return resolved;
      profileKey = paneProfileKeyOf(prior.profileId);
    }
    let adoption: PaneProfileAdoptionResult;
    try {
      // An explicit account choice may only receive that account's sign-in.
      const wanted = resolved.account && resolved.selectedProfileId !== null ? { accountId: resolved.account.id } : {};
      adoption = await browserSessionManager.adoptPaneGoogleProfile({ ownerUserId: userId, roomId: pane.roomId, paneId: pane.id, profileKey, ...wanted }, actor);
    } catch (error) {
      log.warn({ err: error, paneId: pane.id }, "Pane Google sign-in adoption failed; opening the current selection.");
      return ownProfileUnlessShared();
    }
    const owner = await youtubeAccountOwner(userId, pane);
    const selectionStore = pane.mode === "YOUTUBE" ? youtubeAccountStore : browserAccountStore;
    const verified = adoption.accountId ? accounts.find(candidate => candidate.id === adoption.accountId &&
      (resolved.selectedProfileId === null || candidate.id === resolved.account?.id)) : undefined;
    if (verified && (adoption.result === "ADOPTED" || adoption.result === "ALREADY_CONNECTED")) {
      await selectionStore.save(owner, pane.id, verified.id);
      return { selectedProfileId: verified.id, account: verified, profileKey: null };
    }
    if (adoption.result === "TARGET_IN_USE" && (!resolved.account || resolved.selectedProfileId === null)) {
      // The shared profile is busy right now; keep this pane's own signed-in profile and retry next time.
      return { selectedProfileId: resolved.selectedProfileId, profileKey };
    }
    if (adoption.result === "OTHER_ACCOUNT" && resolved.account && resolved.selectedProfileId === null) {
      // Signed in to a Google account that is not linked to this user: keep that pane private.
      await selectionStore.save(owner, pane.id, privatePaneProfileId);
      return { selectedProfileId: privatePaneProfileId, profileKey: null };
    }
    return resolved;
  }
  /** The account a pane opens with; the primary account when nothing was chosen. */
  async function effectivePaneProfileId(userId: string, pane: Pane): Promise<string | null> {
    try {
      const resolved = await resolvePaneBrowserAccount(userId, pane);
      return resolved.account?.id ?? resolved.selectedProfileId;
    } catch { return null; }
  }
  // The newest closed Job/Marketing/Freelance Copilot pane of the room and kind (pruning keeps it): a new one continues its browser
  // account, tabs and view (Job Copilot also its terminal). shortcut: same room only; look across rooms if that becomes common.
  async function previousCopilotPane(pane: Pane): Promise<Pane | null> {
    if (pane.mode !== "JOB_APPLY" && pane.mode !== "MARKETING_COPILOT" && pane.mode !== "FREELANCE_COPILOT") return null;
    const closed = (await store.listPanes(pane.roomId, true)).filter((entry) => entry.mode === pane.mode && entry.isClosed && entry.id !== pane.id);
    return closed.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0] ?? null;
  }
  async function initializeNewPaneGoogleAccount(userId: string, pane: Pane): Promise<void> {
    if (pane.mode !== "BROWSER" && pane.mode !== "YOUTUBE" && pane.mode !== "JOB_APPLY" && pane.mode !== "MARKETING_COPILOT" && pane.mode !== "FREELANCE_COPILOT") return;
    const owner = await youtubeAccountOwner(userId, pane);
    const room = await store.getRoom(pane.roomId);
    const accounts = room.kind === "AGENT_PROOF" ? [] : await store.listGoogleAccounts(userId);
    let initial = accounts.find(account => account.isPrimary)?.id ?? null;
    if (room.kind !== "AGENT_PROOF") {
      // The account the previous copilot pane of this kind used, while it is still linked.
      const previous = await previousCopilotPane(pane);
      const chosen = previous ? await browserAccountStore.get(owner, previous.id) : null;
      if (chosen && (!chosen.startsWith("google_account:") || accounts.some(account => account.id === chosen))) initial = chosen;
    }
    await (pane.mode === "YOUTUBE" ? youtubeAccountStore : browserAccountStore).initializeSelection(owner, pane.id, initial);
  }
  // Gemini account emails for the account menus (they merge a Gemini account with the
  // linked Google account of the same email). An email rarely changes, so a menu waits
  // only briefly for the native probe and otherwise keeps the last known email.
  const geminiBrowserEmails = new Map<string, { email: string | null; expiresAt: number }>();
  async function geminiAccountEmails(profileIds: string[]): Promise<Map<string, string | null>> {
    const stale = profileIds.filter(profileId => (geminiBrowserEmails.get(profileId)?.expiresAt ?? 0) <= Date.now());
    if (stale.length) {
      let next = 0;
      const refresh = Promise.all(Array.from({ length: Math.min(4, stale.length) }, async () => {
        while (next < stale.length) {
          const profileId = stale[next++]!;
          const { email } = await readCachedCliAccountIdentity("cli:gemini", profileId);
          const known = geminiBrowserEmails.get(profileId)?.email ?? null;
          geminiBrowserEmails.set(profileId, { email: email ?? known, expiresAt: Date.now() + (email ? 10 * 60_000 : 60_000) });
        }
      }));
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([refresh, new Promise(resolve => { timer = setTimeout(resolve, 1_500); timer.unref?.(); })]);
      clearTimeout(timer);
    }
    return new Map(profileIds.map(profileId => [profileId, geminiBrowserEmails.get(profileId)?.email ?? null]));
  }
  /** Sign-in state of the one shared Chrome profile every pane opens for a Gemini account. */
  async function geminiAccountBrowserStatus(userId: string, profileId: string) {
    try { return await cliAccountBrowserStatus(sharedCliProfilePathFor(config.browserSessionsProfileRoot, youtubeAccountProfileKey(userId, profileId)!)); }
    catch { return "UNKNOWN" as const; }
  }
  async function browserAccountChoices(userId: string, pane: Pane) {
    const gemini = await store.listCliAccountProfiles("cli:gemini");
    // Proof rooms open per-pane profiles and never see real account identities.
    const proofRoom = (await store.getRoom(pane.roomId)).kind === "AGENT_PROOF";
    const accounts = proofRoom ? [] : await store.listGoogleAccounts(userId);
    const [statuses, emails, geminiStatuses] = await Promise.all([
      googleAccountBrowserStatuses(accounts),
      proofRoom ? new Map<string, string | null>() : geminiAccountEmails(gemini.map(profile => profile.profileId)),
      proofRoom ? [] : Promise.all(gemini.map(profile => geminiAccountBrowserStatus(userId, profile.profileId)))
    ]);
    return [...accounts.map(account => ({
      profileId: account.id,
      displayName: `Google account · ${account.displayName || account.email}`,
      label: account.displayName || account.email,
      email: account.email,
      browserStatus: statuses.get(account.id)!.browserStatus
    })), ...gemini.map(({ profileId, displayName }, index) => ({
      profileId,
      displayName: `Gemini account · ${displayName}`,
      label: displayName,
      ...(proofRoom ? {} : { email: emails.get(profileId) ?? null, browserStatus: geminiStatuses[index]! })
    }))];
  }
  return { withYouTubeAccountLock, youtubeAccountOwner, selectedGoogleBrowserAccount, paneGoogleAccountSelection, resolvePaneBrowserAccount, adoptPaneSignIn,
    effectivePaneProfileId, previousCopilotPane, initializeNewPaneGoogleAccount, geminiAccountEmails, browserAccountChoices };
}
