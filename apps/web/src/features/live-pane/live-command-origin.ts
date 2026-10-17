export type LiveCommandRoom = () => string | undefined;

// Commands stay valid while the user keeps talking in the same room (operator review 2026-10-15: GPT-Live's
// delegated tool calls arrive seconds after the request, and "can you hear me?" meanwhile cancelled every one of
// them). A different room, a stop, an invalidation or a later refusal ("no", "wait", "όχι") still ends them.

/**
 * Google Live has call IDs, but no response/input ID on tool calls. Bind at
 * input submission, never at tool arrival. Inputs in different rooms are
 * ambiguous: deny tools until the provider completes the turn.
 */
export function createUnidentifiedLiveCommandOrigin(capture: () => LiveCommandRoom) {
  let generation = 0;
  let pending: LiveCommandRoom | null = null;
  const denied: LiveCommandRoom = () => undefined;
  // A notice's own turn runs no tools, but unlike an invalidated turn the user's next input replaces it.
  const noticeTurn: LiveCommandRoom = () => undefined;
  const guardFor = (room: LiveCommandRoom): LiveCommandRoom => { const version = generation; return () => version === generation ? room() : undefined; };

  return {
    beginInput(room: LiveCommandRoom = capture()) {
      const open = pending !== null && pending !== noticeTurn;
      pending = open && pending!() !== room() ? denied : guardFor(room);
    },
    beginNotification() {
      pending = noticeTurn;
    },
    capture(): LiveCommandRoom {
      if (pending) return pending;
      const current = capture();
      return current() ? current : denied;
    },
    invalidate() {
      generation++;
      // Retain the outstanding turn: a new input must not adopt its late calls.
      if (pending) pending = denied;
    },
    finishTurn() {
      pending = null;
    }
  };
}

/** Response IDs keep late OpenAI events attached to the original input guard. */
export function createIdentifiedLiveCommandOrigins(capture: () => LiveCommandRoom, capacity = 4096, onAmbiguous?: () => void) {
  const denied: LiveCommandRoom = () => undefined;
  const noticeTurn: LiveCommandRoom = () => undefined;
  let generation = 0;
  let pending: LiveCommandRoom | null = null;
  let ambiguous = false;
  const responses = new Map<string, LiveCommandRoom>();
  const cancelledResponses = new Set<string>();
  const calls = new Map<string, { responseId: string; room: LiveCommandRoom }>();
  return {
    beginInput() {
      const version = generation, room = capture();
      const guard = () => !ambiguous && version === generation ? room() : undefined;
      // Only an unanswered input from another room makes the next response's room unknowable.
      const conflict = pending !== null && pending !== noticeTurn && pending() !== room();
      const becameAmbiguous = conflict && !ambiguous;
      if (conflict) ambiguous = true;
      pending = ambiguous ? denied : guard;
      // Once response order is ambiguous, a later response.created cannot
      // establish which room it belongs to. Start a fresh transport.
      if (becameAmbiguous) onAmbiguous?.();
      return guard;
    },
    beginNotification() { pending = noticeTurn; },
    invalidate() { generation++; if (pending) pending = denied; },
    responseCreated(id: string) {
      if (!id || responses.has(id)) return;
      // GPT-Live marks no input turns: a response without a known input belongs to the current room, if any.
      const origin = ambiguous ? denied : pending ?? capture();
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
      calls.set(callId, { responseId: id, room: responses.get(id) ?? (id ? denied : capture()) });
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

// Counts the user's spoken or typed turns, so a confirmation is accepted only after the user answered.
let liveUserTurns = 0;
export function noteLiveUserTurn(): number { return ++liveUserTurns; }
export function liveUserTurn(): number { return liveUserTurns; }

// The user's latest words and the turn they belong to, so a confirmation is read, not only counted.
let lastUserText = { turn: 0, text: "" };
let lastDeclineTurn = 0;
export function noteLiveUserText(text: string): void {
  if (!text.trim()) return;
  lastUserText = { turn: liveUserTurns, text };
  if (liveAnswerDeclines(text)) lastDeclineTurn = liveUserTurns;
}
/** True when the user refused or asked to wait in a turn after `turn`: commands from before then are dropped. */
export function liveDeclinedSince(turn: number): boolean { return lastDeclineTurn > turn; }
/** The user's words spoken or typed after `turn`, or null while none have arrived. */
export function liveUserTextSince(turn: number): string | null { return lastUserText.turn > turn ? lastUserText.text : null; }

const declineWords = new Set(["no", "nope", "nah", "dont", "cancel", "stop", "wait",
  "οχι", "μην", "μη", "ακυρο", "ακυρωσε", "ακυρωση", "σταματα", "σταματησε", "περιμενε", "αστο", "καθολου"]);
const declinePhrases = ["do not", "don t", "never mind", "hold on", "not now", "ασ το", "οχι ακομα"];
/** True when an answer refuses or postpones, in English or Greek (accents and case ignored). */
export function liveAnswerDeclines(text: string): boolean {
  const words = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  const joined = ` ${words.join(" ")} `;
  return words.some(word => declineWords.has(word)) || declinePhrases.some(phrase => joined.includes(` ${phrase} `));
}
