import { t3CodeSelectionMessageSchema, t3CodeSelectionSchema, type T3CodeSelection, type T3CodeSelectionMessage } from "@space/contracts";

interface FrameWindow { postMessage(message: unknown, targetOrigin: string): void }
interface Options {
  initialSequence?: number; paneId: string; generation: string; origin: string; selection: T3CodeSelection;
  frameWindow: () => FrameWindow | null;
  persist: (input: { version: 1; generation: string; sequence: number; requestId: string; selection: T3CodeSelection }) => Promise<void>;
  onApplied?: (selection: T3CodeSelection) => void;
  onError: (code: string) => void;
}
// Stage06's iframe host consumes this module. It has no room/pane mounting,
// visibility or global event connection side effects of its own.
export function createT3SelectionChannel(options: Options) {
  let disposed = false, received = -1, sent = 0, persistenceSequence = options.initialSequence ?? 0;
  let pending: { requestId: string; selection: T3CodeSelection } | null = null;
  let queue = Promise.resolve();
  const sameSelection = (a: T3CodeSelection, b: T3CodeSelection) => a.environmentId === b.environmentId && a.projectId === b.projectId && a.threadId === b.threadId && a.draftId === b.draftId;
  const persist = (message: T3CodeSelectionMessage, selection: T3CodeSelection) => {
    queue = queue.then(async () => {
      if (disposed) return;
      await options.persist({ version: 1, generation: options.generation, sequence: ++persistenceSequence, requestId: message.requestId, selection });
      if (!disposed) options.onApplied?.(selection);
    }).catch(() => { if (!disposed) options.onError("T3_SELECTION_SAVE_FAILED"); });
    return queue;
  };
  return {
    request(selection: T3CodeSelection) {
      if (disposed) return;
      const parsed = t3CodeSelectionSchema.parse(selection), frame = options.frameWindow();
      if (!frame) return;
      pending = { requestId: crypto.randomUUID(), selection: parsed };
      frame.postMessage(t3CodeSelectionMessageSchema.parse({ version: 1, type: "selection.request", paneId: options.paneId,
        generation: options.generation, sequence: ++sent, requestId: pending.requestId, payload: parsed }), options.origin);
    },
    async receive(event: { origin: string; source: unknown; data: unknown }) {
      if (disposed || event.origin !== options.origin || event.source !== options.frameWindow()) return;
      const parsed = t3CodeSelectionMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.paneId !== options.paneId || message.generation !== options.generation || message.sequence <= received || message.type === "selection.request") return;
      if (message.type === "selection.applied" && (!pending || pending.requestId !== message.requestId || !sameSelection(pending.selection, message.payload))) return;
      received = message.sequence;
      if (message.type === "error") { options.onError(message.payload.code); return; }
      if (message.type === "ready") return;
      if (message.type === "selection.applied") pending = null;
      await persist(message, message.payload);
    },
    dispose() { disposed = true; pending = null; }
  };
}
