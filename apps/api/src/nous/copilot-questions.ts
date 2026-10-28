import { copilotQuestionItemId, heldForNous, isCopilotQuestion, type NotificationSource, type SpaceNotification } from "@space/contracts";
import type { NotificationService } from "../notifications/service.js";

/** Which copilot sources a wired copilot service answers for: only their questions can be checked against the open items. */
export const COPILOT_SOURCE_OF = { job: "JOB_COPILOT", mail: "MAIL_COPILOT", marketing: "MARKETING_COPILOT", freelance: "FREELANCE_COPILOT", design: "DESIGN",
  appStudio: "APP_STUDIO", video: "VIDEO", security: "SECURITY_COPILOT", monitoring: "MONITORING_COPILOT" } as const satisfies Record<string, NotificationSource>;

/**
 * Ask Last step 7, every minute (like the decisions withdrawn once decided in the rail): (a) a copilot question record whose question no
 * longer waits (answered in the rail or by Nous, closed, or its pane gone) is RESOLVED, never deleted: 286 such records of 13-24/10 sat
 * unresolved; (b) a question held for Nous goes to the operator once its hour ends or Nous no longer holds questions (off, paused).
 * An owner whose open items cannot be read is left alone that minute.
 */
export async function sweepCopilotQuestions(deps: {
  notifications: Pick<NotificationService, "unresolvedBySource" | "setStatus" | "releaseHeldForNous">;
  sources: readonly NotificationSource[];
  openItemIds(owner: string): Promise<Set<string>>;
  paneOpen(paneId: string): Promise<boolean>;
  holds(owner: string): Promise<boolean>;
  now?: () => number;
}): Promise<{ resolved: number; released: number }> {
  const now = deps.now ?? Date.now;
  const byOwner = new Map<string, SpaceNotification[]>();
  for (const source of deps.sources) {
    for (const item of await deps.notifications.unresolvedBySource(source)) {
      if (isCopilotQuestion(item)) byOwner.set(item.ownerUserId, [...(byOwner.get(item.ownerUserId) ?? []), item]);
    }
  }
  let resolved = 0;
  let released = 0;
  for (const [owner, items] of byOwner) {
    const open = await deps.openItemIds(owner).catch(() => null);
    if (!open) continue;
    let holds: boolean | null = null;
    for (const item of items) {
      const itemId = copilotQuestionItemId(item);
      if ((itemId && !open.has(itemId)) || (item.paneId && !(await deps.paneOpen(item.paneId)))) {
        if (await deps.notifications.setStatus(owner, item.id, "RESOLVED")) resolved += 1;
        continue;
      }
      if (!item.payload.heldForNous) continue;
      holds ??= await deps.holds(owner).catch(() => false);
      if ((!heldForNous(item, now()) || !holds) && await deps.notifications.releaseHeldForNous(owner, item.id)) released += 1;
    }
  }
  return { resolved, released };
}
