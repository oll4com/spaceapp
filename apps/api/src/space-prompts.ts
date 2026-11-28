// Operator 8/11 20:08 BKK (Alex/Bob: Nous asked "save to memory" of the operator's own pane awaiting their choice): when Space last prompted
// each pane. A leaf module so cli-prompt-submit.ts and queue-operator-grants.ts share it without a dependency cycle.
// The marks survive an API restart in queue-operator-grants' state file (28/11, plan clipboard:CTVaL1V3kAFM step 1), which saves on `changed`.
export const spacePromptAt = new Map<string, number>();
let changed = (): void => {};
/** queue-operator-grants saves the marks on every new one (this leaf module cannot import it). */
export const onSpacePrompt = (listener: () => void): void => { changed = listener; };
/** A work prompt Space (Nous, the scheduler, Space Control) typed into a pane; a text that only asks for a memory save is none (cli-prompt-submit.ts). */
export function noteSpacePrompt(paneId: string, nowMs = Date.now()): void {
  spacePromptAt.set(paneId, nowMs);
  changed();
}
export const lastSpacePromptAt = (paneId: string): number => spacePromptAt.get(paneId) ?? -Infinity;
