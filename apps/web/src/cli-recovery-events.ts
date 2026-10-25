export const CLI_RECOVERY_OPENED_EVENT = "space:cli-recovery-opened";

export interface CliRecoveryOpenedDetail {
  roomId: string;
  paneId: string | null;
}

export function dispatchCliRecoveryOpened(detail: CliRecoveryOpenedDetail): void {
  window.dispatchEvent(new CustomEvent<CliRecoveryOpenedDetail>(CLI_RECOVERY_OPENED_EVENT, { detail }));
}

export function parseCliRecoveryOpenedDetail(value: unknown): CliRecoveryOpenedDetail | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.roomId !== "string") return null;
  if (candidate.paneId !== null && typeof candidate.paneId !== "string") return null;
  return { roomId: candidate.roomId, paneId: candidate.paneId };
}
