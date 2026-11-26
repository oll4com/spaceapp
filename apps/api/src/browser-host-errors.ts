import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BrowserHostError } from "@space/browser-host";
import { redactSecretText, SpaceFeatureDisabledError } from "@space/runtime";
import { execGit } from "./worktrees/worktree-service.js";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

/**
 * Round 9 item 4 (28/10 14:10 BKK: Cleo/Bob lost a day to "The Browser Host is unavailable."): a resident Browser Host older than
 * the pane metadata contracts refuses a pane with a zod error it reports as BROWSER_HOST_INTERNAL_ERROR, and the API showed only
 * "unavailable". API side only (the proxy and the host are restart paths): every answer names the host's code (and the first zod
 * issue once the host proxy passes it as `hostIssue`), Nous hears which pane it hit, and a stale host is named once per host start.
 * 14/11 20:14-20:45Z: swap thrash made the host's Postgres connects time out, every answer still blamed a stale host and the
 * operator's restart fixed nothing. The host's own message now rides through (keepBrowserHostErrorMessages), and the stale-host
 * hint shows only while the stale watch below found the running host older than the pane contracts.
 */
export interface BrowserHostInternalErrorEvent { paneId: string; roomId: string; code: string; issue: string | null; stale: boolean }
const listeners = new Set<(event: BrowserHostInternalErrorEvent) => void>();
export function onBrowserHostInternalError(listener: (event: BrowserHostInternalErrorEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const paneOf = (args: unknown[]): { id: string; roomId: string } | null => {
  const first = args[0] as { pane?: unknown; id?: unknown; roomId?: unknown } | undefined;
  const candidate = (first && typeof first === "object" && first.pane && typeof first.pane === "object" ? first.pane : first) as { id?: unknown; roomId?: unknown } | undefined;
  return candidate && typeof candidate.id === "string" && typeof candidate.roomId === "string" ? { id: candidate.id, roomId: candidate.roomId } : null;
};

/** The Browser Host could not be reached or failed the request (browser-host-proxy's translateHostError). */
export const isBrowserHostUnavailable = (error: unknown): error is SpaceFeatureDisabledError =>
  error instanceof SpaceFeatureDisabledError && error.errorCode === "BROWSER_HOST_UNAVAILABLE";

/** The start of the running Browser Host while the stale watch found it older than the pane contracts; null when not (or not known). */
let staleHostStartedAt: string | null = null;

/** The "unavailable" answer of a host that failed the request itself, rewritten to say so (code, the host's message, a stale host). */
export function browserHostErrorText(error: unknown, args: unknown[] = []): unknown {
  if (!isBrowserHostUnavailable(error)) return error;
  const details = (error.details ?? {}) as { hostCode?: unknown; hostIssue?: unknown; hostDetails?: { hostMessage?: unknown } | null };
  if (details.hostCode !== "BROWSER_HOST_INTERNAL_ERROR") return error;
  const hostMessage = details.hostDetails?.hostMessage;
  const issue = typeof details.hostIssue === "string" ? details.hostIssue : typeof hostMessage === "string" && hostMessage.trim() ? hostMessage.trim() : null;
  const stale = staleHostStartedAt;
  const pane = paneOf(args);
  if (pane) for (const listener of listeners) { try { listener({ paneId: pane.id, roomId: pane.roomId, code: "BROWSER_HOST_INTERNAL_ERROR", issue, stale: stale !== null }); } catch { /* never changes the answer */ } }
  return new SpaceFeatureDisabledError(error.errorCode, `The Browser Host is running but failed this request (BROWSER_HOST_INTERNAL_ERROR${issue ? `: ${issue}` : ""}). `
    // 15/11 Score lever #1 (space_look 13/11 02:05Z): without a stale host the answer named no next step.
    + (stale ? `The resident Browser Host started ${stale.slice(0, 16).replace("T", " ")} UTC, before the newest pane contracts, and refuses panes this way until ${BROWSER_HOST_RESTART}. `
      : "No stale host is known, so a restart is not the fix: the message names the cause. Try once more in a few minutes (a timeout under load passes); "
        + "if it fails the same way, report that message. ")
    + "Do not retry in a loop.", error.details);
}

/** Every method's error goes through `map` (sync throws and rejected promises); everything else passes as it is. */
function mapErrors<T extends object>(target: T, map: (error: unknown, args: unknown[]) => unknown): T {
  return new Proxy(target, {
    get(inner, key, receiver) {
      const value = Reflect.get(inner, key, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          const result = (value as (...rest: unknown[]) => unknown).apply(inner, args);
          return result instanceof Promise ? result.catch((error: unknown) => { throw map(error, args); }) : result;
        } catch (error) {
          throw map(error, args);
        }
      };
    }
  });
}

/**
 * A Browser Host client whose BROWSER_HOST_INTERNAL_ERROR keeps the host's own message (redacted) as `details.hostMessage`: the proxy's
 * translateHostError (a host restart path) passes details on as `hostDetails` but drops the message.
 */
export function keepBrowserHostErrorMessages<T extends object>(client: T): T {
  return mapErrors(client, (error) => error instanceof BrowserHostError && error.code === "BROWSER_HOST_INTERNAL_ERROR"
    ? new BrowserHostError(error.code, error.message, { ...(error.details && typeof error.details === "object" ? error.details : {}), hostMessage: redactSecretText(error.message) })
    : error);
}

/** Slice 17 (14/11: "tell Nous" reached Nous itself): who restarts the host, and where. Nous's Away rules never let it restart a host. */
export const BROWSER_HOST_RESTART = "the operator's guarded Browser Host restart (Settings → Nous → Server operations → Restart a service, "
  + "or `space-admin-action server-ops restart browser-host` by an agent the operator asks)";

/** Every method of the browser session manager answers with browserHostErrorText. */
export function withBrowserHostErrorText<T extends object>(manager: T): T {
  return mapErrors(manager, browserHostErrorText);
}

/** The contracts the Browser Host parses pane rows with (paneSchema and every pane metadata schema). */
export const PANE_METADATA_SCHEMA_FILES = ["schemas.ts", "task-metadata.ts", "t3code.ts", "job-apply.ts", "mail-copilot.ts", "marketing-copilot.ts", "freelance-copilot.ts",
  "design.ts", "app-studio.ts", "security-copilot.ts", "monitoring-copilot.ts", "video.ts"].map((file) => `packages/contracts/src/${file}`);

/** When the newest commit touching those files was made in stable's checkout (the Browser Host runs from it); null when git cannot tell. */
export async function paneSchemasChangedAt(root = SPACE_INSTALL_ROOT): Promise<string | null> {
  const result = await execGit(root, ["log", "-1", "--format=%cI", "--", ...PANE_METADATA_SCHEMA_FILES], 10_000).catch(() => null);
  const at = result?.code === 0 ? result.stdout.trim() : "";
  return at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : null;
}

/** The told host start on disk, so an API restart does not tell Nous the same host again (writes fail quietly: the line then repeats once). */
export function browserHostStaleToldStore(path = `${SPACE_INSTALL_ROOT}/var/inventory/browser-host-stale-told.json`) {
  return {
    read(): string | null { try { return String(JSON.parse(readFileSync(path, "utf8")).startedAt ?? "") || null; } catch { return null; } },
    write(startedAt: string) { try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ startedAt })); } catch { /* told stays in memory */ } },
  };
}

/**
 * One line per Browser Host start whose host is older than the newest pane contract change: the host refuses panes it cannot parse
 * until the operator's guarded restart. Checked at most every 10 minutes. A host reporting tolerantPaneRows reads such rows fine, so
 * the watch stays silent for it (17/11, nous_msg:efe9585f: every promote that touched a pane contract produced a restart card); the
 * merge queue restarts an older host itself after the deploy that made it tolerant (settleBrowserHost).
 */
export function createBrowserHostStaleWatch(deps: { health(): Promise<{ startedAt: string; tolerantPaneRows?: boolean } | null>; changedAt(): Promise<string | null>; now?: () => number;
  /** The host start the line was told for, kept across API restarts (1/11: 50 restarts told the same host 22 times, every one a Nous turn). */
  told?: { read(): string | null; write(startedAt: string): void } }) {
  let told: string | null = deps.told?.read() ?? null;
  let checkedAt = 0;
  return {
    async check(): Promise<string | null> {
      const now = deps.now?.() ?? Date.now();
      if (now - checkedAt < 10 * 60_000) return null;
      checkedAt = now;
      const health = await deps.health().catch(() => null);
      if (!health?.startedAt) return null;
      // A host that drops the fields and values it does not know parses newer rows fine: older than the contracts is not stale for it.
      if (health.tolerantPaneRows === true) { staleHostStartedAt = null; return null; }
      // A host start once told stale stays stale: the contracts only move forward.
      if (told === health.startedAt) { staleHostStartedAt = told; return null; }
      const changed = await deps.changedAt().catch(() => null);
      if (!changed || Date.parse(changed) <= Date.parse(health.startedAt)) { staleHostStartedAt = null; return null; }
      staleHostStartedAt = told = health.startedAt;
      deps.told?.write(health.startedAt);
      return `The resident Browser Host started ${health.startedAt.slice(0, 16).replace("T", " ")} UTC, before the newest change to the pane contracts it parses `
        + `(${changed.slice(0, 16).replace("T", " ")} UTC): panes whose rows carry the new fields fail with BROWSER_HOST_INTERNAL_ERROR until ${BROWSER_HOST_RESTART}. `
        + "Bring it to the operator once (their hands, not a decision you can take); browser work on those panes waits until then.";
    }
  };
}
