import { z } from "zod";
import type { Event, Pane } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { CliPaneReopener } from "./cli-pane-reopen.js";

/** The audit record the runtime-settings route writes for every enable and disable. */
export const cliRuntimeSettingAuditAction = "cli.runtime.setting.update";

const disableAuditMetadataSchema = z.object({
  enabled: z.literal(false),
  cleanup: z.object({ closedPaneIds: z.array(z.string()) })
});
const restoreConcurrency = 3;

export interface CliRuntimePaneRestore {
  paneIds: string[];
  /** Settles once every pane is reopened and its resume has finished or been skipped. */
  done: Promise<void>;
}

/**
 * Enabling a runtime again reopens the panes its last disable closed, in their original order,
 * and resumes their tasks where the native CLI can continue them exactly. A pane closed or
 * changed again after that disable stays as it is.
 */
export function createCliRuntimePaneRestorer(options: {
  store: Pick<SpaceStore, "findLatestAuditEvent" | "getPane" | "updatePane" | "getLatestEvent">;
  reopener: CliPaneReopener;
  publishEvent?: (event: Event) => void;
}): (runtimeId: string, traceId: string) => Promise<CliRuntimePaneRestore> {
  const { store, reopener, publishEvent } = options;
  return async (runtimeId, traceId) => {
    const disable = await store.findLatestAuditEvent?.({
      action: cliRuntimeSettingAuditAction,
      targetType: "cli_runtime",
      targetId: runtimeId
    });
    const metadata = disableAuditMetadataSchema.safeParse(disable?.metadata);
    if (!disable || !metadata.success) return { paneIds: [], done: Promise.resolve() };

    const panes: Pane[] = [];
    for (const paneId of new Set(metadata.data.cleanup.closedPaneIds)) {
      const pane = await Promise.resolve(store.getPane(paneId)).catch(() => null);
      if (pane?.isClosed && pane.terminalRuntimeId === runtimeId && pane.updatedAt <= disable.createdAt) panes.push(pane);
    }
    panes.sort((left, right) => left.roomId.localeCompare(right.roomId) || left.order - right.order);

    let reopenTurn: Promise<unknown> = Promise.resolve();
    let next = 0;
    const restoreNext = async (): Promise<void> => {
      while (next < panes.length) {
        const pane = panes[next++]!;
        // Reopens run one at a time in pane order, so the panes keep their relative positions;
        // resumes, the slow part, overlap.
        const reopen = reopenTurn.then(() =>
          store.updatePane(pane.id, { isClosed: false, isMinimized: false, status: "IDLE" }, traceId)
        );
        reopenTurn = reopen.catch(() => undefined);
        const restored = reopener.reopen(pane.id, () => reopen, traceId);
        const latestEvent = await restored.pane.then((reopened) => store.getLatestEvent(reopened.roomId)).catch(() => null);
        if (latestEvent) publishEvent?.(latestEvent);
        await restored.resumed;
      }
    };
    const workers = Array.from({ length: Math.min(restoreConcurrency, panes.length) }, () => restoreNext());
    return { paneIds: panes.map((pane) => pane.id), done: Promise.all(workers).then(() => undefined) };
  };
}
