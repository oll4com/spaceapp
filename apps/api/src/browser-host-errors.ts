import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SpaceFeatureDisabledError } from "@space/runtime";
import { execGit } from "./worktrees/worktree-service.js";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

/**
 * Round 9 item 4 (28/10 14:10 BKK: Cleo/Bob lost a day to "The Browser Host is unavailable."): a resident Browser Host older than
 * the pane metadata contracts refuses a pane with a zod error it reports as BROWSER_HOST_INTERNAL_ERROR, and the API showed only
 * "unavailable". API side only (the proxy and the host are restart paths): every answer names the host's code (and the first zod
 * issue once the host proxy passes it as `hostIssue`), Nous hears which pane it hit, and a stale host is named once per host start.
 */
export interface BrowserHostInternalErrorEvent { paneId: string; roomId: string; code: string; issue: string | null }
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

/** The "unavailable" answer of a host that failed the request itself, rewritten to say so (code, first issue, the likely cause). */
export function browserHostErrorText(error: unknown, args: unknown[] = []): unknown {
  if (!isBrowserHostUnavailable(error)) return error;
  const details = (error.details ?? {}) as { hostCode?: unknown; hostIssue?: unknown };
  if (details.hostCode !== "BROWSER_HOST_INTERNAL_ERROR") return error;
  const issue = typeof details.hostIssue === "string" ? details.hostIssue : null;
  const pane = paneOf(args);
  if (pane) for (const listener of listeners) { try { listener({ paneId: pane.id, roomId: pane.roomId, code: "BROWSER_HOST_INTERNAL_ERROR", issue }); } catch { /* never changes the answer */ } }
  return new SpaceFeatureDisabledError(error.errorCode, `The Browser Host is running but failed this request (BROWSER_HOST_INTERNAL_ERROR${issue ? `: ${issue}` : ""}). `
    + "A resident Browser Host started before the newest pane contracts refuses panes this way and needs the operator's guarded restart: tell Nous, do not retry in a loop.", error.details);
}

/** Every method of the browser session manager answers with browserHostErrorText. */
export function withBrowserHostErrorText<T extends object>(manager: T): T {
  return new Proxy(manager, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          const result = (value as (...inner: unknown[]) => unknown).apply(target, args);
          return result instanceof Promise ? result.catch((error: unknown) => { throw browserHostErrorText(error, args); }) : result;
        } catch (error) {
          throw browserHostErrorText(error, args);
        }
      };
    }
  });
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

/**
 * One line per Browser Host start whose host is older than the newest pane contract change: the host refuses panes it cannot parse
 * until the operator's guarded restart. Checked at most every 10 minutes.
 */
/** The told host start on disk, so an API restart does not tell Nous the same host again (writes fail quietly: the line then repeats once). */
export function browserHostStaleToldStore(path = `${SPACE_INSTALL_ROOT}/var/inventory/browser-host-stale-told.json`) {
  return {
    read(): string | null { try { return String(JSON.parse(readFileSync(path, "utf8")).startedAt ?? "") || null; } catch { return null; } },
    write(startedAt: string) { try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ startedAt })); } catch { /* told stays in memory */ } },
  };
}

export function createBrowserHostStaleWatch(deps: { health(): Promise<{ startedAt: string } | null>; changedAt(): Promise<string | null>; now?: () => number;
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
      if (!health?.startedAt || told === health.startedAt) return null;
      const changed = await deps.changedAt().catch(() => null);
      if (!changed || Date.parse(changed) <= Date.parse(health.startedAt)) return null;
      told = health.startedAt;
      deps.told?.write(health.startedAt);
      return `The resident Browser Host started ${health.startedAt.slice(0, 16).replace("T", " ")} UTC, before the newest change to the pane contracts it parses `
        + `(${changed.slice(0, 16).replace("T", " ")} UTC): panes whose rows carry the new fields fail with BROWSER_HOST_INTERNAL_ERROR until the operator's guarded `
        + "Browser Host restart. Bring it to the operator once (their hands, not a decision you can take); browser work on those panes waits until then.";
    }
  };
}
