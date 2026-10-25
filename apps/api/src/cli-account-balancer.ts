import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  cliAccountBalanceSchema, cliBalancedRuntimeIds, cliProfileUsageSchema, type CliAccountBalance, type CliBalancedRuntimeId,
  type CliProfileUsage
} from "@space/contracts";

/**
 * Session-level balancing for CLIs signed in to several accounts (Space Gateway "Auto"). Copilot, Cursor and the
 * other subscription CLIs have no endpoint Space Gateway could balance per request, so a pane on Auto starts on the
 * account profile with the most room, and moves to the next one when the CLI reports that its account ran out.
 * Usage comes from each CLI wrapper's `usage-info`; an account Space saw run out is skipped until its reset, or for
 * an hour when the provider gives none. Auto panes and those marks survive API restarts in a small state file.
 */
const USAGE_TTL_MS = 5 * 60_000;
const DEFAULT_EXHAUSTION_MS = 60 * 60_000;
/** Neutral score for a connected account whose provider reports no quota (Cursor). */
const UNKNOWN_REMAINING = 50;
/** Request-level balancing already happens behind the gateway profile, so Auto never picks it. */
const GATEWAY_PROFILE = "space-gateway";

export const isCliBalancedRuntimeId = (runtimeId: string): runtimeId is CliBalancedRuntimeId =>
  (cliBalancedRuntimeIds as readonly string[]).includes(runtimeId);

interface BalancerState {
  /** Panes on Auto, with their CLI. */
  autoPanes: Record<string, CliBalancedRuntimeId>;
  /** `runtime/profile` -> ISO time until which Auto skips the account. */
  exhausted: Record<string, string>;
  /** `runtime/profile` -> ISO time Auto last picked the account, so equal accounts take turns. */
  picked: Record<string, string>;
}

export interface CliAccountBalancerOptions {
  listProfiles(runtimeId: CliBalancedRuntimeId): Promise<Array<{ profileId: string; displayName: string }>>;
  readUsage(runtimeId: CliBalancedRuntimeId, profileId: string): Promise<CliProfileUsage>;
  /** Where Auto panes and exhaustion marks are kept; null keeps them in memory (tests). */
  statePath: string | null;
  now?: () => number;
}

export interface CliAccountBalancer {
  balance(runtimeId: CliBalancedRuntimeId): Promise<CliAccountBalance>;
  /** The profile with the most room, other than `exclude`; null when none is available. Records the pick. */
  pick(runtimeId: CliBalancedRuntimeId, exclude?: readonly string[]): Promise<string | null>;
  /** The account ran out: skip it until its provider's reset (or an hour); returns that time. */
  markExhausted(runtimeId: CliBalancedRuntimeId, profileId: string): Promise<Date>;
  isAuto(paneId: string): Promise<boolean>;
  setAuto(paneId: string, runtimeId: CliBalancedRuntimeId | null): Promise<void>;
  autoPanes(): Promise<Record<string, CliBalancedRuntimeId>>;
}

const key = (runtimeId: string, profileId: string) => `${runtimeId}/${profileId}`;
const unknownUsage = (status: CliProfileUsage["status"]): CliProfileUsage => ({ status, plan: null, remainingPercent: null, resetAt: null, windows: [] });

export function createCliAccountBalancer(options: CliAccountBalancerOptions): CliAccountBalancer {
  const now = options.now ?? Date.now;
  const usageCache = new Map<string, { at: number; value: Promise<CliProfileUsage> }>();
  let state: BalancerState | null = null;
  let writing: Promise<void> = Promise.resolve();

  async function load(): Promise<BalancerState> {
    if (state) return state;
    let loaded: BalancerState = { autoPanes: {}, exhausted: {}, picked: {} };
    if (options.statePath) {
      try {
        const parsed = JSON.parse(await readFile(options.statePath, "utf8")) as Partial<BalancerState>;
        loaded = {
          autoPanes: Object.fromEntries(Object.entries(parsed.autoPanes ?? {}).filter(([, runtimeId]) => isCliBalancedRuntimeId(String(runtimeId)))) as BalancerState["autoPanes"],
          exhausted: Object.fromEntries(Object.entries(parsed.exhausted ?? {}).filter(([, until]) => typeof until === "string")),
          picked: Object.fromEntries(Object.entries(parsed.picked ?? {}).filter(([, at]) => typeof at === "string"))
        };
      } catch {
        // No state yet, or an unreadable file: start empty.
      }
    }
    state ??= loaded;
    return state;
  }

  /** Writes are serialized and atomic (temporary file, then rename); expired marks are dropped. */
  function save(): Promise<void> {
    if (!options.statePath || !state) return Promise.resolve();
    const path = options.statePath;
    const current = state;
    for (const [entry, until] of Object.entries(current.exhausted)) if (Date.parse(until) <= now()) delete current.exhausted[entry];
    writing = writing.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o750 });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(current)}\n`, { mode: 0o640 });
      await rename(temporary, path);
    }).catch(() => undefined);
    return writing;
  }

  function usage(runtimeId: CliBalancedRuntimeId, profileId: string): Promise<CliProfileUsage> {
    if (profileId === GATEWAY_PROFILE) return Promise.resolve(unknownUsage("GATEWAY"));
    const entry = usageCache.get(key(runtimeId, profileId));
    if (entry && now() - entry.at < USAGE_TTL_MS) return entry.value;
    const value = options.readUsage(runtimeId, profileId).then((raw) => cliProfileUsageSchema.parse(raw)).catch(() => unknownUsage("ERROR"));
    usageCache.set(key(runtimeId, profileId), { at: now(), value });
    return value;
  }

  /** Most remaining quota first; equal accounts by the oldest pick, so they take turns. */
  function order<T extends { profileId: string; usage: CliProfileUsage }>(runtimeId: CliBalancedRuntimeId, profiles: T[]): T[] {
    const picked = state?.picked ?? {};
    return [...profiles].sort((a, b) => (b.usage.remainingPercent ?? UNKNOWN_REMAINING) - (a.usage.remainingPercent ?? UNKNOWN_REMAINING)
      || (picked[key(runtimeId, a.profileId)] ?? "").localeCompare(picked[key(runtimeId, b.profileId)] ?? ""));
  }

  async function balance(runtimeId: CliBalancedRuntimeId): Promise<CliAccountBalance> {
    const current = await load();
    const listed = await options.listProfiles(runtimeId);
    const profiles = await Promise.all(listed.map(async (profile) => {
      const profileUsage = await usage(runtimeId, profile.profileId);
      const until = current.exhausted[key(runtimeId, profile.profileId)];
      const exhaustedUntil = until && Date.parse(until) > now() ? until : null;
      const available = profile.profileId !== GATEWAY_PROFILE && exhaustedUntil === null && profileUsage.remainingPercent !== 0
        && (profileUsage.status === "OK" || profileUsage.status === "UNKNOWN");
      return { profileId: profile.profileId, displayName: profile.displayName, usage: profileUsage, exhaustedUntil, available };
    }));
    const ranked = order(runtimeId, profiles.filter((profile) => profile.available));
    return cliAccountBalanceSchema.parse({ runtimeId, profiles, next: ranked[0]?.profileId ?? null, checkedAt: new Date(now()).toISOString() });
  }

  return {
    balance,
    async pick(runtimeId, exclude = []) {
      const result = await balance(runtimeId);
      const chosen = order(runtimeId, result.profiles.filter((profile) => profile.available && !exclude.includes(profile.profileId)))[0];
      if (!chosen) return null;
      (await load()).picked[key(runtimeId, chosen.profileId)] = new Date(now()).toISOString();
      await save();
      return chosen.profileId;
    },
    async markExhausted(runtimeId, profileId) {
      const current = await load();
      // The provider's reset when it reported one, read fresh: the cached figure predates the limit.
      usageCache.delete(key(runtimeId, profileId));
      const resetAt = (await usage(runtimeId, profileId)).resetAt;
      const until = resetAt && Date.parse(resetAt) > now() ? new Date(resetAt) : new Date(now() + DEFAULT_EXHAUSTION_MS);
      current.exhausted[key(runtimeId, profileId)] = until.toISOString();
      await save();
      return until;
    },
    async isAuto(paneId) {
      return Boolean((await load()).autoPanes[paneId]);
    },
    async setAuto(paneId, runtimeId) {
      const current = await load();
      if (runtimeId) current.autoPanes[paneId] = runtimeId;
      else if (current.autoPanes[paneId]) delete current.autoPanes[paneId];
      else return;
      await save();
    },
    async autoPanes() {
      return { ...(await load()).autoPanes };
    }
  };
}
