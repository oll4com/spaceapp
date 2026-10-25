import { useEffect, useRef, useState } from "react";
import type { RoomAgentEvent } from "@space/contracts";
import { api } from "../../api.js";

/** How often the toolbar asks what waits for the operator: a small read, slower while the tab is hidden. */
export const ROOM_AGENT_ATTENTION_VISIBLE_MS = 15_000;
export const ROOM_AGENT_ATTENTION_HIDDEN_MS = 60_000;

export interface RoomAgentAttention {
  total: number;
  rooms: Record<string, number>;
  latest: RoomAgentEvent[];
}

const empty: RoomAgentAttention = { total: 0, rooms: {}, latest: [] };

/**
 * Questions and problems that wait for the operator across all rooms (the Room Agent's attention events).
 * Each request starts only after the previous one settled; `onNew` receives events not seen before.
 */
export function useRoomAgentAttention(enabled: boolean, onNew?: (events: RoomAgentEvent[]) => void): RoomAgentAttention {
  const [attention, setAttention] = useState<RoomAgentAttention>(empty);
  const seen = useRef<Set<string> | null>(null);
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;

  useEffect(() => {
    if (!enabled) { setAttention(empty); seen.current = null; return; }
    let cancelled = false;
    let timer: number | undefined;
    let inFlight = false;
    const schedule = () => {
      if (cancelled) return;
      timer = window.setTimeout(read, document.hidden ? ROOM_AGENT_ATTENTION_HIDDEN_MS : ROOM_AGENT_ATTENTION_VISIBLE_MS);
    };
    async function read() {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await api.roomAgentPending();
        if (cancelled) return;
        const total = Object.values(result.rooms).reduce((sum, count) => sum + count, 0);
        setAttention((current) => current.total === total && current.latest.map((event) => event.eventId).join() === result.latest.map((event) => event.eventId).join()
          ? current : { total, rooms: result.rooms, latest: result.latest });
        // The first read only learns what already waits; later reads report what is new.
        const fresh = seen.current ? result.latest.filter((event) => !seen.current!.has(event.eventId)) : [];
        seen.current = new Set([...(seen.current ?? []), ...result.latest.map((event) => event.eventId)]);
        if (fresh.length) onNewRef.current?.(fresh);
      } catch {
        // Offline or signed out: keep the last known state and try again later.
      } finally {
        inFlight = false;
        schedule();
      }
    }
    void read();
    const onVisible = () => { if (!document.hidden) { window.clearTimeout(timer); void read(); } };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [enabled]);

  return attention;
}
