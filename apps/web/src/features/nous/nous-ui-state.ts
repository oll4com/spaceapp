import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { signedInUserId } from "../../auth-bootstrap-cache.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";

/**
 * What the operator opened or closed in the Nous dock survives a reload and a dock close (operator 2026-10-31, plan
 * clipboard:d8nCNBw2mzDK step 1), and so does every tab's filter (operator 3/11 12:51 BKK, nous_msg:40a252b1): kept on this device
 * per signed-in user under `space.nous.ui.<user>.<key>`, shared by every component reading the same key. Until a user wrote a key,
 * the device's value from before the per-user keys reads. A stored value that does not parse or fit reads as today's default.
 */
const PREFIX = "space.nous.ui.";
/** Ids kept per list; the oldest go first past it (a message id cannot be told gone from not loaded yet). */
const MAX_IDS = 200;
const listeners = new Set<() => void>();
/** Used only when the browser refuses storage, so the toggles still work for this tab. */
const memory = new Map<string, string>();

const userKey = (key: string) => { const user = signedInUserId(); return user ? `${PREFIX}${user}.${key}` : PREFIX + key; };
function raw(key: string): string | null {
  const full = userKey(key);
  try {
    const storage = getSpaceRuntime().platform.localStorage;
    return storage.getItem(full) ?? storage.getItem(PREFIX + key);
  } catch { return memory.get(full) ?? null; }
}
function write(key: string, value: unknown) {
  const text = JSON.stringify(value);
  try { getSpaceRuntime().platform.localStorage.setItem(userKey(key), text); } catch { memory.set(userKey(key), text); }
  for (const listener of listeners) listener();
}
function parsed(text: string | null): unknown {
  if (text === null) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** useState kept on this device; `valid` says whether a stored value is one this state takes (pass stable `valid` and `fallback`). */
export function useNousUiState<T>(key: string, fallback: T, valid: (value: unknown) => value is T): [T, (next: T | ((current: T) => T)) => void] {
  const text = useSyncExternalStore(subscribe, () => raw(key), () => null);
  const value = useMemo(() => { const stored = parsed(text); return valid(stored) ? stored : fallback; }, [text, valid, fallback]);
  const set = useCallback((next: T | ((current: T) => T)) => {
    const stored = parsed(raw(key));
    const current = valid(stored) ? stored : fallback;
    write(key, typeof next === "function" ? (next as (current: T) => T)(current) : next);
  }, [key, valid, fallback]);
  return [value, set];
}

const isIds = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === "string");
const NO_IDS: string[] = [];

/** A list of open (or closed) ids kept on this device; once `existing` is known, ids no longer in it are dropped. */
export function useNousUiIds(key: string, existing?: readonly string[] | null) {
  const [ids, setIds] = useNousUiState<string[]>(key, NO_IDS, isIds);
  const known = existing ? existing.join("\n") : null;
  useEffect(() => {
    if (known === null) return;
    const keep = new Set(known ? known.split("\n") : []);
    if (ids.some((id) => !keep.has(id))) setIds((current) => current.filter((id) => keep.has(id)));
  }, [known, ids, setIds]);
  const has = useCallback((id: string) => ids.includes(id), [ids]);
  const setOpen = useCallback((id: string, open: boolean) => setIds((current) =>
    current.includes(id) === open ? current : open ? [...current, id].slice(-MAX_IDS) : current.filter((entry) => entry !== id)), [setIds]);
  const toggle = useCallback((id: string) => setIds((current) =>
    current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id].slice(-MAX_IDS)), [setIds]);
  return { has, setOpen, toggle };
}

export const isFlag = (value: unknown): value is boolean => typeof value === "boolean";
export const isIdOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
