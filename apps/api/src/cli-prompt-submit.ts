import { randomUUID } from "node:crypto";
import { SpaceConflictError } from "@space/runtime";
import type { CliTerminalManager } from "./cli-terminal.js";
import { noteSpacePrompt } from "./space-prompts.js";
import { roomAnswerInput, roomComposerEmpty, roomComposerHolds, roomComposerNotReady, roomComposerShowsOnly } from "./room-terminal-screen.js";

type PromptTerminal = Pick<CliTerminalManager, "sendInput" | "observeRoomScreenUndimmed"> & Partial<Pick<CliTerminalManager, "claudeTurnStartedSince">>;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Types a prompt into a CLI pane and submits it: a bracketed paste (like the local composer), Enter, then Enter again,
 * at most twice, while the composer still holds the text. Live Claude Code panes kept prompts as unsent drafts after
 * their Enter on 2026-10-20 (not reproduced outside those processes); a later Enter sent each one. Only a prompt typed
 * into an empty composer is confirmed, so an operator's draft or a menu never gets an extra Enter. The paste waits for the
 * composer of a CLI this input starts again: a paste that reaches a booting Claude Code stays a draft (stable 2026-10-22/23).
 */
export async function submitCliPrompt(terminal: PromptTerminal, sessionId: string, text: string, traceId: string, key: string,
  options: { waitForComposer?: boolean; gapMs?: number; delayMs?: number; assertCurrent?: () => Promise<unknown>; onlyWhenReady?: boolean;
    /** OBS-006: the request that typed this text (an HTTP caller's; else traceId, the server's own); a typed prompt starts no native turn to carry it. */
    requestId?: string; paneId?: string; signal?: AbortSignal } = {}): Promise<void> {
  const screen = await terminal.observeRoomScreenUndimmed(sessionId);
  // onlyWhenReady: a working CLI or a held composer gets nothing typed; the caller holds the text for the next empty prompt.
  const notReady = options.onlyWhenReady ? roomComposerNotReady(screen) : null;
  if (notReady) {
    const submitted = notReady === COMPOSER_HOLDS_TEXT && await submitSpaceDraft(terminal, sessionId, screen, traceId, options);
    throw new SpaceConflictError(`The pane is not confirmed ready for input: ${notReady}${submitted ? " Space typed earlier, now submitted" : ""}; nothing was typed.`);
  }
  const confirm = text.length > 1 && roomComposerEmpty(screen);
  // As the native turn's space_request_id: an id outside printable ASCII 1-120 is dropped.
  const asked = options.requestId ?? traceId;
  const requestId = /^[\x21-\x7e]{1,120}$/.test(asked) ? asked : undefined;
  rememberSpaceTyped(sessionId, text, Date.now(), requestId);
  if (options.paneId) noteSpacePrompt(options.paneId);
  const sinceMs = Date.now();
  await terminal.sendInput(sessionId, roomAnswerInput(text, true), traceId, null, `${key}:prompt`, options.waitForComposer ?? true, options.signal);
  // Logged once the text reached the CLI: before, a composer wait that failed still read as typed (7/11 Bruno/Kate).
  console.info(JSON.stringify({ level: 30, time: Date.now(), event: "cli_prompt.typed", requestId: requestId ?? null, paneId: options.paneId ?? null, sessionId }));
  await wait(options.gapMs ?? 200);
  await options.assertCurrent?.();
  await terminal.sendInput(sessionId, "\r", traceId, null, `${key}:submit`);
  if (confirm) await confirmCliPromptSubmitted(terminal, sessionId, text, traceId, key, { ...options, sinceMs });
}

/**
 * Plan clipboard:qH5emwVaV6yO step 4: new copilot work (a run, a batch of briefs) starts a fresh Claude Code session; one App Studio session
 * re-sent ~195k tokens on each of 600 requests in 4 h (5/11). Only an idle, empty Claude prompt is cleared (the copilot's state lives in its
 * store, memory and project folder); then waits for the empty prompt again. Returns whether it cleared.
 */
export async function clearIdleClaudeSession(terminal: PromptTerminal, session: { runtimeId: string; sessionId: string }, traceId: string, key: string,
  options: { delayMs?: number; tries?: number } = {}): Promise<boolean> {
  if (session.runtimeId !== "cli:claude") return false;
  const screen = await terminal.observeRoomScreenUndimmed(session.sessionId);
  if (!roomComposerEmpty(screen) || roomComposerNotReady(screen)) return false;
  await submitCliPrompt(terminal, session.sessionId, "/clear", traceId, `${key}:clear`, options);
  for (let tries = options.tries ?? 10; tries > 0; tries--) {
    if (roomComposerEmpty(await terminal.observeRoomScreenUndimmed(session.sessionId))) break;
    await wait(options.delayMs ?? 500);
  }
  return true;
}

/**
 * Presses Enter again (at most three times, the last a second later) while the composer still holds the typed text; fails if it stays a draft, unless Claude's own
 * transcript started a turn since `sinceMs`: 13/11 Cody, Jack and Bob took Nous's texts 0.6-1.1 s after they were typed, yet their
 * screens rebuilt from the output tail still showed them in the composer, so Nous was told to clear a draft that was already sent.
 */
export async function confirmCliPromptSubmitted(terminal: PromptTerminal, sessionId: string, typed: string, traceId: string, key: string,
  options: { delayMs?: number; assertCurrent?: () => Promise<unknown>; sinceMs?: number } = {}): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await wait(options.delayMs ?? 500);
    await options.assertCurrent?.();
    if (!roomComposerHolds(await terminal.observeRoomScreenUndimmed(sessionId), typed)) return;
    if (attempt >= 2 && options.sinceMs !== undefined && await terminal.claudeTurnStartedSince?.(sessionId, options.sinceMs)) return;
    if (attempt === 3) throw new SpaceConflictError("The CLI kept the text as an unsent draft after Enter; it was not submitted.");
    // Daily Nous errors 14/11 (space_send_to_pane ×2): one more Enter a second later, then the last read back, before a draft is reported.
    if (attempt === 2) await wait(2 * (options.delayMs ?? 500));
    await terminal.sendInput(sessionId, "\r", traceId, null, `${key}:resubmit-${attempt}`);
  }
}

/** CLIs whose composer Space reads before typing: Claude Code (31/10 Alex/Max) and Codex (3/11 Bruno/Oscar); other CLIs keep their own checks. */
export const COMPOSER_CHECKED_RUNTIMES = new Set(["cli:claude", "cli:codex"]);
/** Space Control's promptNotReady: the screen of a COMPOSER_CHECKED_RUNTIMES session; a text Space typed and left there is submitted now. */
export async function cliPromptNotReady(terminal: PromptTerminal, session: { runtimeId: string; sessionId: string } | null): Promise<string | null> {
  if (!session || !COMPOSER_CHECKED_RUNTIMES.has(session.runtimeId)) return null;
  const screen = await terminal.observeRoomScreenUndimmed(session.sessionId).catch(() => "");
  const notReady = roomComposerNotReady(screen);
  return notReady === COMPOSER_HOLDS_TEXT && await submitSpaceDraft(terminal, session.sessionId, screen, randomUUID()) ? `${notReady} Space typed earlier, now submitted` : notReady;
}

const COMPOSER_HOLDS_TEXT = "its composer holds text";
/**
 * Texts Space typed into each CLI session in the last 24 hours (every prompt Space types comes through submitCliPrompt). 3/11 Bruno/Paul: the
 * scheduler's paste stayed in an idle Claude Code composer (its Enter lost while it "Compacted while idle"), and every later task and prompt waited on it.
 */
// shortcut: kept in the API's memory, so an API restart forgets them (such a draft then waits like an operator's); persist them if restarts strand drafts.
const typedBySession = new Map<string, Array<{ text: string; at: number; requestId?: string }>>();
const TYPED_KEPT_MS = 86_400_000;
export function rememberSpaceTyped(sessionId: string, text: string, now = Date.now(), requestId?: string): void {
  typedBySession.set(sessionId, [...spaceTypedTexts(sessionId, now), { text, at: now, ...(requestId ? { requestId } : {}) }]);
}
export const spaceTypedTexts = (sessionId: string, now = Date.now()) => (typedBySession.get(sessionId) ?? []).filter((entry) => now - entry.at < TYPED_KEPT_MS);
/** The text Space typed into this session that its composer shows and nothing else (roomComposerShowsOnly), else null. */
export const spaceTypedDraft = (sessionId: string, screen: string, now = Date.now()) =>
  spaceTypedTexts(sessionId, now).findLast((entry) => roomComposerShowsOnly(screen, entry.text))?.text ?? null;

/** Presses Enter on a composer (the caller saw its CLI idle) that shows only a text Space typed; true once the text left the composer. */
export async function submitSpaceDraft(terminal: PromptTerminal, sessionId: string, screen: string, traceId: string, options: { delayMs?: number } = {}): Promise<boolean> {
  const held = spaceTypedDraft(sessionId, screen);
  if (!held) return false;
  await terminal.sendInput(sessionId, "\r", traceId, null, `${traceId}:space-draft`);
  return confirmCliPromptSubmitted(terminal, sessionId, held, traceId, `${traceId}:space-draft`, options).then(() => true, () => false);
}
/** A text still a draft after every Enter reaches Nous at once as one line (31/10 Alex/Max), never silently. */
export const isDraftError = (error: unknown) => /unsent draft/.test(String((error as Error | null)?.message));
export const draftNoticeLine = (pane: string, text: string) => `${pane} kept a text Space typed as an unsent draft after 3 Enters: "${text.replace(/\s+/g, " ").slice(0, 120)}". `
  + "Read the pane (space_read_pane); if it is idle, clear the draft (space_clear_pane_draft) and send the text again.";
