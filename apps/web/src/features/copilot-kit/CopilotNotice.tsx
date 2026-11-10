import { isTransientUpstreamErrorMessage } from "../../app-shell-utils.js";
import { useCoreApiOutage } from "../../core-api-availability.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";

/** A copilot pane's notice strip. A request that failed while Space restarts stays hidden under the calm global notice and goes
 *  the moment Space answers; past CORE_API_OUTAGE_MS it shows, red like the global banner (nous_msg:1be51d08). A pane whose first
 *  read failed meanwhile (`loaded` false) says it is loading, so its empty tabs do not read as "nothing here". */
export function CopilotNotice({ text, loaded = true }: { text: string | null | undefined; loaded?: boolean }) {
  const calm = useCalmUpstreamError(text);
  const language = useUiLanguage();
  if (!text) return null;
  if (calm) return loaded ? null : <div className="jc-notice is-calm" role="status">{uiText(language, "Loading…")}</div>;
  return <div className="jc-notice" role="status">{text}</div>;
}

/** A transient upstream error while the outage is not yet `down`: the copilot strip and rail treat it as "still loading". */
export function useCalmUpstreamError(text: string | null | undefined): boolean {
  const outage = useCoreApiOutage();
  return Boolean(text) && isTransientUpstreamErrorMessage(text ?? "") && outage?.phase !== "down";
}
