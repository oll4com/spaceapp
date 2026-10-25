import type { Pane } from "@space/contracts";

const defaultSettleTimeoutMs = 6_000;

export interface CliPaneReopen {
  pane: Promise<Pane>;
  /** Whether the pane's last task was resumed; false when it opens as before, with Reconnect. */
  resumed: Promise<boolean>;
}

export interface CliPaneReopener {
  /** `resume` replaces the default resume for this call (a new Job Copilot pane continues the previous pane's task). */
  reopen(paneId: string, reopen: () => Pane | PromiseLike<Pane>, traceId: string, resume?: (pane: Pane, traceId: string) => Promise<boolean>): CliPaneReopen;
  /** Waits (bounded) for a reopen resume in flight, so a session read sees the resumed session. */
  settled(paneId: string, timeoutMs?: number): Promise<void>;
}

/**
 * A reopened CLI pane continues its last task when the native CLI can resume it exactly (the
 * rule Room Agent reopen follows); otherwise it opens as before, with Reconnect available.
 * Session reads for the pane wait for the resume, so a client that mounts the reopened pane
 * before the resume finishes attaches to the resumed session instead of an empty terminal.
 */
export function createCliPaneReopener(options: {
  resume: (pane: Pane, traceId: string) => Promise<boolean>;
  onResumeError?: (paneId: string, error: unknown) => void;
}): CliPaneReopener {
  const pending = new Map<string, Promise<boolean>>();
  return {
    reopen(paneId, reopen, traceId, resume = options.resume) {
      // Registered before the reopen runs: its event can reach a client before the resume ends.
      const pane = Promise.resolve().then(reopen);
      // A failed reopen rejects `pane` for the caller; it has nothing to resume.
      const resumed: Promise<boolean> = pane
        .then(
          (reopened) => resume(reopened, traceId).catch((error: unknown) => {
            options.onResumeError?.(paneId, error);
            return false;
          }),
          () => false
        )
        .finally(() => {
          if (pending.get(paneId) === resumed) pending.delete(paneId);
        });
      pending.set(paneId, resumed);
      return { pane, resumed };
    },
    async settled(paneId, timeoutMs = defaultSettleTimeoutMs) {
      const resume = pending.get(paneId);
      if (!resume) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([resume, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
      clearTimeout(timer);
    }
  };
}
