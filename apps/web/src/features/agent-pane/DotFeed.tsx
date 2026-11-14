import { useState } from "react";
import { dotPersonalities, type AgentPaneTaskRun, type DotCharacter, type DotFeedItem, type DotMood } from "@space/contracts";
import { Bell, Check, CircleAlert, ExternalLink, Loader2, Mic, Paperclip, Slack, Sparkles, Users, X } from "../ui-theme/app-icons.js";
import { readDateTimeSettings, type DateTimeSettings } from "../date-time-settings/date-time-settings.js";
import { ChatCopyButton, ChatMarkdown } from "./ChatMarkdown.js";
import { TaskDetails } from "./TaskDetails.js";
import { DotAvatar } from "./DotAvatar.js";
import { CodexSteps, type CodexReplySteps } from "./CodexTranscript.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

type Translate = (text: string, vars?: Record<string, string | number>) => string;
const english: Translate = (text, vars) => uiText("en", text, vars);

const HOUR = 3_600_000;
function zone(settings: DateTimeSettings): string | undefined {
  return settings.timeZone && settings.timeZone !== "system" ? settings.timeZone : undefined;
}
function dayKey(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(date);
}
/** "Today 8:06 PM", "Yesterday 9:14 AM", "Oct 7 1:37 PM", "Oct 7, 2025 1:37 PM" in the user's SpaceApp time zone and clock. */
export function dotFeedSeparatorLabel(value: string, now = new Date(), settings: DateTimeSettings = readDateTimeSettings(), t: Translate = english): string {
  const date = new Date(value);
  const timeZone = zone(settings);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: settings.timeFormat !== "24h",
    ...(timeZone ? { timeZone } : {}) }).format(date);
  const day = dayKey(date, timeZone);
  if (day === dayKey(now, timeZone)) return t("Today {time}", { time });
  if (day === dayKey(new Date(now.getTime() - 24 * HOUR), timeZone)) return t("Yesterday {time}", { time });
  const sameYear = day.slice(0, 4) === dayKey(now, timeZone).slice(0, 4);
  const date_ = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }),
    ...(timeZone ? { timeZone } : {}) }).format(date);
  return `${date_} ${time}`;
}
/** A separator starts the feed, a new day, or a gap of an hour or more. */
export function needsDotFeedSeparator(previous: DotFeedItem | undefined, item: DotFeedItem, settings: DateTimeSettings = readDateTimeSettings()): boolean {
  if (!previous) return true;
  const gap = Date.parse(item.createdAt) - Date.parse(previous.createdAt);
  return gap >= HOUR || dayKey(new Date(previous.createdAt), zone(settings)) !== dayKey(new Date(item.createdAt), zone(settings));
}

const eventIcon = (item: DotFeedItem) => item.origin === "APPROVAL" ? (/^Declined\b/.test(item.summary ?? "") ? X : Check)
  : item.origin === "SCHEDULE" ? Bell : item.origin === "GOAL" ? Sparkles : item.origin === "DELEGATION" ? Users : Sparkles;

function FeedEvent({ item }: { item: DotFeedItem }) {
  const language = useUiLanguage();
  const t: Translate = (text, vars) => uiText(language, text, vars);
  const [open, setOpen] = useState(false);
  const Icon = eventIcon(item);
  return <div className="dots-feed-event" data-origin={item.origin}>
    <Icon aria-hidden="true" />
    <span>{item.summary ?? item.content.slice(0, 200)}</span>
    {item.content.trim() !== (item.summary ?? "").trim() ? <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {open ? t("Hide details") : t("Details")}</button> : null}
    {open ? <p className="dots-feed-event-details">{item.content}</p> : null}
  </div>;
}

export interface DotFeedLiveRun { status: string; elapsedSeconds: number; progress: string | null }

function elapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.max(0, seconds % 60)).padStart(2, "0")}`;
}

/** One Dot's conversation as the user sees it: bubbles, one-line events, date separators and the running task. */
export function DotFeed({ dot, mood = "idle", motion = true, items, status, hasOlder, loadingOlder, onLoadOlder, onRetry, running, latestRun, steps }: {
  dot: { name: string; character: DotCharacter };
  mood?: DotMood;
  motion?: boolean;
  items: DotFeedItem[];
  status: "loading" | "ready" | "unavailable";
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onRetry: () => void;
  running: DotFeedLiveRun | null;
  latestRun: AgentPaneTaskRun | null;
  /** Codex's work behind each reply (Chat panes): shown closed above the reply, and live under the working bubble. */
  steps?: CodexReplySteps | null;
}) {
  const language = useUiLanguage();
  const t: Translate = (text, vars) => uiText(language, text, vars);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const settings = readDateTimeSettings();
  const now = new Date();
  return <main className="dots-feed" role="log" aria-live="polite" aria-label={t("Conversation with {name}", { name: dot.name })}>
    {hasOlder ? <button type="button" className="dots-feed-older" disabled={loadingOlder} onClick={onLoadOlder}>
      {loadingOlder ? t("Loading earlier messages…") : t("Show earlier messages")}</button> : null}
    {status === "loading" && !items.length ? <p className="dots-feed-state" role="status"><Loader2 aria-hidden="true" />{t("Loading conversation")}</p> : null}
    {status === "unavailable" ? <p className="dots-feed-state" role="status">{t("Earlier messages are unavailable.")}
      <button type="button" onClick={onRetry}>{t("Retry")}</button></p> : null}
    {status === "ready" && !items.length && !running ? <section className="dots-feed-welcome" aria-label={t("Start talking with {name}", { name: dot.name })}>
      <DotAvatar character={dot.character} mood={mood} size={104} motion={motion ? "on" : "off"} />
      <h2>{t("Hi, I'm {name}", { name: dot.name })}</h2>
      <span className="dots-feed-archetype">{dotPersonalities[dot.character].archetype}</span>
      <p className="dots-feed-greeting">{dotPersonalities[dot.character].greeting}</p>
      <p>{t("Send me a message. I keep one conversation with you across all your rooms.")}</p>
    </section> : null}
    {items.map((item, index) => {
      const previous = items[index - 1];
      const separator = needsDotFeedSeparator(previous, item, settings);
      const newConversation = item.conversationStart && Boolean(previous) && previous!.sessionId !== item.sessionId;
      const title = new Date(item.createdAt).toLocaleString("en-US");
      return <div className="dots-feed-row" key={item.id} data-author={item.author}>
        {separator ? <div className="dots-feed-separator" role="separator" aria-label={dotFeedSeparatorLabel(item.createdAt, now, settings, t)}>
          <span>{dotFeedSeparatorLabel(item.createdAt, now, settings, t)}</span></div> : null}
        {newConversation ? <div className="dots-feed-divider" role="separator" aria-label={t("New conversation")}><span>{t("New conversation")}</span></div> : null}
        {steps?.byReply.get(item.id) ? <CodexSteps steps={steps.byReply.get(item.id)!} /> : null}
        {item.kind === "EVENT" ? <FeedEvent item={item} />
          : item.author === "USER" ? <article className="dots-bubble user" title={title}>
            {item.content ? <p>{item.content}</p> : null}
            {item.attachments.length ? <ul className="dots-bubble-files" aria-label={t("Attached files")}>
              {item.attachments.map((file, index) => <li key={`${file.name}:${index}`}><Paperclip aria-hidden="true" /><span>{file.name}</span></li>)}
            </ul> : null}
            {item.origin === "VOICE" ? <span className="dots-bubble-tag"><Mic aria-hidden="true" />{t("Voice")}</span>
              : item.origin === "CHANNEL" ? <span className="dots-bubble-tag"><Slack aria-hidden="true" />{t("From Slack or Teams")}</span> : null}
          </article>
          : <article className={`dots-bubble dot${item.status === "FAILED" ? " failed" : ""}${item.kind === "NOTICE" ? " notice" : ""}`} title={title}>
            {item.status === "FAILED" ? <p className="dots-bubble-failed"><CircleAlert aria-hidden="true" />{item.content || t("This task could not finish.")}</p>
              // A notice may quote email: it is plain text, so nothing in it becomes a link; Space adds the only link.
              : item.kind === "NOTICE" ? <p className="dots-notice-text">{item.content}</p>
              : <ChatMarkdown content={item.content} />}
            {item.link ? <a className="dots-bubble-link" href={item.link.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden="true" />{item.link.label}</a> : null}
            {item.status !== "FAILED" ? <div className="dots-bubble-actions">
              <ChatCopyButton text={item.content} label={t("Copy")} />
              {latestRun && item.runId === latestRun.runId ? <button type="button" data-task-details-run={latestRun.runId} aria-expanded={detailsFor === item.id}
                onClick={() => setDetailsFor((value) => value === item.id ? null : item.id)}>{detailsFor === item.id ? t("Hide details") : t("Details")}</button> : null}
            </div> : null}
            {detailsFor === item.id && latestRun ? <TaskDetails key={latestRun.runId} run={latestRun} /> : null}
          </article>}
      </div>;
    })}
    {running ? <article className="dots-bubble dot working" role="status" aria-label={t("{name} is working", { name: dot.name })}>
      <DotAvatar character={dot.character} mood="working" size={26} motion={motion ? "on" : "off"} className="dots-working-avatar" />
      <span className="dots-typing" aria-hidden="true"><span /><span /><span /></span>
      <span className="dots-working-label">{running.status === "QUEUED" ? t("{name} is about to start", { name: dot.name }) : running.status === "INTERRUPTING"
        ? t("{name} is stopping", { name: dot.name }) : t("{name} is working", { name: dot.name })} · <time>{elapsed(running.elapsedSeconds)}</time></span>
      {running.progress ? <p className="dots-working-progress">{running.progress}</p> : null}
      {steps?.pending.length ? <CodexSteps steps={steps.pending} /> : null}
    </article> : null}
  </main>;
}
