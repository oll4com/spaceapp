export interface CliResumeIntent {
  taskId?: string;
  threadId?: string;
}

const pendingCliResumes = new Map<string, CliResumeIntent>();

export function registerCliResumeIntent(paneId: string, intent: CliResumeIntent): void {
  pendingCliResumes.set(paneId, intent);
}

export function takeCliResumeIntent(paneId: string): CliResumeIntent | null {
  if (!pendingCliResumes.has(paneId)) return null;
  const intent = pendingCliResumes.get(paneId) ?? null;
  pendingCliResumes.delete(paneId);
  return intent;
}

export function hasCliResumeIntent(paneId: string): boolean {
  return pendingCliResumes.has(paneId);
}

const pendingAgentThreadOpens = new Map<string, string>();

export function registerPendingThreadOpen(paneId: string, threadId: string): void {
  pendingAgentThreadOpens.set(paneId, threadId);
}

export function takePendingThreadOpen(paneId: string): string | null {
  if (!pendingAgentThreadOpens.has(paneId)) return null;
  const threadId = pendingAgentThreadOpens.get(paneId) ?? null;
  pendingAgentThreadOpens.delete(paneId);
  return threadId;
}

export function hasPendingThreadOpen(paneId: string): boolean {
  return pendingAgentThreadOpens.has(paneId);
}