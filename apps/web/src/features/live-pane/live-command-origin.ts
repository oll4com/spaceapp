export type LiveCommandRoom = () => string | undefined;

/**
 * Google Live has call IDs, but no response/input ID on tool calls. Bind at
 * input submission, never at tool arrival. Overlapping turns are ambiguous:
 * deny tools until the provider completes the turn and a fresh input starts.
 */
export function createUnidentifiedLiveCommandOrigin(capture: () => LiveCommandRoom) {
  let epoch = 0;
  let pending: LiveCommandRoom | null = null;
  const denied: LiveCommandRoom = () => undefined;

  return {
    beginInput() {
      const version = ++epoch;
      const room = capture();
      pending = pending ? denied : () => version === epoch ? room() : undefined;
    },
    beginNotification() {
      epoch++;
      pending = denied;
    },
    capture(): LiveCommandRoom {
      return pending ?? denied;
    },
    invalidate() {
      epoch++;
      // Retain the outstanding turn: a new input must not adopt its late calls.
      if (pending) pending = denied;
    },
    finishTurn() {
      // Queued calls retain their original guard. A newer input invalidates it.
      pending = null;
    }
  };
}

/** Response IDs keep late OpenAI events attached to the original input guard. */
export function createIdentifiedLiveCommandOrigins(capture: () => LiveCommandRoom, capacity = 4096, onAmbiguous?: () => void) {
  const denied: LiveCommandRoom = () => undefined;
  let epoch = 0;
  let pending: LiveCommandRoom | null = null;
  let ambiguous = false;
  const responses = new Map<string, LiveCommandRoom>();
  const cancelledResponses = new Set<string>();
  const calls = new Map<string, { responseId: string; room: LiveCommandRoom }>();
  return {
    beginInput() {
      const version = ++epoch, room = capture();
      const guard = () => !ambiguous && version === epoch ? room() : undefined;
      // The provider has not identified the previous input's response yet.
      const becameAmbiguous = Boolean(pending) && !ambiguous;
      if (pending) ambiguous = true;
      pending = ambiguous ? denied : guard;
      // Once response order is ambiguous, a later response.created cannot
      // establish that all old inputs were consumed. Start a fresh transport.
      if (becameAmbiguous) onAmbiguous?.();
      return guard;
    },
    beginNotification() { epoch++; pending = denied; },
    invalidate() { epoch++; if (pending) pending = denied; },
    responseCreated(id: string) {
      if (!id || responses.has(id)) return;
      const origin = ambiguous ? denied : pending ?? denied;
      if (responses.size < capacity) responses.set(id, () => cancelledResponses.has(id) ? undefined : origin());
      pending = null;
    },
    cancelResponse(id: string) { if (responses.has(id)) cancelledResponses.add(id); },
    bindCall(callId: string, responseId: unknown) {
      if (!callId) return;
      const existing = calls.get(callId);
      if (existing) {
        if (typeof responseId === "string" && responseId && responseId !== existing.responseId) existing.room = denied;
        return;
      }
      if (calls.size >= capacity) return;
      const id = typeof responseId === "string" ? responseId : "";
      calls.set(callId, { responseId: id, room: responses.get(id) ?? denied });
    },
    captureCall(callId: string): LiveCommandRoom { return calls.get(callId)?.room ?? denied; },
    expectContinuation(origin: LiveCommandRoom) {
      // A stale tool result must not acquire the next user's response slot.
      if (!origin()) return false;
      if (pending) { pending = denied; return false; }
      pending = origin;
      return true;
    }
  };
}
