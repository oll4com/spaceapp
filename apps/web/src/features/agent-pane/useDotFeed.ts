import { useCallback, useEffect, useRef, useState } from "react";
import { dotFeedCursor, type DotFeed, type DotFeedItem } from "@space/contracts";
import { api } from "../../api.js";

const PAGE = 40;
const REFRESH_MS = 20_000;
export interface DotFeedState {
  dotId: string | null;
  items: DotFeedItem[];
  nextBefore: string | null;
  lastActiveAt: string | null;
  unread: number;
  /** The newest row read, hidden ones included: the read marker moves here. */
  latestCursor: string | null;
  /** ROOM: an Agent Proof room's own conversation only. */
  scope: DotFeed["scope"];
  status: "loading" | "ready" | "unavailable";
  loadingOlder: boolean;
}
const empty = (dotId: string | null): DotFeedState => ({ dotId, items: [], nextBefore: null, lastActiveAt: null, unread: 0, latestCursor: null,
  scope: "DOT", status: dotId ? "loading" : "unavailable", loadingOlder: false });
const byTime = (a: DotFeedItem, b: DotFeedItem) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** Newest page merged into what is loaded; a page that leaves a gap replaces it (older items load again on scroll). */
export function mergeLatestDotFeed(current: DotFeedItem[], page: DotFeed): { items: DotFeedItem[]; replaced: boolean } {
  const newest = current.at(-1);
  const oldestOfPage = page.items[0];
  if (!current.length || (page.nextBefore && newest && oldestOfPage && byTime(oldestOfPage, newest) > 0)) {
    return { items: [...page.items].sort(byTime), replaced: true };
  }
  const fresh = new Map(page.items.map((item) => [item.id, item]));
  const kept = current.filter((item) => !fresh.has(item.id));
  return { items: [...kept, ...page.items].sort(byTime), replaced: false };
}

/**
 * One Dot's continuous feed across rooms. It reads the newest page when the Dot, the refresh key
 * or the clock asks (only while the pane is visible) and older pages on request.
 */
export function useDotFeed({ dotId, roomId = null, visible, refreshKey, read = api.dotFeed, markRead = api.markDotFeedRead }: {
  dotId: string | null; visible: boolean; refreshKey: string;
  /** The pane's room: an Agent Proof room sees only its own conversation. */
  roomId?: string | null;
  read?: (dotId: string, page?: { before?: string; limit?: number; roomId?: string | null }) => Promise<DotFeed>;
  markRead?: (dotId: string, cursor: string, roomId?: string | null) => Promise<{ unread: number }>;
}) {
  const [state, setState] = useState<DotFeedState>(() => empty(dotId));
  const stateRef = useRef(state);
  stateRef.current = state;
  const dotRef = useRef(dotId);
  dotRef.current = dotId;
  const inFlight = useRef<Promise<void> | null>(null);

  const loadOlder = useCallback(async (): Promise<void> => {
    const target = dotRef.current;
    const snapshot = stateRef.current;
    if (!target || snapshot.dotId !== target || !snapshot.nextBefore || snapshot.loadingOlder) return;
    setState((current) => current.dotId === target ? { ...current, loadingOlder: true } : current);
    try {
      const page = await read(target, { before: snapshot.nextBefore, limit: PAGE, ...(roomId ? { roomId } : {}) });
      if (dotRef.current !== target || page.dotId !== target) return;
      setState((current) => {
        if (current.dotId !== target) return current;
        const known = new Set(current.items.map((item) => item.id));
        return { ...current, items: [...page.items.filter((item) => !known.has(item.id)), ...current.items].sort(byTime),
          nextBefore: page.nextBefore, loadingOlder: false };
      });
    } catch {
      setState((current) => current.dotId === target ? { ...current, loadingOlder: false } : current);
    }
  }, [read, roomId]);

  const refresh = useCallback((): Promise<void> => {
    const target = dotRef.current;
    if (!target) return Promise.resolve();
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      try {
        let page = await read(target, { limit: PAGE, ...(roomId ? { roomId } : {}) });
        // Hidden rows can fill a whole page; read further back until something is visible.
        for (let more = 0; !page.items.length && page.nextBefore && more < 4; more++) {
          const older = await read(target, { before: page.nextBefore, limit: PAGE, ...(roomId ? { roomId } : {}) });
          page = { ...page, items: older.items, nextBefore: older.nextBefore };
        }
        if (dotRef.current !== target || page.dotId !== target) return;
        setState((current) => {
          const sameDot = current.dotId === target && current.status !== "loading";
          const merged = sameDot ? mergeLatestDotFeed(current.items, page) : { items: [...page.items].sort(byTime), replaced: true };
          return { dotId: target, items: merged.items, nextBefore: merged.replaced ? page.nextBefore : current.nextBefore,
            lastActiveAt: page.lastActiveAt, unread: page.unread, latestCursor: page.latestCursor ?? current.latestCursor, scope: page.scope ?? "DOT",
            status: "ready", loadingOlder: sameDot ? current.loadingOlder : false };
        });
      } catch {
        if (dotRef.current === target) setState((current) => current.dotId === target && current.status === "ready" ? current : { ...empty(target), status: "unavailable" });
      } finally { inFlight.current = null; }
    })();
    inFlight.current = run;
    return run;
  }, [read, roomId]);

  useEffect(() => {
    setState(empty(dotId));
    inFlight.current = null;
  }, [dotId]);

  // A hidden or minimized pane reads its feed only once it is shown.
  useEffect(() => {
    if (dotId && visible) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dotId, visible, refreshKey]);

  useEffect(() => {
    if (!dotId || !visible) return;
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [dotId, visible, refresh]);

  // What the user can see is read, up to the newest row read (hidden rows included, so the marker never sticks).
  const last = state.items.at(-1);
  const readTo = state.latestCursor ?? (last ? dotFeedCursor(last) : null);
  useEffect(() => {
    if (!dotId || !visible || state.dotId !== dotId || state.status !== "ready" || !state.unread || !readTo) return;
    if (document.visibilityState === "hidden") return;
    let current = true;
    void (roomId ? markRead(dotId, readTo, roomId) : markRead(dotId, readTo)).then((result) => {
      if (current) setState((value) => value.dotId === dotId ? { ...value, unread: result.unread } : value);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [dotId, visible, state.dotId, state.status, state.unread, readTo, markRead]);

  return { ...state, loadOlder, refresh };
}
