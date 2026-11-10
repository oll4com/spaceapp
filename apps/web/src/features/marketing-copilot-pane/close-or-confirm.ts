import { SpaceApiError } from "../../api.js";
import { uiLanguageNow, uiText } from "../ui-language/ui-language.js";

/** A Marketing Copilot pane with approved posts still scheduled refuses to close (operator rule 9/11): the operator confirms, then forces it. */
export async function closeOrConfirm<T>(close: (force: boolean) => Promise<T>): Promise<T> {
  try {
    return await close(false);
  } catch (error) {
    if (!(error instanceof SpaceApiError) || error.code !== "PANE_HAS_SCHEDULED_POSTS") throw error;
    const next = error.details as { scheduledPosts: number; nextPostTitle: string | null; nextChannel: string; nextScheduledAt: string };
    const vars = { count: next.scheduledPosts, title: next.nextPostTitle ?? next.nextChannel, channel: next.nextChannel, time: new Date(next.nextScheduledAt).toLocaleString() };
    if (!window.confirm(uiText(uiLanguageNow(), "A Marketing Copilot pane still has {count} approved posts scheduled; the next, \"{title}\", goes to {channel} at {time}. Close it anyway?", vars))) throw error;
    return close(true);
  }
}
