// Operator 8/11 20:08 BKK (Alex/Bob: Nous asked "save to memory" of the operator's own pane awaiting their choice): when Space last prompted
// each pane. A leaf module so cli-prompt-submit.ts and queue-operator-grants.ts share it without a dependency cycle.
// shortcut: in the API's memory, so a restart forgets it (the pane then reads as nobody's); persist it if that strands an operator's pane.
const spacePromptAt = new Map<string, number>();
/** A prompt Space (Nous, the scheduler, Space Control) typed into a pane. */
export function noteSpacePrompt(paneId: string, nowMs = Date.now()): void {
  spacePromptAt.delete(paneId);
  spacePromptAt.set(paneId, nowMs);
  if (spacePromptAt.size > 1000) spacePromptAt.delete(spacePromptAt.keys().next().value!);
}
export const lastSpacePromptAt = (paneId: string): number => spacePromptAt.get(paneId) ?? -Infinity;
