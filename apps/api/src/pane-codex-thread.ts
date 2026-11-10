import type { PaneCliSession } from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import { codexDirectParityCwd, isCodexDirectParityRuntime } from "./cli-parity.js";
import { findAvailableCodexThreadId, type CodexThreadFinder } from "./cli-terminal.js";
import { CodexParityNotFoundError, type CodexParityService } from "./codex-parity.js";

/* The Codex thread of a pane's CLI session: kept only while Codex still has it, else found and claimed for the session
   (another pane's claim wins); and the title a pane takes from a resumed task. */
export async function availableNativeCodexThreadId(
  codexParity: CodexParityService,
  threadId: string | null
): Promise<string | null> {
  if (!threadId) return null;
  try {
    await codexParity.getHistoryThread(threadId);
    return threadId;
  } catch (error) {
    if (error instanceof CodexParityNotFoundError) return null;
    throw error;
  }
}

export function paneTitleFromCliTaskTitle(title: string): string {
  const nextTitle = title.trim().slice(0, 120);
  return nextTitle || "Resumed CLI task";
}

export async function resolvePaneCodexThreadId(input: {
  store: SpaceStore;
  session: PaneCliSession;
  traceId: string;
  findThreadId?: CodexThreadFinder;
}): Promise<string | null> {
  if (input.session.codexThreadId) return input.session.codexThreadId;
  if (!isCodexDirectParityRuntime(input.session.runtimeId)) return null;
  const codexThreadId = await findAvailableCodexThreadId({
    store: input.store,
    paneId: input.session.paneId,
    sessionId: input.session.sessionId,
    cwd: input.session.cwd ?? codexDirectParityCwd,
    findThreadId: input.findThreadId
  });
  if (!codexThreadId) return null;
  try {
    await input.store.claimPaneCliCodexThread(input.session.sessionId, codexThreadId, "AUTO", input.traceId);
    return codexThreadId;
  } catch (error) {
    if (error instanceof SpaceConflictError) {
      return null;
    }
    throw error;
  }
}
