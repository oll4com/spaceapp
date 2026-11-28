import { SpaceApiError } from "../../api.js";
import type { DockConfirmOptions } from "../dock-kit/DockKit.js";
import { uiLanguageNow, uiText } from "../ui-language/ui-language.js";

export type CloseConfirm = (options: DockConfirmOptions) => Promise<boolean>;

// One in-app question at a time: a multi-room delete asks per room, and a new dock confirm would cancel the open one.
let asking: Promise<unknown> = Promise.resolve();
function ask(confirm: CloseConfirm, message: string): Promise<boolean> {
  const language = uiLanguageNow();
  const answer = asking.then(() => confirm({ title: uiText(language, "Close anyway?"), message, confirmLabel: uiText(language, "Close anyway"), cancelLabel: uiText(language, "Cancel") }));
  asking = answer.catch(() => undefined);
  return answer;
}

/**
 * A pane the server refuses to close asks the operator in the app (never window.confirm), then forces it: a Marketing Copilot pane with approved
 * posts still scheduled (operator rule 9/11), or a pane an unanswered Needs you item or browser handoff waits on (15/11 nous_msg:9f70dbbe; its
 * requests move to Needs you, never resolve).
 */
export async function closeOrConfirm<T>(close: (force: boolean) => Promise<T>, confirm: CloseConfirm): Promise<T> {
  try {
    return await close(false);
  } catch (error) {
    if (!(error instanceof SpaceApiError)) throw error;
    const language = uiLanguageNow();
    if (error.code === "PANE_WAITS_FOR_OPERATOR") {
      const held = error.details as { needsYou?: unknown[]; handoff?: boolean };
      const what = [...(held.needsYou?.length ? [uiText(language, "{count} unanswered Needs you items", { count: held.needsYou.length })] : []),
        ...(held.handoff ? [uiText(language, "a browser handoff")] : [])].join(", ");
      if (!(await ask(confirm, uiText(language, "This pane waits for you: {what}. Close it anyway? Its requests stay in Needs you.", { what })))) throw error;
      return close(true);
    }
    if (error.code !== "PANE_HAS_SCHEDULED_POSTS") throw error;
    const next = error.details as { scheduledPosts: number; nextPostTitle: string | null; nextChannel: string; nextScheduledAt: string };
    const vars = { count: next.scheduledPosts, title: next.nextPostTitle ?? next.nextChannel, channel: next.nextChannel, time: new Date(next.nextScheduledAt).toLocaleString() };
    if (!(await ask(confirm, uiText(language, "A Marketing Copilot pane still has {count} approved posts scheduled; the next, \"{title}\", goes to {channel} at {time}. Close it anyway?", vars)))) throw error;
    return close(true);
  }
}
