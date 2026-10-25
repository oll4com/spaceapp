import { useEffect, useRef, useState } from "react";
import type { AgentPaneSession } from "@space/contracts";
import type { AgentPaneDraftState } from "./agent-pane-draft.js";

interface Transition {
  blocked: boolean;
  snapshot: () => AgentPaneDraftState;
  save: (draft: AgentPaneDraftState) => void;
  resolve: () => Promise<AgentPaneSession>;
  reconcile: () => Promise<AgentPaneSession>;
  publish: (session: AgentPaneSession) => void;
}
export function useDotSession() {
  const lockedRef = useRef(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const [transitioning, setTransitioning] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; generationRef.current += 1; };
  }, []);
  function isCurrent(generation: number): boolean { return mountedRef.current && generationRef.current === generation; }
  function unlock(generation: number) {
    if (!isCurrent(generation)) return;
    lockedRef.current = false;
    setTransitioning(false);
  }
  async function transition(input: Transition): Promise<boolean> {
    if (input.blocked || lockedRef.current || !mountedRef.current) return false;
    lockedRef.current = true;
    const generation = ++generationRef.current;
    setTransitioning(true); setTransitionError(null);
    try {
      // This runs synchronously before the first await; debounced React state
      // is never the source of the outgoing draft snapshot.
      input.save(input.snapshot());
      const session = await input.resolve();
      if (!isCurrent(generation)) return false;
      input.publish(session);
      unlock(generation);
      return true;
    } catch (error) {
      if (!isCurrent(generation)) return false;
      setTransitionError(error instanceof Error ? error.message : "Dot selection failed.");
      try {
        const authoritative = await input.reconcile();
        if (!isCurrent(generation)) return false;
        input.publish(authoritative);
        unlock(generation);
      } catch {
        if (isCurrent(generation)) setTransitionError("Session selection is unconfirmed. Reconnect before sending.");
        // A lost acknowledgement may have changed the server target. Keep the
        // lock until an authoritative read succeeds, even after transport failure.
      }
      return false;
    }
  }
  async function reconcile(read: () => Promise<AgentPaneSession>, publish: (session: AgentPaneSession) => void): Promise<void> {
    if (!lockedRef.current || !mountedRef.current) return;
    const generation = generationRef.current;
    try {
      const session = await read();
      if (!isCurrent(generation)) return;
      publish(session); setTransitionError(null); unlock(generation);
    } catch {
      if (isCurrent(generation)) setTransitionError("Session selection is unconfirmed. Reconnect before sending.");
    }
  }
  return { transition, reconcile, lockedRef, generationRef, isCurrent, transitioning, transitionError };
}
