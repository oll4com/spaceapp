import type { Pane } from "@space/contracts";
import type { RoomPaneObservation } from "../room-pane-control.js";
import { roomComposerHolds } from "../room-terminal-screen.js";

export interface CodeTyper {
  inspect(pane: Pane): Promise<RoomPaneObservation>;
  pressKeys(sessionId: string, keys: string, traceId: string): Promise<unknown>;
  wait?(ms: number): Promise<void>;
}

/**
 * R27-3, 15/11 Dino/Jack (3 Braintrust codes BLOCKED): a one-time code is typed into the pane at once, never as a Space after-turn
 * schedule, whose record would keep the code and whose turn (the one waiting for that code) never ends. Returns why it did not
 * arrive, or null once the composer let it go.
 */
export async function typeCodeNow(deps: CodeTyper, pane: Pane, text: string, traceId: string): Promise<string | null> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const seen = await deps.inspect(pane);
  if (!seen.sessionId) return "the pane runs no CLI";
  if (!["IDLE", "WAITING_FOR_INPUT", "RUNNING"].includes(seen.state)) return `its CLI is ${seen.state.toLowerCase().replace(/_/g, " ")}`;
  // A busy Antigravity queues a line sent with Enter behind the running turn; alt+m sends it now. Claude Code takes an Enter-sent line into the running turn.
  const send = seen.state === "RUNNING" && seen.runtimeId === "cli:gemini" ? "\u001bm" : "\r";
  await deps.pressKeys(seen.sessionId, text, traceId);
  await wait(300); // typed and sent in one write reads as a paste, whose Enter is a new line
  await deps.pressKeys(seen.sessionId, send, traceId);
  await wait(1500);
  const after = await deps.inspect(pane).catch(() => null);
  return after?.text && roomComposerHolds(after.text, text) ? "it stayed in the pane's composer" : null;
}
