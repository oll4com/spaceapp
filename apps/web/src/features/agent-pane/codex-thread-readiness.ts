import type { AgentPaneSession } from "@space/contracts";

const activeStatuses: AgentPaneSession["runStatus"][] = ["QUEUED", "RUNNING", "INTERRUPTING"];
type ThreadSession = Pick<AgentPaneSession, "runStatus" | "latestRun"> | null | undefined;
const active = (session: ThreadSession) => Boolean(session && activeStatuses.includes(session.runStatus));

/**
 * Space learns a new conversation's thread id when Codex creates it, but Codex
 * writes the conversation only once its first turn starts. Until the running
 * task reports that turn there is nothing to read, and asking returns "not found".
 */
export function codexThreadPending(session: ThreadSession, threadId: string, loaded: ReadonlySet<string>): boolean {
  if (loaded.has(threadId) || !active(session)) return false;
  const run = session!.latestRun;
  return Boolean(run && run.threadId === threadId && !run.turnId);
}

/** "Not found" for a conversation that was never read and whose task is still running means it is not written yet; the next poll reads it. */
export function codexThreadNotWrittenYet(error: unknown, session: ThreadSession, threadId: string, loaded: ReadonlySet<string>): boolean {
  return (error as { status?: number } | null)?.status === 404 && !loaded.has(threadId) && active(session);
}
