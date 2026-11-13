import { Fragment, useEffect, useState } from "react";
import { artifactIdsIn, NEEDS_YOU_DONE_ANSWERS, NEEDS_YOU_GO_NOW, NEEDS_YOU_QUESTION_MORE, needsYouAnswerKind, needsYouAsk, needsYouGroup, needsYouHasPlace, needsYouLayout, needsYouMail, needsYouPlace, needsYouTranslation, needsYouFiles, FREELANCE_CHANNEL_LABELS, MARKETING_CHANNEL_LABELS,
  type MailComposeInput, type MailCopilotEvent, type MailParticipant, type MailThread, type NotificationAnswerInput, type NousOverview, type NousPaneBoardPane, type SpaceNotification, type UiLanguage } from "@space/contracts";
import { api } from "../../api.js";
import { ChatMarkdown } from "../agent-pane/ChatMarkdown.js";
import { browserTimeZone, formatUserTime, readDateTimeSettings } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockIconButton } from "../dock-kit/DockKit.js";
import { ackNotification, goToNeedsYouPane, refreshNotifications } from "../notifications/notification-store.js";
import { labelIds } from "../nous/needs-you-ids.js";
import { useNousUiIds } from "../nous/nous-ui-state.js";
import { AlertTriangle, ArrowUpRight, Check, ChevronDown, ChevronUp, CircleHelp, ClipboardCheck, Clock, KeyRound, Mail, MousePointer2, Send, Smartphone, X } from "../ui-theme/app-icons.js";
import { useAgentLanguage, useUiLanguage, uiServerText, uiSourceLabel, uiText } from "../ui-language/ui-language.js";
import { NeedsYouChoices, RecommendedBadge, choiceCaption, type NeedsYouChoice, type NeedsYouStudio } from "./NeedsYouChoices.js";
import { NeedsYouFiles } from "./NeedsYouFiles.js";
import "./needs-you.css";

/**
 * One Needs you card everywhere (plan clipboard:ytwWl09xNH0Z, mockups approved by the operator 3/11 ~19:53 BKK): closed it is a title, one
 * line (kind · who · when), ONE answer and Details; open it says each part once, in a fixed order (what it needs, steps, about, what was
 * checked, the answers). What it offers follows where the work is (needsYouPlace): off Space "Done, all good" / "There is a problem", here the
 * card's answers, in a pane Go (only on the operator's click). Nothing here moves the screen by itself.
 */
export type NeedsYouBoardPane = NousPaneBoardPane & { roomName: string; lineLanguage: UiLanguage };
type Kind = "off" | "ask" | "review" | "pane";
const KIND_OF = { OFF_SPACE: "off", QUESTIONS: "ask", APPROVALS: "review", PANE: "pane" } as const;
const KIND_LABEL: Record<Kind, string> = { off: "Off Space", ask: "Question", review: "Approval", pane: "In a pane" };
const STEPS_SHOWN = 5;
const CHANNEL_LABELS: Record<string, string> = { ...MARKETING_CHANNEL_LABELS, ...FREELANCE_CHANNEL_LABELS };
/** What a Marketing or Freelance review's Approve sends (payload.review, R24-2): the REVIEW layout shows it (plan clipboard:T2uboz26Oh3q S8). */
function reviewDraft(item: SpaceNotification): { channel: string; text: string } | null {
  const review = item.payload.review as { channel?: unknown; text?: unknown } | undefined;
  return typeof review?.text === "string" && review.text.trim() ? { channel: typeof review.channel === "string" ? CHANNEL_LABELS[review.channel] ?? review.channel : "", text: review.text.trim() } : null;
}
const [DONE_OK, PROBLEM] = NEEDS_YOU_DONE_ANSWERS;

/** A card body as markdown, line by line: "• " rows are list items ("Step N:" ones numbered), every other line keeps its break. */
export function needsYouMarkdown(text: string): string {
  const lines = text.split("\n").map((line) => {
    const step = /^\s*(?:•\s*)?(?:Step|Βήμα)\s+(\d+)\s*[:.)]\s*(.*)$/i.exec(line);
    const item = /^\s*•\s*(.*)$/.exec(line);
    return step ? { list: true, text: `${step[1]}. ${step[2]}` } : item ? { list: true, text: `- ${item[1]}` } : { list: false, text: `${line}  ` };
  });
  // A blank line where a list starts or ends, so a list never runs into the text around it.
  return lines.map((line, index) => {
    const previous = lines[index - 1];
    return (previous && previous.list !== line.list && previous.text.trim() && line.text.trim() ? "\n" : "") + line.text;
  }).join("\n");
}

/** Today in the operator's zone (Settings → Date & time), for "due today". */
const dayIn = (date: Date) => {
  const zone = readDateTimeSettings().timeZone;
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone && zone !== "system" ? zone : browserTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
};
export function needsYouDueToday(plan: { dueAt?: string | null; overdue?: boolean } | undefined, now = new Date()): boolean {
  return Boolean(plan?.dueAt && (plan.overdue || dayIn(new Date(plan.dueAt)) === dayIn(now)));
}
/** The soonest due date among the plans a card unblocks. */
export const soonestDue = (plans: NousOverview["plans"]) => plans.filter((plan) => plan.dueAt).sort((left, right) => left.dueAt!.localeCompare(right.dueAt!))[0];

/** The mail a card is about as the operator reads it (operator 12/11 23:19 BKK): a review's reply (what Approve sends), else the thread's newest message. */
interface MailPreview { from: string; to: string; cc: string; subject: string; at: string | null; text: string; attachments: string[] }
const who = (person: MailParticipant) => person.name ? `${person.name} <${person.address}>` : person.address;
function reviewPreview(event: MailCopilotEvent | undefined): MailPreview | null {
  const draft = event?.payload.draft as MailComposeInput | undefined;
  if (!draft) return null;
  const files = Array.isArray(event!.payload.attachments) ? event!.payload.attachments as Array<{ filename?: unknown }> : [];
  return { from: draft.account, to: draft.to.join(", "), cc: (draft.cc ?? []).join(", "), subject: draft.subject, at: null, text: draft.text, attachments: files.map((file) => String(file.filename ?? "")).filter(Boolean) };
}
function threadPreview(thread: MailThread): MailPreview | null {
  const last = thread.messages.at(-1);
  return last ? { from: who(last.from), to: last.to.map(who).join(", "), cc: last.cc.map(who).join(", "), subject: last.subject || thread.subject, at: last.receivedAt ?? null, text: last.text,
    attachments: last.attachments.map((file) => file.filename).filter(Boolean) } : null;
}
/** A mail body this long folds under "Show more". */
const MAIL_FOLD = { lines: 12, characters: 900 };

/** What a card is about from what the record names (plan clipboard:32etNsBgtbI- step 2): the mail it names (needsYouMail), the page, the site. */
function useAbout(item: SpaceNotification, enabled: boolean): { mail: MailPreview | null; page: string | null; site: string | null } {
  const named = needsYouMail(item);
  const [mail, setMail] = useState<MailPreview | null>(null);
  const reviewId = named?.reviewId;
  const account = named?.account;
  const threadId = named?.threadId;
  useEffect(() => {
    if (!enabled || (!reviewId && !(account && threadId))) return;
    let cancelled = false;
    // A review read from the Mail Copilot store; its thread when it has no reply to show (a calendar answer) or is gone.
    const load = async () => (reviewId ? reviewPreview((await api.mailCopilotEvents({ reviewId })).events[0]) : null)
      ?? (account && threadId ? threadPreview((await api.mailThread(item.paneId ?? undefined, account, threadId)).thread) : null);
    void load().then((preview) => { if (!cancelled) setMail(preview); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [enabled, item.paneId, reviewId, account, threadId]);
  const page = /^url:(https?:\/\/\S+)$/.exec(item.link?.target ?? "")?.[1] ?? null;
  return { mail, page, site: typeof item.payload.site === "string" ? item.payload.site : null };
}
const httpsLinks = (text: string) => [...new Set(text.match(/https?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/g) ?? [])];
const linkLabel = (url: string) => { try { const parsed = new URL(url); return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`; } catch { return url; } };

/** Only one run of numbered lines is the steps; steps in several places (a Nous card with several items) stay with their text. */
const STEP_LINE = /^\s*(?:•\s*)?(?:(?:Step|Βήμα)\s+)?\d+\s*[.):]\s/i;
function splitSteps(text: string): { why: string; steps: string[] } {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => STEP_LINE.test(line));
  if (first < 0) return { why: text, steps: [] };
  let end = first;
  while (end < lines.length && STEP_LINE.test(lines[end]!)) end += 1;
  if (lines.slice(end).some((line) => STEP_LINE.test(line))) return { why: text, steps: [] };
  return { why: [...lines.slice(0, first), ...lines.slice(end)].join("\n").trim(), steps: lines.slice(first, end) };
}

export interface NeedsYouCardProps {
  item: SpaceNotification;
  /** peek: the small window (× is Later); row: a line of the Needs you list (the chevron opens it). */
  variant: "peek" | "row";
  pane?: NeedsYouBoardPane;
  unblocks?: NousOverview["plans"];
  /** Controlled open state (the list keeps one card open; the peek pauses its timer). */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  onLater?(): void;
  /** After an answer was sent (the peek shows it a moment, then lets the card go). */
  onAnswered?(): void;
}

export function NeedsYouCard({ item, variant, pane, unblocks = [], open: openProp, onOpenChange, onLater, onAnswered }: NeedsYouCardProps) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = (next: boolean) => { if (onOpenChange) onOpenChange(next); else setOwnOpen(next); };
  const about = useAbout(item, open);
  const ask = needsYouAsk(item);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState(false);
  const [allSteps, setAllSteps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [original, setOriginal] = useState(false);
  const [wholeMail, setWholeMail] = useState(false);
  const [studio, setStudio] = useState<NeedsYouStudio | null>(null);
  const checkedOpen = useNousUiIds("needs.checkedOpen");
  const language = useUiLanguage();
  const t = (words: string, vars?: Record<string, string | number>) => uiText(language, words, vars);
  // Labels and buttons are the interface language; the card's own words (and its answers) the agents' language (operator 2/11 09:51 BKK).
  const agents = useAgentLanguage();
  const translation = needsYouTranslation(item, agents);
  const shown = translation && !original ? translation : null;
  // "Show original" changes the language only: Space's ids read as what they name in both (plan clipboard:T2uboz26Oh3q S6).
  const question = labelIds(shown?.question ?? ask.question, agents);
  // Space's own answer words (Approve, Decline…) read from the one table, never the model's guess (12/11: a shifted translation made both buttons «Απόρριψη»).
  const optionLabel = (option: string) => (uiText(agents, option) !== option ? uiText(agents, option) : shown?.options[(ask.options ?? []).indexOf(option)]) || option;
  const place = needsYouPlace(item, pane?.mode);
  const kind: Kind = KIND_OF[needsYouGroup(item, pane?.mode)];
  const layout = needsYouLayout(item, pane?.mode);
  // A review or rule takes Approve or Decline; words go with them as a note.
  const decision = ask.answer.kind === "COPILOT_DECISION";
  // Operator 4/11 18:42 BKK («δεν μου δινει θεση να γραφω το τηλεφωνο»): a value to type (a phone, a name) leads with its field, closed or open.
  const typed = !ask.code && !decision && ask.answerKind === "text";
  // Go now is the pane's Go button, never one of the answers.
  const options = (ask.options ?? []).filter((option) => option !== NEEDS_YOU_GO_NOW);
  // Off Space with the default hands options (or none): "Done, all good" / "There is a problem" (operator 3/11 19:30 BKK).
  const offDefault = place === "OFF_SPACE" && (!(ask.options ?? []).length || (ask.options ?? []).includes(NEEDS_YOU_GO_NOW));
  const answers = offDefault ? [...NEEDS_YOU_DONE_ANSWERS] : options;
  const recommended = offDefault ? DONE_OK : ask.recommended && ask.recommended !== NEEDS_YOU_GO_NOW ? ask.recommended : null;
  const starred = (option: string) => option === ask.recommended && !offDefault && place !== "OFF_SPACE";

  const answer = async (input: NotificationAnswerInput) => {
    setBusy(true);
    setError(null);
    try {
      setSent((await api.answerNotification(item.id, input)).display);
      setText("");
      setProblem(false);
      onAnswered?.();
      await refreshNotifications();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  // An answer the ask lists goes as its option (scored); Space's off-Space words on a card that does not list them go as the operator's words.
  const pick = (option: string, words?: string) => (ask.options ?? []).includes(option)
    ? answer({ option, ...(words ? { text: words } : {}) })
    : answer({ text: words ? `${option}: ${words}` : option });
  const choose = (option: string) => { if (option === PROBLEM) setProblem(true); else void pick(option, text.trim() || undefined); };

  // The body: Space's ids read as what they name. What Nous checked folds below.
  const body = labelIds(shown?.body ?? item.body, agents);
  const split = body.lastIndexOf("\n\nChecked first:\n");
  const details = (split < 0 ? body : body.slice(0, split)).trim();
  const checked = split < 0 ? "" : body.slice(split + "\n\nChecked first:\n".length).trim();
  // A card whose question is its body clipped (copilots, Space's own cards) says it once: the heading takes the body's line(s) holding the question,
  // the rest is the why (operator 1/11 23:09 BKK). Found in the original text, whose line breaks the translation keeps.
  const ownEnd = item.body.lastIndexOf("\n\nChecked first:\n");
  const asked = ask.question.endsWith(NEEDS_YOU_QUESTION_MORE) ? `${ask.question.slice(0, -NEEDS_YOU_QUESTION_MORE.length)}…` : ask.question;
  const stem = asked.replace(/[\s.…]+$/, "");
  // Agents' cards raised before 1/11 17:50 UTC list their parts under labels (old pane-reports.ts): a clipped summary the report repeats whole,
  // "Needs: <the ask>", "Options: …" (the buttons) and "Report:". The repeats and labels go, the translation's lines at the same places too.
  const ownLines = (ownEnd < 0 ? item.body : item.body.slice(0, ownEnd)).trim().split("\n");
  const said = (line: string, index: number) => {
    const trimmed = line.trim();
    const clipped = trimmed.endsWith("…") ? trimmed.slice(0, -1).trim() : "";
    return trimmed === "Report:" || (Boolean(ask.options?.length) && trimmed.startsWith("Options: "))
      || (clipped.length >= 40 && ownLines.slice(index + 1).some((later) => later.trim().startsWith(clipped)));
  };
  const kept = ownLines.map((line, index) => !said(line, index));
  const label = ownLines.map((line) => line.startsWith("Needs: "));
  const detailLines = details.split("\n");
  const same = detailLines.length === ownLines.length;
  const ownKept = ownLines.flatMap((line, index) => kept[index] ? [label[index] ? line.slice("Needs: ".length) : line] : []);
  const own = ownKept.join("\n");
  const lines = same ? detailLines.flatMap((line, index) => kept[index] ? [label[index] ? line.replace(/^[^:\n]{1,40}:\s*/, "") : line] : []) : detailLines;
  const needsRow = ownLines.slice(0, label.indexOf(true)).filter((_, index) => kept[index]).length;
  const needsAt = label.includes(true) ? ownKept.slice(0, needsRow).join("\n").length + (needsRow ? 1 : 0) : -1;
  const at = !stem ? -1 : needsAt >= 0 && own.startsWith(stem, needsAt) ? needsAt : own.startsWith(stem) || asked.endsWith("…") ? own.indexOf(stem) : -1;
  const leads = at >= 0 && lines.length === own.split("\n").length;
  const from = leads ? own.slice(0, at).split("\n").length - 1 : 0;
  // A question clipped mid-list ("1. … 2. …", the whole ask under Details) takes the list's next items too: they are the ask, not steps.
  const ownRows = own.split("\n");
  let to = leads ? own.slice(0, at + stem.length).split("\n").length : 0;
  if (leads && asked !== ask.question && STEP_LINE.test(ownRows[from] ?? "")) while (to < ownRows.length && STEP_LINE.test(ownRows[to]!)) to += 1;
  const heading = leads ? lines.slice(from, to).join(" ").trim() : question;
  const rest = lines.join("\n").trim();
  const { why, steps } = splitSteps(leads ? [...lines.slice(0, from), ...lines.slice(to)].join("\n").trim() : rest === question ? "" : rest);
  const stepsShown = allSteps ? steps : steps.slice(0, STEPS_SHOWN);

  const where = [pane?.roomName, pane?.name].filter(Boolean).join(" · ");
  const movedOn = pane?.report && pane.report.at > item.createdAt ? pane.report : null;
  // The pane's report is its own words (English); the pane board's line written since says it in the board's language.
  const since = movedOn && pane?.summary.source === "MODEL" && pane.summary.generatedAt >= movedOn.at && pane.lineLanguage === agents ? pane.summary.line : movedOn?.summary ?? "";
  // S5: what changed since the operator's earlier answer to the same question (R16-2), as Nous gave it on its items.
  const answeredSince = (Array.isArray(item.payload.items) ? item.payload.items as Array<{ since?: unknown } | null> : []).flatMap((entry) => typeof entry?.since === "string" ? [entry.since] : []).join(" · ");
  const failed = (item.payload.answerError as { text?: unknown } | undefined)?.text;
  const lastFailure = typeof failed === "string" ? failed : null;
  const draft = about.mail ? null : reviewDraft(item);
  const readText = about.mail?.text ?? draft?.text ?? "";
  const longMail = readText.split("\n").length > MAIL_FOLD.lines || readText.length > MAIL_FOLD.characters;
  const links = httpsLinks(details).filter((url) => url !== about.page);
  const due = soonestDue(unblocks);
  const dueToday = needsYouDueToday(due);
  // R23-3 / S4: what the card asks about by artifact id is shown as a tile, the option that names it answered from it (else captioned by its name).
  const named = new Map<string, NeedsYouChoice>();
  for (const option of ask.options ?? []) for (const id of artifactIdsIn(option)) if (!named.has(id)) {
    named.set(id, { id, option: !ask.code && answers.includes(option) ? option : null, caption: choiceCaption(optionLabel(option)) });
  }
  for (const id of artifactIdsIn(`${ask.question}\n${item.body}`)) if (!named.has(id)) named.set(id, { id, option: null, caption: "" });
  // A chipped file that is no image or video opens from its chip; a tile would say it twice.
  const chipped = new Set(needsYouFiles(item).filter((file) => !/^(?:image|video)\//.test(file.mime)).map((file) => file.artifactId));
  const choices = [...named.values()].filter((choice) => !chipped.has(choice.id));
  const tiled = new Set(choices.map((choice) => choice.option));
  // The approved §8.1 choice: a question about a mail or a page links it inside Details only (never on the closed card); any other card answered
  // here keeps its pane one click away there (a campaign is approved in its pane, a copilot's or Room Agent's card is about its pane).
  // Operator 13/11 07:12 BKK (plan clipboard:T2uboz26Oh3q S2): a card about an open pane, a CLI one too, names it there; still no Go on the closed card.
  const opensPane = place === "HERE" && !needsYouMail(item) && !/^(?:url|tab):/.test(item.link?.target ?? "") ? pane ?? null : null;
  // NousFocus goes only to a card with a place (needsYouHasPlace): a card about a CLI or studio pane names the pane's own default, "activity".
  const toPane = (roomId: string, paneId: string, target?: string) => goToNeedsYouPane({ ...item, roomId, paneId, link: { ...item.link, roomId, paneId, target: target ?? item.link.target ?? "activity" } });
  const opens = place !== "HERE" ? null : needsYouMail(item) ? t("Open the mail") : /^(?:url|tab):/.test(item.link?.target ?? "") ? t("Open the page")
    : opensPane ? t("Open {name}", { name: opensPane.name }) : needsYouHasPlace(item, pane?.mode) ? t("Go to pane") : null;
  const Icon = kind === "off" ? Smartphone : kind === "review" ? ClipboardCheck : kind === "pane" ? MousePointer2
    : ask.code ? KeyRound : needsYouMail(item) ? Mail : CircleHelp;

  const codeForm = (
    <form className="ny-field" onSubmit={(event) => { event.preventDefault(); if (text.trim()) void answer({ text: text.trim() }); }}>
      {/* R27-3: a one-time code goes straight into the pane; the browser may offer the code it just received. */}
      <input value={text} onChange={(event) => setText(event.target.value)} maxLength={2_000} aria-label={t("One-time code")} autoComplete="one-time-code" placeholder={t("Type the code")} data-sensitive-masked="manual" />
      <DockButton type="submit" tone="primary" disabled={busy || !text.trim()}>{t("Send")}</DockButton>
    </form>
  );
  // His words on every card (operator 4/11 18:42 BKK: off Space too): the answer itself on a value ask, else a note with a pick or an answer of its own.
  const wordsForm = (
    <form className="ny-field" onSubmit={(event) => { event.preventDefault(); if (text.trim() && !decision) void answer({ text: text.trim() }); }}>
      <input value={text} onChange={(event) => setText(event.target.value)} maxLength={2_000} aria-label={t("Your answer")} data-sensitive-masked="manual"
        placeholder={t(decision ? "Note (optional)" : typed ? "Type your answer" : answers.length ? "Or answer in your words" : "Your answer")} />
      {decision ? null : <DockButton type="submit" tone={typed ? "primary" : "default"} icon={Send} disabled={busy || !text.trim()}>{t("Send")}</DockButton>}
    </form>
  );
  // The closed card's one answer.
  // A one-time code goes in here even when its card is about a pane: the field leads, Go waits under Details.
  const go = <DockButton tone={ask.code ? "default" : "primary"} onClick={() => goToNeedsYouPane(item)}>{t(item.link?.surface && item.link.target ? "Open" : /^(?:url|tab):/.test(item.link?.target ?? "") ? "Go now" : "Go to pane")}<ArrowUpRight aria-hidden="true" /></DockButton>;
  const primary = ask.code ? codeForm
    : typed ? wordsForm
    : place === "PANE" ? go
    : decision ? <DockButton tone="primary" onClick={() => setOpen(true)}>{t("Review and approve")}</DockButton>
    : recommended ? <DockButton tone="primary" icon={offDefault ? Check : undefined} disabled={busy} data-sensitive-masked="manual" onClick={() => void pick(recommended)}>{choiceCaption(optionLabel(recommended)) || optionLabel(recommended)}</DockButton>
    : <DockButton tone="primary" onClick={() => setOpen(true)}>{t("Answer")}</DockButton>;

  return (
    // nous-decision: the proofs find (and their captures hide) every card by it (space-needs-you-target-proof.mjs CAPTURE_HIDDEN).
    <article className={`nous-decision ny-card is-${variant} kind-${kind} layout-${layout.toLowerCase()}${open ? " is-open" : ""}`} aria-label={shown?.title ?? item.title} data-notification-id={item.id} data-needs-you-place={place}
      data-needs-you-layout={layout}>
      {/* The kind word on hover too: a narrow closed row keeps only its meta line's room · pane · time in sight. */}
      <span className="ny-tile" aria-hidden="true" title={t(KIND_LABEL[kind])}><Icon /></span>
      <div className="ny-head">
        <h3 className="ny-title" data-sensitive-masked="manual">{heading}</h3>
        <p className="ny-meta">
          {/* lang: Space's kind word in the interface language. */}
          <span className="ny-kind" lang={language}>{t(KIND_LABEL[kind])}</span>
          <span className="ny-source">{uiSourceLabel(language, item.source)}</span>
          {item.severity === "URGENT" ? <span className="ny-urgent">{t("Urgent")}</span> : null}
          {due ? <span className={dueToday || due.overdue ? "ny-due" : undefined}><Clock aria-hidden="true" />{due.overdue ? t("Overdue") : dueToday ? t("Due today {time}", { time: formatUserTime(due.dueAt!) }) : t("Due {when}", { when: formatUserTime(due.dueAt!, { withDate: true }) })}</span> : null}
          {where ? <span data-sensitive-masked="manual">{where}</span> : null}
          <span>{formatUserTime(item.createdAt)}</span>
        </p>
      </div>
      {variant === "peek"
        ? <DockIconButton className="ny-corner" label={t("Later")} icon={X} onClick={() => onLater?.()} />
        : <DockIconButton className="ny-corner" label={t(open ? "Less" : "Details")} icon={open ? ChevronUp : ChevronDown} aria-expanded={open} onClick={() => setOpen(!open)} />}
      <NeedsYouFiles item={item} fold={!open} />
      {sent ? <p className="ny-sent" role="status" data-sensitive-masked="manual"><Check aria-hidden="true" />{sent}</p> : !open ? (
        <div className="ny-actions">
          {primary}
          {/* A list row opens on its chevron; the window has a Details button of its own (its corner is Later). */}
          {variant === "peek" ? <DockButton tone="ghost" aria-expanded={false} onClick={() => setOpen(true)}>{t("Details")}<ChevronDown aria-hidden="true" /></DockButton> : null}
        </div>
      ) : (
        <div className="ny-details">
          {why ? <section><h4>{t("What it needs")}</h4><div className="ny-text" data-sensitive-masked="manual"><ChatMarkdown content={needsYouMarkdown(uiServerText(agents, why))} /></div></section> : null}
          {translation ? <p className="ny-translated">{t(original ? "Original" : "Translated")} · <button type="button" className="ny-link" onClick={() => setOriginal(!original)}>{t(original ? "Show translation" : "Show original")}</button></p> : null}
          {stepsShown.length ? (
            <section><h4>{t("Steps")}</h4>
              <div className="ny-text" data-sensitive-masked="manual"><ChatMarkdown content={needsYouMarkdown(uiServerText(agents, stepsShown.join("\n")))} /></div>
              {steps.length > STEPS_SHOWN ? <button type="button" className="ny-link" onClick={() => setAllSteps(!allSteps)}>{allSteps ? t("Fewer steps") : t("{count} more steps", { count: steps.length - STEPS_SHOWN })}</button> : null}
            </section>
          ) : null}
          {about.mail ? (
            <section className="ny-mail" aria-label={t("Mail")}>
              <h4>{t("Mail")}</h4>
              <dl className="ny-facts" data-sensitive-masked="manual">
                <dt>{t("From")}</dt><dd>{about.mail.from}</dd>
                <dt>{t("To")}</dt><dd>{about.mail.to}</dd>
                {about.mail.cc ? <><dt>{t("Cc")}</dt><dd>{about.mail.cc}</dd></> : null}
                <dt>{t("Subject")}</dt><dd>{about.mail.subject || t("(no subject)")}</dd>
                {about.mail.at ? <><dt>{t("Received")}</dt><dd>{formatUserTime(about.mail.at, { withDate: true })}</dd></> : null}
                {about.mail.attachments.length ? <><dt>{t("Attachments")}</dt><dd>{about.mail.attachments.join(" · ")}</dd></> : null}
              </dl>
              <div className={`ny-mail-body${longMail && !wholeMail ? " is-folded" : ""}`} data-sensitive-masked="manual">{about.mail.text.trim()}</div>
              {longMail ? <button type="button" className="ny-link" aria-expanded={wholeMail} onClick={() => setWholeMail(!wholeMail)}>{t(wholeMail ? "Show less" : "Show more")}</button> : null}
            </section>
          ) : draft ? (
            <section className="ny-mail" aria-label={t("Draft")}>
              <h4>{t("Draft")}{draft.channel ? ` · ${draft.channel}` : ""}</h4>
              <div className={`ny-mail-body${longMail && !wholeMail ? " is-folded" : ""}`} data-sensitive-masked="manual">{draft.text}</div>
              {longMail ? <button type="button" className="ny-link" aria-expanded={wholeMail} onClick={() => setWholeMail(!wholeMail)}>{t(wholeMail ? "Show less" : "Show more")}</button> : null}
            </section>
          ) : null}
          <dl className="ny-facts">
            {about.page ? <><dt>{t("Page")}</dt><dd data-sensitive-masked="manual"><a href={about.page} target="_blank" rel="noopener noreferrer">{linkLabel(about.page)}</a></dd></> : null}
            {about.site && !about.page ? <><dt>{t("Site")}</dt><dd data-sensitive-masked="manual">{about.site}</dd></> : null}
            {unblocks.length ? <><dt>{t("Unblocks")}</dt><dd data-sensitive-masked="manual">{unblocks.map((plan) => plan.title).join(" · ")}</dd></> : null}
            {due ? <><dt>{t("Deadline")}</dt><dd data-sensitive-masked="manual">{formatUserTime(due.dueAt!, { withDate: true })}{due.overdue ? `, ${t("overdue")}` : ""}{unblocks.length > 1 ? ` (${due.title})` : ""}</dd></> : null}
            {links.length ? <><dt>{t("Links")}</dt><dd data-sensitive-masked="manual">{links.map((url, index) => <Fragment key={url}>{index ? " · " : ""}<a href={url} target="_blank" rel="noopener noreferrer">{linkLabel(url)}</a></Fragment>)}</dd></> : null}
            {movedOn || answeredSince ? <><dt>{t("Since then")}</dt><dd className="ny-wrap" data-sensitive-masked="manual">{answeredSince ? labelIds(answeredSince, agents) : null}{movedOn && answeredSince ? <br /> : null}{movedOn ? `${formatUserTime(movedOn.at)}: ${labelIds(since, agents)}` : null}</dd></> : null}
          </dl>
          {choices.length ? <NeedsYouChoices choices={choices} recommended={recommended} busy={busy} onChoose={choose} onStudio={setStudio} /> : null}
          {checked ? <details className="ny-checked" open={checkedOpen.has(item.id)} onToggle={(event) => checkedOpen.setOpen(item.id, event.currentTarget.open)}><summary>{t(item.source === "AGENT" ? "What the agent checked" : "What Nous checked")}</summary><div className="ny-text" data-sensitive-masked="manual"><ChatMarkdown content={needsYouMarkdown(checked)} /></div></details> : null}
          {/* A review's note comes before its Approve or Decline, which sends it. */}
          {decision ? wordsForm : null}
          <div className="ny-answers">
            {place === "PANE" ? go : null}
            {ask.code ? codeForm : null}
            {/* The recommended answer first, its own full row with a badge (S7); off Space the default answers keep their order. */}
            {!ask.code ? answers.filter((option) => !tiled.has(option)).sort((a, b) => Number(starred(b)) - Number(starred(a))).map((option) => {
              // A review's two answers never look alike, vouched or not (operator 12/11 21:38 BKK): Approve filled with a tick, Decline outlined with a cross.
              const side = decision && (option === "Approve" || option === "Decline") ? option : null;
              return (
                <DockButton key={option} data-sensitive-masked="manual" className={[side ? `ny-${side.toLowerCase()}` : "", starred(option) ? "is-recommended" : ""].filter(Boolean).join(" ") || undefined} disabled={busy}
                  tone={side ? (side === "Approve" ? "primary" : "default") : option === recommended || (option === PROBLEM && problem) ? "primary" : "default"}
                  icon={side === "Approve" || option === DONE_OK ? Check : side === "Decline" ? X : option === PROBLEM ? AlertTriangle : undefined} aria-pressed={option === PROBLEM ? problem : undefined} onClick={() => choose(option)}>
                  {optionLabel(option)}{starred(option) ? <RecommendedBadge /> : null}
                </DockButton>
              );
            }) : null}
            {!offDefault && ask.recommended && needsYouAnswerKind(item) ? (
              <DockButton tone="ghost" disabled={busy || Boolean(text.trim())} title={t("From now on, Space answers \"{answer}\" to cards like this one without asking you (Settings → Assistants & AI → Nous: Ask me again)", { answer: optionLabel(ask.recommended) })}
                onClick={() => void answer({ option: ask.recommended!, always: true })}>{t("Always answer like this")}</DockButton>
            ) : null}
          </div>
          {problem ? (
            <form className="ny-field" onSubmit={(event) => { event.preventDefault(); if (text.trim()) void pick(PROBLEM, text.trim()); }}>
              <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={2_000} rows={3} aria-label={t("What went wrong?")} placeholder={t("What went wrong?")} data-sensitive-masked="manual" />
              <DockButton type="submit" tone="primary" icon={Send} disabled={busy || !text.trim()}>{t("Send")}</DockButton>
            </form>
          ) : !ask.code && !decision ? wordsForm : null}
          <div className="ny-footer">
            {variant === "peek" ? <button type="button" className="ny-link" onClick={() => setOpen(false)}>{t("Less")}<ChevronUp aria-hidden="true" /></button> : null}
            {studio ? <button type="button" className="ny-link" onClick={() => toPane(studio.roomId, studio.paneId, studio.target)}>{t(studio.source === "DESIGN" ? "Open in Design" : "Open in Video")}<ArrowUpRight aria-hidden="true" /></button> : null}
            {opens && !(studio && opensPane?.paneId === studio.paneId) ? <button type="button" className="ny-link" data-sensitive-masked={opensPane ? "manual" : undefined}
              onClick={() => opensPane && item.roomId && item.paneId ? toPane(item.roomId, item.paneId) : goToNeedsYouPane(item)}>{opens}<ArrowUpRight aria-hidden="true" /></button> : null}
            <button type="button" className="ny-link" title={t("It no longer needs you: remove it")} onClick={() => void ackNotification(item.id)}>{t("It no longer needs me")}</button>
          </div>
        </div>
      )}
      {/* R13-6: an answer that failed keeps the card waiting and says why, closed or open. */}
      {lastFailure && !error && !sent ? <p className="ny-error" role="alert" data-sensitive-masked="manual"><AlertTriangle aria-hidden="true" />{t("Last try failed")}: {lastFailure}</p> : null}
      {error ? <p className="ny-error" role="alert" data-sensitive-masked="manual"><AlertTriangle aria-hidden="true" />{t("Not sent: {reason}", { reason: error })}</p> : null}
    </article>
  );
}
