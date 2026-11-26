import type { NousState } from "@space/contracts";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockState } from "../dock-kit/DockKit.js";
import { Nous } from "../ui-theme/app-icons.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import { FileMentionText } from "../terminal-pane/AgentFileLinks.js";
import "./nous-done.css";

const ABOUT = "Pane and copilot notices waiting for Nous's next round. Nous reads them all together, then the list empties.";

/** Nous › Inbox (nous_msg:eb36261e): what the rail's Inbox count is, oldest first. */
export function NousInboxQueue({ items }: { items: NonNullable<NousState["inboxItems"]> }) {
  const language = useUiLanguage();
  const t = (text: string) => uiText(language, text);
  return <div className="nous-decisions nous-done" data-nous-inbox>
    {items.length ? <p className="nous-muted">{t(ABOUT)}</p>
      : <DockState kind="empty" icon={Nous} title={t("Nothing waits for Nous")} detail={t(ABOUT)} />}
    {items.map((item) => <article key={item.key} className="nous-done-entry" data-inbox-key={item.key}>
      <div className="nous-done-meta"><span>{item.key}</span>{item.at ? <time dateTime={item.at}>{formatUserTime(item.at)}</time> : null}</div>
      <p className="nous-done-summary"><FileMentionText text={item.text} /></p>
    </article>)}
  </div>;
}
