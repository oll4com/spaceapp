import { inboxPlainLine, type NousState } from "@space/contracts";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import { FileMentionText } from "../terminal-pane/AgentFileLinks.js";
import "./nous-done.css";

const ABOUT = "Pane and copilot notices waiting for Nous's next round. Nous reads them all together, then the list empties.";

/**
 * Nous's own queue (nous_msg:eb36261e), oldest first. Operator 27/11: it asks nothing of him, so it is one fold under Requests, never in
 * Needs you; each notice is one plain line, its whole text behind it.
 */
export function NousInboxQueue({ items }: { items: NonNullable<NousState["inboxItems"]> }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  if (!items.length) return null;
  return <details className="nous-inbox-held" data-nous-inbox>
    <summary>{t("Waiting for Nous's next round ({count})", { count: items.length })}</summary>
    <p>{t(ABOUT)}</p>
    <ul>{items.map((item) => <li key={item.key} data-inbox-key={item.key}><details>
      <summary>{item.at ? <time dateTime={item.at}>{formatUserTime(item.at)}</time> : null} {inboxPlainLine(item.text)}</summary>
      <p className="nous-done-summary"><FileMentionText text={item.text} /></p>
    </details></li>)}</ul>
  </details>;
}
