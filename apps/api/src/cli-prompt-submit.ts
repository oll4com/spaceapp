import { SpaceConflictError } from "@space/runtime";
import type { CliTerminalManager } from "./cli-terminal.js";
import { roomAnswerInput, roomComposerEmpty, roomComposerHolds } from "./room-terminal-screen.js";

type PromptTerminal = Pick<CliTerminalManager, "sendInput" | "observeRoomScreenUndimmed">;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Types a prompt into a CLI pane and submits it: a bracketed paste (like the local composer), Enter, then Enter again,
 * at most twice, while the composer still holds the text. Live Claude Code panes kept prompts as unsent drafts after
 * their Enter on 2026-10-20 (not reproduced outside those processes); a later Enter sent each one. Only a prompt typed
 * into an empty composer is confirmed, so an operator's draft or a menu never gets an extra Enter. The paste waits for the
 * composer of a CLI this input starts again: a paste that reaches a booting Claude Code stays a draft (stable 2026-10-22/23).
 */
export async function submitCliPrompt(terminal: PromptTerminal, sessionId: string, text: string, traceId: string, key: string,
  options: { waitForComposer?: boolean; gapMs?: number; delayMs?: number; assertCurrent?: () => Promise<unknown> } = {}): Promise<void> {
  const confirm = text.length > 1 && roomComposerEmpty(await terminal.observeRoomScreenUndimmed(sessionId));
  await terminal.sendInput(sessionId, roomAnswerInput(text, true), traceId, null, `${key}:prompt`, options.waitForComposer ?? true);
  await wait(options.gapMs ?? 200);
  await options.assertCurrent?.();
  await terminal.sendInput(sessionId, "\r", traceId, null, `${key}:submit`);
  if (confirm) await confirmCliPromptSubmitted(terminal, sessionId, text, traceId, key, options);
}

/** Presses Enter again (at most twice) while the composer still holds the typed text; fails if it stays a draft. */
export async function confirmCliPromptSubmitted(terminal: PromptTerminal, sessionId: string, typed: string, traceId: string, key: string,
  options: { delayMs?: number; assertCurrent?: () => Promise<unknown> } = {}): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await wait(options.delayMs ?? 500);
    await options.assertCurrent?.();
    if (!roomComposerHolds(await terminal.observeRoomScreenUndimmed(sessionId), typed)) return;
    if (attempt === 2) throw new SpaceConflictError("The CLI kept the text as an unsent draft after Enter; it was not submitted.");
    await terminal.sendInput(sessionId, "\r", traceId, null, `${key}:resubmit-${attempt}`);
  }
}
