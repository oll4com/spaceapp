import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { MailCampaign, MailCampaignCheck, MailCampaignPreview, MailCampaignPreviewMail, MailCampaignSend, MailCampaignStats, MailContact, MailHealth, MailList, MailListHealth, MailSender, MailSendStatus,
  MailSuppression, MailTemplate, MailTemplateVersion } from "@space/contracts";
import { api } from "../../api.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Maximize2, Pause, Play, RefreshCw, Search, Square, X } from "../ui-theme/app-icons.js";
import { mailTime, SenderAvatar } from "./MailClient.js";
import { useNousReviewing } from "../copilot-kit/nous-reviewing.js";

// Mail Campaigns in the Mail Copilot pane (plan clipboard:IJ2ovfLg1Lbw step 9): campaigns with every mail they would send (the operator
// reads them one by one, with search and next/previous, and approves exactly what they read), lists with each address's health and the
// do-not-mail list, templates and senders. Agents, Nous and the copilot build campaigns; the operator approves here, or Nous does while
// "May send to third parties" is on (operator 2/11 15:08 BKK): then a campaign in review reads "Nous reviewing" with no Approve.
// Redesign 2/11 (operator: "bad UI; I want a preview of the whole email"): a mail opens as the rendered mail, as an inbox shows it.

type View = "campaigns" | "lists" | "templates" | "senders";
const VIEW_LABELS: Record<View, string> = { campaigns: "Campaigns", lists: "Lists", templates: "Templates", senders: "Senders" };
const STATUS_LABELS: Record<MailCampaign["status"], string> = { DRAFT: "Draft", TESTING: "Testing", IN_REVIEW: "Waits for you", APPROVED: "Approved", SENDING: "Sending",
  PAUSED: "Paused", DONE: "Done", STOPPED: "Stopped" };
const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HEALTH_ORDER: MailHealth[] = ["VALID", "RISKY", "UNKNOWN", "INVALID", "BOUNCED", "COMPLAINED", "UNSUBSCRIBED"];
// Enum values show as lowercase words (tags) or with a count; the English text is the key, the value never changes.
const HEALTH_TAG: Record<MailHealth, string> = { VALID: "valid", RISKY: "risky", UNKNOWN: "unknown", INVALID: "invalid", BOUNCED: "bounced", COMPLAINED: "complained", UNSUBSCRIBED: "unsubscribed" };
const HEALTH_COUNT: Record<MailHealth, string> = { VALID: "{count} valid", RISKY: "{count} risky", UNKNOWN: "{count} unknown", INVALID: "{count} invalid", BOUNCED: "{count} bounced", COMPLAINED: "{count} complained", UNSUBSCRIBED: "{count} unsubscribed" };
const SEND_TAG: Record<MailSendStatus, string> = { PENDING: "pending", SENDING: "sending", SENT: "sent", SKIPPED: "skipped", FAILED: "failed", UNKNOWN: "unknown" };
const SEND_COUNT: Record<MailSendStatus, string> = { PENDING: "{count} pending", SENDING: "{count} sending", SENT: "{count} sent", SKIPPED: "{count} skipped", FAILED: "{count} failed", UNKNOWN: "{count} unknown" };
const SENDER_TAG: Record<MailSender["status"], string> = { SETUP: "setup", ACTIVE: "active", PAUSED: "paused", DISABLED: "disabled" };
const SUPPRESSION_TAG: Record<MailSuppression["reason"], string> = { UNSUBSCRIBE: "unsubscribe", HARD_BOUNCE: "hard bounce", COMPLAINT: "complaint", DO_NOT_CONTACT: "do not contact", MANUAL: "manual" };
type Translate = (text: string, vars?: Record<string, string | number>) => string;
const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
/** "Name <address>" → its parts, for the avatar and the header lines. */
const participant = (value: string) => { const match = /^\s*"?(.*?)"?\s*<([^>]+)>\s*$/.exec(value); return match ? { name: match[1] ?? "", address: match[2] ?? "" } : { name: "", address: value.trim() }; };

function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const language = useUiLanguage();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { setData(await load()); setError(null); } catch (caught) { setError(errorText(caught, uiText(language, "Loading failed."))); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload, setData };
}

export function CampaignsTab({ isVisible, target = null }: { isVisible: boolean; target?: { id: string; at: number } | null }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [view, setView] = useState<View>("campaigns");
  useEffect(() => { if (target) setView("campaigns"); }, [target]);
  return (
    <div className="mc-camp" role="tabpanel" id="jc-panel-campaigns" aria-labelledby="jc-tab-campaigns" data-view={view}>
      <div className="mc-camp-nav" role="tablist" aria-label={t("Mail Campaigns")}>
        {(Object.keys(VIEW_LABELS) as View[]).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} className="mc-camp-nav-tab" onClick={() => setView(id)}>{t(VIEW_LABELS[id])}</button>
        ))}
      </div>
      {view === "campaigns" ? <CampaignsView isVisible={isVisible} target={target} /> : null}
      {view === "lists" ? <ListsView /> : null}
      {view === "templates" ? <TemplatesView /> : null}
      {view === "senders" ? <SendersView /> : null}
    </div>
  );
}

function StatusBadge({ status }: { status: MailCampaign["status"] }) {
  const language = useUiLanguage();
  const nousReviewing = useNousReviewing();
  return <span className="mc-camp-status" data-status={status.toLowerCase()}>{uiText(language, status === "IN_REVIEW" && nousReviewing ? "Nous reviewing" : STATUS_LABELS[status])}</span>;
}

function IconButton({ label, onClick, children, disabled }: { label: string; onClick(): void; children: ReactNode; disabled?: boolean }) {
  return <button type="button" className="mc-camp-icon" aria-label={label} title={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

// ---- campaigns ----------------------------------------------------------------------------------

function CampaignsView({ isVisible, target }: { isVisible: boolean; target: { id: string; at: number } | null }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [openId, setOpenId] = useState<string | null>(target?.id ?? null);
  useEffect(() => { if (target) setOpenId(target.id); }, [target]);
  const campaigns = useLoad(() => api.mailCampaigns().then((answer) => answer.campaigns), []);
  if (openId) return <CampaignDetail id={openId} isVisible={isVisible} onBack={() => { setOpenId(null); void campaigns.reload(); }} />;
  // What waits for the operator comes first; the server's order otherwise.
  const rows = [...(campaigns.data ?? [])].sort((a, b) => Number(b.status === "IN_REVIEW") - Number(a.status === "IN_REVIEW"));
  return (
    <section className="mc-camp-section" aria-label={t("Campaigns")}>
      <div className="mc-camp-bar">
        <span className="mc-camp-bar-title">{t("Campaigns")}{campaigns.data ? <span className="mc-camp-count">{campaigns.data.length}</span> : null}</span>
        <IconButton label={t("Refresh")} onClick={() => void campaigns.reload()}><RefreshCw aria-hidden="true" /></IconButton>
      </div>
      {campaigns.error ? <p className="mc-camp-alert" role="alert">{campaigns.error}</p> : null}
      {campaigns.data && !campaigns.data.length ? <p className="mc-camp-empty">{t("No campaigns yet. Ask the copilot (or Nous) to prepare one; it waits here for your approval.")}</p> : null}
      <ul className="mc-camp-cards">
        {rows.map((campaign) => (
          <li key={campaign.id}>
            <button type="button" className="mc-camp-card" data-status={campaign.status.toLowerCase()} onClick={() => setOpenId(campaign.id)}>
              <span className="mc-camp-card-top"><StatusBadge status={campaign.status} /><time dateTime={campaign.updatedAt}>{mailTime(campaign.updatedAt)}</time></span>
              <strong className="mc-camp-card-name">{campaign.name}</strong>
              {campaign.goal ? <span className="mc-camp-card-goal">{campaign.goal}</span> : null}
              {campaign.audience ? <span className="mc-camp-card-meta">{t("{count} recipients", { count: campaign.audience.eligible })}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function schedule(campaign: MailCampaign, t: Translate): string {
  const { schedule: s, pacing: p } = campaign;
  const pace = p.intervalSeconds ? t("one every {minutes} min", { minutes: Math.round(p.intervalSeconds / 60) }) : t("{count} a minute", { count: p.perMinute });
  const window = `${s.days.map((day) => t(DAY_NAMES[day]!)).join(", ")} ${String(s.fromHour).padStart(2, "0")}:00-${String(s.toHour).padStart(2, "0")}:00 (${s.timeZone})`;
  const head = s.startAt ? t("{window}, from {start}", { window, start: s.startAt.slice(0, 16).replace("T", " ") }) : window;
  return `${head} · ${t("{pace}, at most {count} a day", { pace, count: p.perDay })}${p.maxHardBounces !== undefined ? ` · ${t("stops after {count} hard bounces", { count: p.maxHardBounces })}` : ""}`;
}

function CampaignDetail({ id, isVisible, onBack }: { id: string; isVisible: boolean; onBack(): void }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const nousReviewing = useNousReviewing();
  const detail = useLoad(() => api.mailCampaign(id), [id]);
  const checks = useLoad(() => api.mailCampaignChecks(id).then((answer) => answer.current).catch(() => [] as MailCampaignCheck[]), [id]);
  const [readFingerprint, setReadFingerprint] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const [changed, setChanged] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const campaign = detail.data?.campaign ?? null;
  // A sending campaign's counts move: read them again every 30 s while the pane shows them.
  useEffect(() => {
    if (!isVisible || campaign?.status !== "SENDING") return;
    const timer = window.setInterval(() => void detail.reload(), 30_000);
    return () => window.clearInterval(timer);
  }, [campaign?.status, detail, isVisible]);
  const act = useCallback(async (run: () => Promise<{ campaign: MailCampaign; display?: string }>) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const answer = await run();
      setNotice(answer.display ?? null);
      setConfirming(false);
      await detail.reload();
    } catch (caught) { setNotice(errorText(caught, uiText(language, "That did not work."))); } finally { setBusy(false); }
  }, [busy, detail, language]);
  const onRead = useCallback((fingerprint: string, count: number, contactId?: string) => {
    setReadFingerprint(fingerprint);
    setTotal(count);
    setChanged(campaign?.fingerprint != null && fingerprint !== campaign.fingerprint);
    if (contactId) setSeen((current) => current.has(contactId) ? current : new Set(current).add(contactId));
  }, [campaign?.fingerprint]);
  if (detail.error) return <section className="mc-camp-section"><div className="mc-camp-bar"><IconButton label={t("Campaigns")} onClick={onBack}><ArrowLeft aria-hidden="true" /></IconButton></div><p className="mc-camp-alert" role="alert">{detail.error}</p></section>;
  if (!campaign || !detail.data) return <p className="mc-camp-empty" role="status">{t("Loading the campaign…")}</p>;
  const { stats, recent } = detail.data;
  const waiting = campaign.status === "IN_REVIEW" && !nousReviewing;
  const approvable = waiting && readFingerprint !== null && readFingerprint === campaign.fingerprint && !changed;
  const recipients = campaign.audience?.eligible ?? total;
  return (
    <section className="mc-camp-section mc-camp-detail" aria-label={t("Campaign {name}", { name: campaign.name })}>
      <div className="mc-camp-bar">
        <IconButton label={t("Campaigns")} onClick={onBack}><ArrowLeft aria-hidden="true" /></IconButton>
        <span className="mc-camp-bar-spacer" />
        {campaign.status === "APPROVED" || campaign.status === "SENDING" ? <button type="button" className="mc-camp-button" disabled={busy} onClick={() => void act(() => api.mailCampaignControl(id, "pause"))}><Pause aria-hidden="true" /> {t("Pause")}</button> : null}
        {campaign.status === "PAUSED" ? <button type="button" className="mc-camp-button" disabled={busy} onClick={() => void act(() => api.mailCampaignControl(id, "resume"))}><Play aria-hidden="true" /> {t("Resume")}</button> : null}
        {campaign.status !== "DONE" && campaign.status !== "STOPPED" && campaign.status !== "SENDING" ? <button type="button" className="mc-camp-button danger" disabled={busy} onClick={() => void act(() => api.mailCampaignControl(id, "stop"))}><Square aria-hidden="true" /> {t("Stop")}</button> : null}
        <IconButton label={t("Refresh")} onClick={() => void detail.reload()}><RefreshCw aria-hidden="true" /></IconButton>
      </div>
      <header className="mc-camp-head">
        <StatusBadge status={campaign.status} />
        <h3>{campaign.name}</h3>
        {campaign.goal ? <p>{campaign.goal}</p> : null}
      </header>
      <dl className="mc-camp-tiles">
        <div><dt>{t("Recipients")}</dt><dd className="mc-camp-tile-number">{recipients ?? "…"}</dd></div>
        <div><dt>{t("Sends")}</dt><dd><StatsLine stats={stats} /></dd></div>
        <div className="wide"><dt>{t("When")}</dt><dd>{schedule(campaign, t)}</dd></div>
        {campaign.pauseReason ? <div className="wide"><dt>{t("Paused")}</dt><dd>{campaign.pauseReason}</dd></div> : null}
        {campaign.approval ? <div className="wide"><dt>{t("Approved")}</dt><dd>{mailTime(campaign.approval.at)} ({campaign.approval.via === "RAIL" ? t("by you") : t("through Nous")})</dd></div> : null}
      </dl>
      {checks.data?.length ? <Checks checks={checks.data} /> : null}
      {notice ? <p className="mc-camp-alert" role="status">{notice}</p> : null}
      <CampaignReader campaignId={id} expected={campaign.fingerprint} seen={seen} onRead={onRead} />
      {recent.length ? <RecentSends sends={recent} /> : null}
      {campaign.status === "IN_REVIEW" && nousReviewing ? <p className="mc-camp-decide-text" role="status">{t("Nous reads every mail and approves or declines this campaign (\"May send to third parties\" is on).")}</p> : null}
      {waiting ? (
        <div className="mc-camp-decide" role="group" aria-label={t("Your decision")} data-confirming={confirming ? "true" : "false"}>
          {changed ? <p className="mc-camp-alert" role="alert">{t("The campaign changed while you read it. Refresh and read it again.")}</p> : null}
          {confirming ? (
            <>
              <p className="mc-camp-decide-text">{t("Send these {count} mails to their recipients, {schedule}?", { count: recipients ?? "", schedule: schedule(campaign, t) })}</p>
              <div className="mc-camp-decide-actions">
                <button type="button" className="mc-camp-button" disabled={busy} onClick={() => setConfirming(false)}>{t("Not yet")}</button>
                <button type="button" className="mc-camp-button primary" disabled={busy || !approvable}
                  onClick={() => void act(() => api.decideMailCampaign(id, { decision: "approve", fingerprint: readFingerprint! }))}><Check aria-hidden="true" /> {t("Yes, approve")}</button>
              </div>
            </>
          ) : (
            <>
              <p className="mc-camp-decide-text">
                {total !== null ? <span className="mc-camp-progress" style={{ "--read": `${total ? Math.min(100, (seen.size / total) * 100) : 0}%` } as CSSProperties} aria-hidden="true" /> : null}
                {total !== null ? t("You opened {opened} of {total} mails", { opened: seen.size, total }) : t("Open the mails below; Approve covers exactly the mails you can read here.")}
              </p>
              <div className="mc-camp-decide-actions">
                <button type="button" className="mc-camp-button" disabled={busy} onClick={() => void act(() => api.decideMailCampaign(id, { decision: "decline" }))}><X aria-hidden="true" /> {t("Decline")}</button>
                <button type="button" className="mc-camp-button primary" disabled={busy || !approvable} onClick={() => setConfirming(true)}><Check aria-hidden="true" /> {t("Approve")}</button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** One chip per check kind (the newest run; the server lists newest first), its findings and fixes under it. */
function Checks({ checks }: { checks: MailCampaignCheck[] }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const latest = checks.filter((check, index) => checks.findIndex((other) => other.kind === check.kind) === index);
  return (
    <details className="mc-camp-fold">
      <summary>
        <span className="mc-camp-fold-title">{t("Deliverability")}</span>
        <span className="mc-camp-checks">{latest.map((check) => <span key={check.id} className="mc-camp-check" data-status={check.status.toLowerCase()}>{check.kind} {check.status}</span>)}</span>
      </summary>
      <ul className="mc-camp-check-list">{latest.map((check) => (
        <li key={check.id}><span className="mc-camp-check" data-status={check.status.toLowerCase()}>{check.kind} {check.status}</span>{check.score === null ? null : <span className="mc-camp-muted"> {t("score {score}", { score: check.score })}</span>}
          {((check.details.findings as string[] | undefined) ?? []).map((finding, index) => <p key={index} className="mc-camp-muted">{finding}</p>)}
          {((check.details.fixes as string[] | undefined) ?? []).map((fix, index) => <p key={`f${index}`}>{t("Fix: {fix}", { fix })}</p>)}</li>
      ))}</ul>
    </details>
  );
}

function StatsLine({ stats }: { stats: MailCampaignStats }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const parts = Object.entries(stats.byStatus).map(([status, count]) => SEND_COUNT[status as MailSendStatus] ? t(SEND_COUNT[status as MailSendStatus], { count }) : `${count} ${status.toLowerCase()}`);
  if (stats.bounced.hard || stats.bounced.soft) parts.push(t("{hard} hard / {soft} soft bounces", { hard: stats.bounced.hard, soft: stats.bounced.soft }));
  if (stats.complained) parts.push(t("{count} complaints", { count: stats.complained }));
  if (stats.replied) parts.push(t("{count} replies", { count: stats.replied }));
  if (stats.unsubscribed) parts.push(t("{count} unsubscribed", { count: stats.unsubscribed }));
  return <>{parts.length ? parts.join(" · ") : t("nothing sent yet")}</>;
}

function RecentSends({ sends }: { sends: MailCampaignSend[] }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  return (
    <details className="mc-camp-fold">
      <summary><span className="mc-camp-fold-title">{t("Sends ({count})", { count: sends.length })}</span></summary>
      <ul className="mc-camp-check-list">{sends.map((send) => (
        <li key={send.contactId}><span className="mc-camp-check" data-status={send.status === "SENT" ? "pass" : send.status === "FAILED" ? "fail" : "neutral"}>{SEND_TAG[send.status] ? t(SEND_TAG[send.status]) : send.status.toLowerCase()}</span> {send.address}
          {send.skipReason ? <span className="mc-camp-muted"> · {send.skipReason}</span> : null}{send.sentAt ? <span className="mc-camp-muted"> · {mailTime(send.sentAt)}</span> : null}</li>
      ))}</ul>
    </details>
  );
}

const PAGE = 50;
/** Every mail of the campaign, in send order: a searchable list of recipients and the mail itself with next and previous. */
function CampaignReader({ campaignId, expected, seen, onRead }: { campaignId: string; expected: string | null; seen: ReadonlySet<string>; onRead(fingerprint: string, total: number, contactId?: string): void }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState<MailCampaignPreview | null>(null);
  const [mail, setMail] = useState<MailCampaignPreviewMail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = useCallback(async (contactId: string) => {
    try {
      const answer = await api.mailCampaignPreviewMail(campaignId, contactId);
      setMail(answer);
      onRead(answer.fingerprint, answer.total, contactId);
    } catch (caught) { setError(errorText(caught, uiText(language, "That mail could not be read."))); }
  }, [campaignId, language, onRead]);
  useEffect(() => {
    let live = true;
    api.mailCampaignPreview(campaignId, { q: applied || undefined, offset, limit: PAGE }).then((answer) => {
      if (!live) return;
      setList(answer); setError(null); onRead(answer.fingerprint, answer.total);
      if (!mail && answer.items[0]) void open(answer.items[0].contactId);
    }).catch((caught) => live && setError(errorText(caught, uiText(language, "The mails could not be read."))));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, applied, offset, expected]);
  return (
    <section className="mc-camp-reader" aria-label={t("Every mail of this campaign")}>
      <div className="mc-camp-reader-list">
        <h4>{t("Mails ({total})", { total: list?.total ?? "…" })} <span className="mc-camp-muted">· {t("you opened {count}", { count: seen.size })}</span></h4>
        {list && Object.keys(list.skipped).length ? <p className="mc-camp-muted">{t("Left out: {list}", { list: Object.entries(list.skipped).map(([reason, count]) => `${count} ${reason}`).join(", ") })}</p> : null}
        <form className="mc-camp-search" role="search" onSubmit={(event) => { event.preventDefault(); setOffset(0); setApplied(query.trim()); }}>
          <Search aria-hidden="true" />
          <input type="search" value={query} placeholder={t("Search address, name or subject")} aria-label={t("Search the mails")} onChange={(event) => setQuery(event.target.value)} />
        </form>
        {error ? <p className="mc-camp-alert" role="alert">{error}</p> : null}
        <ol className="mc-camp-mails" start={offset + 1}>
          {(list?.items ?? []).map((item) => (
            <li key={item.contactId}>
              <button type="button" className="mc-camp-mail-row" aria-current={mail?.contactId === item.contactId ? "true" : undefined} data-seen={seen.has(item.contactId) ? "true" : "false"}
                onClick={() => void open(item.contactId)}>
                <SenderAvatar participant={{ name: item.name, address: item.address }} size="sm" checked={seen.has(item.contactId)} />
                <span className="mc-camp-mail-copy">
                  <span className="mc-camp-mail-to">{item.name || item.address}</span>
                  <span className="mc-camp-mail-sub">{item.name ? item.address : item.subject}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
        {list && list.matched > PAGE ? (
          <div className="mc-camp-pager">
            <IconButton label={t("Earlier")} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}><ChevronLeft aria-hidden="true" /></IconButton>
            <span className="mc-camp-muted">{t("{from}-{to} of {total}", { from: offset + 1, to: Math.min(offset + PAGE, list.matched), total: list.matched })}</span>
            <IconButton label={t("Later")} disabled={offset + PAGE >= list.matched} onClick={() => setOffset(offset + PAGE)}><ChevronRight aria-hidden="true" /></IconButton>
          </div>
        ) : null}
      </div>
      {mail ? (
        <article className="mc-camp-mail" aria-label={t("Mail {index} of {total}", { index: mail.index + 1, total: mail.total })}>
          <div className="mc-camp-pager">
            <button type="button" className="mc-camp-button" disabled={!mail.previous} onClick={() => mail.previous && void open(mail.previous)}><ChevronLeft aria-hidden="true" /> {t("Previous")}</button>
            <span className="mc-camp-muted">{t("Mail {index} of {total}", { index: mail.index + 1, total: mail.total })}</span>
            <button type="button" className="mc-camp-button" disabled={!mail.next} onClick={() => mail.next && void open(mail.next)}>{t("Next")} <ChevronRight aria-hidden="true" /></button>
          </div>
          <MailPreview subject={mail.subject} preheader={mail.preheader} from={mail.from} to={mail.name ? `${mail.name} <${mail.to}>` : mail.to} replyTo={mail.replyTo}
            html={mail.html} text={mail.text} frameTitle={t("HTML of the mail to {address}", { address: mail.to })} />
        </article>
      ) : null}
    </section>
  );
}

/** The whole mail as a recipient gets it: its line in the inbox, the header, then the rendered mail (or its plain text), and a full view. */
function MailPreview({ subject, preheader, from, to, replyTo, html, text, frameTitle }: {
  subject: string; preheader: string; from?: string; to?: string; replyTo?: string | null; html: string | null; text: string; frameTitle: string;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [format, setFormat] = useState<"html" | "text">(html ? "html" : "text");
  const full = useRef<HTMLDialogElement>(null);
  const [fullOpen, setFullOpen] = useState(false);
  useEffect(() => { if (fullOpen) full.current?.showModal?.(); }, [fullOpen]);
  const sender = participant(from ?? "");
  // sandbox="" (no allow-same-origin): the mail's own requests must never carry the operator's session cookie (SameSite=Lax).
  const srcDoc = html ? `<!doctype html><meta charset="utf-8"><base target="_blank">${html}` : "";
  const paper = format === "html" && html
    ? <iframe className="mc-camp-paper" title={frameTitle} sandbox="" referrerPolicy="no-referrer" srcDoc={srcDoc} />
    : <pre className="mc-camp-paper mc-camp-paper-text">{text}</pre>;
  const header = (
    <>
      <h4 className="mc-camp-mail-subject">{subject}</h4>
      {from ? (
        <div className="mc-camp-mail-from">
          <SenderAvatar participant={sender} size="sm" />
          <dl>
            <div><dt>{t("From")}</dt><dd><strong>{sender.name || sender.address}</strong>{sender.name ? <span className="mc-camp-muted"> &lt;{sender.address}&gt;</span> : null}</dd></div>
            {to ? <div><dt>{t("To")}</dt><dd>{to}</dd></div> : null}
            {replyTo ? <div><dt>{t("Reply to")}</dt><dd>{replyTo}</dd></div> : null}
          </dl>
        </div>
      ) : null}
    </>
  );
  return (
    <div className="mc-camp-preview">
      <div className="mc-camp-inbox" aria-label={t("In the inbox")}>
        <span className="mc-camp-inbox-label">{t("In the inbox")}</span>
        <span className="mc-camp-inbox-row">
          {from ? <strong className="mc-camp-inbox-from">{sender.name || sender.address}</strong> : null}
          <span className="mc-camp-inbox-text" title={preheader ? `${subject} — ${preheader}` : subject}><strong>{subject}</strong>{preheader ? <span className="mc-camp-muted"> — {preheader}</span> : null}</span>
        </span>
      </div>
      {header}
      <div className="mc-camp-paper-bar">
        <div className="mc-camp-segment" role="tablist" aria-label={t("Mail format")}>
          {html ? <button type="button" role="tab" aria-selected={format === "html"} onClick={() => setFormat("html")}>{t("Preview")}</button> : null}
          <button type="button" role="tab" aria-selected={format === "text"} onClick={() => setFormat("text")}>{t("Plain text")}</button>
        </div>
        <button type="button" className="mc-camp-button" onClick={() => setFullOpen(true)}><Maximize2 aria-hidden="true" /> {t("Full view")}</button>
      </div>
      {paper}
      {fullOpen ? (
        <dialog ref={full} className="mc-camp-full" aria-label={subject} onClose={() => setFullOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
          <div className="mc-camp-full-head">
            <div className="mc-camp-full-title">{header}</div>
            <IconButton label={t("Close")} onClick={() => full.current?.close()}><X aria-hidden="true" /></IconButton>
          </div>
          {paper}
        </dialog>
      ) : null}
    </div>
  );
}

// ---- lists, templates, senders ------------------------------------------------------------------

/** One bar for a list's addresses by health, with the counts in words beside it. */
function HealthBar({ health, t }: { health: MailListHealth; t: Translate }) {
  const members = health.members || 1;
  return (
    <span className="mc-camp-health" title={healthLine(health, t)}>
      <span className="mc-camp-health-bar" aria-hidden="true">
        {HEALTH_ORDER.map((key) => health.byHealth[key] ? <span key={key} data-health={key.toLowerCase()} style={{ width: `${(health.byHealth[key]! / members) * 100}%` }} /> : null)}
      </span>
      <span className="mc-camp-muted">{healthLine(health, t)}</span>
    </span>
  );
}

function ListsView() {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const lists = useLoad(() => api.mailCampaignLists().then((answer) => answer.lists), []);
  const [openList, setOpenList] = useState<(MailList & { health: MailListHealth }) | null>(null);
  const [health, setHealth] = useState("");
  const [query, setQuery] = useState("");
  const [contacts, setContacts] = useState<MailContact[] | null>(null);
  const [suppressions, setSuppressions] = useState<MailSuppression[] | null>(null);
  useEffect(() => {
    if (!openList) return;
    void api.mailCampaignListContacts(openList.id, { health: health || undefined, q: query || undefined }).then((answer) => setContacts(answer.contacts)).catch(() => setContacts([]));
  }, [health, openList, query]);
  if (openList) {
    return (
      <section className="mc-camp-section" aria-label={t("List {name}", { name: openList.name })}>
        <div className="mc-camp-bar"><IconButton label={t("Lists")} onClick={() => { setOpenList(null); setContacts(null); }}><ArrowLeft aria-hidden="true" /></IconButton></div>
        <header className="mc-camp-head"><span className="mc-camp-status" data-status="neutral">{openList.consentBasis}</span><h3>{openList.name}</h3></header>
        <HealthBar health={openList.health} t={t} />
        <div className="mc-camp-filters">
          <select aria-label={t("Health")} value={health} onChange={(event) => setHealth(event.target.value)}>
            <option value="">{t("Every health")}</option>
            {HEALTH_ORDER.map((value) => <option key={value} value={value}>{t(HEALTH_TAG[value])}</option>)}
          </select>
          <label className="mc-camp-search"><Search aria-hidden="true" /><input type="search" aria-label={t("Search contacts")} placeholder={t("Search address or name")} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        </div>
        <ul className="mc-camp-rows">{(contacts ?? []).map((contact) => (
          <li key={contact.id}>
            <SenderAvatar participant={{ name: contact.name ?? "", address: contact.address }} size="sm" />
            <span className="mc-camp-row-copy"><span>{contact.name ? `${contact.name} · ` : ""}{contact.address}</span>
              {contact.healthReasons.length ? <span className="mc-camp-muted">{contact.healthReasons.join("; ")}</span> : null}</span>
            <span className="mc-camp-check" data-health={contact.health.toLowerCase()}>{HEALTH_TAG[contact.health] ? t(HEALTH_TAG[contact.health]) : contact.health.toLowerCase()}</span>
          </li>
        ))}</ul>
        {contacts && contacts.length >= 100 ? <p className="mc-camp-muted">{t("The first 100; search to narrow.")}</p> : null}
      </section>
    );
  }
  return (
    <section className="mc-camp-section" aria-label={t("Lists")}>
      {lists.error ? <p className="mc-camp-alert" role="alert">{lists.error}</p> : null}
      <ul className="mc-camp-cards">{(lists.data ?? []).map((list) => (
        <li key={list.id}><button type="button" className="mc-camp-card" onClick={() => setOpenList(list)}>
          <span className="mc-camp-card-top"><strong className="mc-camp-card-name">{list.name}</strong><span className="mc-camp-status" data-status="neutral">{list.consentBasis}</span></span>
          <HealthBar health={list.health} t={t} /></button></li>
      ))}</ul>
      {lists.data && !lists.data.length ? <p className="mc-camp-empty">{t("No lists yet.")}</p> : null}
      <details className="mc-camp-fold" onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open && !suppressions) void api.mailCampaignSuppressions().then((answer) => setSuppressions(answer.suppressions)).catch(() => setSuppressions([])); }}>
        <summary><span className="mc-camp-fold-title">{t("Never mail these (suppressions)")}</span></summary>
        <ul className="mc-camp-check-list">{(suppressions ?? []).map((row) => <li key={row.pattern}>{row.pattern} <span className="mc-camp-check" data-status="fail">{SUPPRESSION_TAG[row.reason] ? t(SUPPRESSION_TAG[row.reason]) : row.reason.toLowerCase().replaceAll("_", " ")}</span> <span className="mc-camp-muted">{row.source} · {mailTime(row.createdAt)}</span></li>)}</ul>
      </details>
    </section>
  );
}
function healthLine(health: MailListHealth, t: Translate): string {
  const parts = Object.entries(health.byHealth).map(([status, count]) => HEALTH_COUNT[status as MailHealth] ? t(HEALTH_COUNT[status as MailHealth], { count }) : `${count} ${status.toLowerCase()}`);
  const lead = [t("{count} members", { count: health.members }), t("{count} can be mailed", { count: health.sendable }), ...(health.suppressed ? [t("{count} suppressed", { count: health.suppressed })] : [])].join(", ");
  return `${lead}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function TemplatesView() {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const templates = useLoad(() => api.mailCampaignTemplates().then((answer) => answer.templates), []);
  const [open, setOpen] = useState<{ template: MailTemplate; version: MailTemplateVersion } | null>(null);
  if (open) {
    return (
      <section className="mc-camp-section" aria-label={t("Template {name}", { name: open.template.name })}>
        <div className="mc-camp-bar"><IconButton label={t("Templates")} onClick={() => setOpen(null)}><ArrowLeft aria-hidden="true" /></IconButton></div>
        <header className="mc-camp-head">
          <span className="mc-camp-status" data-status="neutral">{t("version {version}", { version: open.version.version })} · {open.template.language}</span>
          <h3>{open.template.name}</h3>
        </header>
        <dl className="mc-camp-tiles"><div className="wide"><dt>{t("Fields")}</dt><dd>{open.version.variables.map((variable) => `{{${variable.name}}}`).join(", ") || t("none")}</dd></div></dl>
        <article className="mc-camp-mail"><MailPreview subject={open.version.subject} preheader={open.version.preheader} html={open.version.html || null} text={open.version.text}
          frameTitle={t("HTML of {name}", { name: open.template.name })} /></article>
      </section>
    );
  }
  return (
    <section className="mc-camp-section" aria-label={t("Templates")}>
      {templates.error ? <p className="mc-camp-alert" role="alert">{templates.error}</p> : null}
      <ul className="mc-camp-cards">{(templates.data ?? []).map((template) => (
        <li key={template.id}><button type="button" className="mc-camp-card" onClick={() => void api.mailCampaignTemplate(template.id).then((answer) => setOpen(answer))}>
          <span className="mc-camp-card-top"><strong className="mc-camp-card-name">{template.name}</strong><span className="mc-camp-status" data-status="neutral">v{template.currentVersion}</span></span>
          <span className="mc-camp-card-goal">{template.subject}</span></button></li>
      ))}</ul>
      {templates.data && !templates.data.length ? <p className="mc-camp-empty">{t("No templates yet.")}</p> : null}
    </section>
  );
}

const WARMUP = ["50 a day", "100 a day", "200 a day", "400 a day", "800 a day", "1,500 a day", "3,000 a day", "no warm-up cap"];
function SendersView() {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const senders = useLoad(() => api.mailCampaignSenders().then((answer) => answer.senders), []);
  const [notice, setNotice] = useState<string | null>(null);
  const update = async (run: () => Promise<{ sender: MailSender }>) => {
    try { await run(); setNotice(null); await senders.reload(); } catch (caught) { setNotice(errorText(caught, t("That did not work."))); }
  };
  return (
    <section className="mc-camp-section" aria-label={t("Senders")}>
      {notice ? <p className="mc-camp-alert" role="alert">{notice}</p> : null}
      <ul className="mc-camp-cards">{(senders.data ?? []).map((sender) => (
        <li key={sender.id} className="mc-camp-card mc-camp-sender">
          <span className="mc-camp-sender-who">
            <SenderAvatar participant={{ name: sender.displayName, address: sender.address }} />
            <span className="mc-camp-row-copy"><strong>{sender.displayName}</strong><span className="mc-camp-muted">{sender.address}</span></span>
            <span className="mc-camp-status" data-status={sender.status === "ACTIVE" ? "approved" : sender.status === "DISABLED" ? "stopped" : "paused"}>{SENDER_TAG[sender.status] ? t(SENDER_TAG[sender.status]) : sender.status.toLowerCase()}</span>
          </span>
          <span className="mc-camp-muted">{sender.config.route === "SMTP" ? `SMTP ${sender.config.host}:${sender.config.port}` : sender.config.route === "GMAIL_CONNECTOR" ? t("Gmail ({account})", { account: sender.config.account }) : t("Workspace ({subject})", { subject: sender.config.subject })}
            {" "}· {t("at most {perMinute} a minute and {perDay} a day", { perMinute: sender.caps.perMinute, perDay: sender.caps.perDay })}</span>
          <span className="mc-camp-sender-controls">
            <label className="mc-camp-inline">{t("Warm-up")}
              <select value={sender.warmup.stage} aria-label={t("Warm-up of {address}", { address: sender.address })} onChange={(event) => void update(() => api.setMailSenderWarmup(sender.id, Number(event.target.value)))}>
                {WARMUP.map((label, stage) => <option key={stage} value={stage}>{t(label)}</option>)}
              </select>
            </label>
            <SpaceToggle compact label={t("Bulk mail")} checked={sender.bulk} onChange={(checked) => void update(() => api.setMailSenderBulk(sender.id, checked))}
              detail={sender.bulkNote ?? undefined} />
          </span>
        </li>
      ))}</ul>
      {senders.data && !senders.data.length ? <p className="mc-camp-empty">{t("No senders yet.")}</p> : null}
    </section>
  );
}
