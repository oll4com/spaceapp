import { Fragment, useEffect, useState, type ReactNode } from "react";
import { artifactIdsIn, NEEDS_YOU_CHECK_AGAIN, NEEDS_YOU_DONE_ANSWERS, NEEDS_YOU_GO_NOW, NEEDS_YOU_LATER_TODAY, NEEDS_YOU_QUESTION_MORE, needsYouAnswerKind, needsYouAsk, needsYouCompletedAnswer, needsYouGroup, needsYouHasPlace, needsYouLayout, needsYouMail, needsYouMailTranslation, needsYouPlace, needsYouTranslation, needsYouFiles, FREELANCE_CHANNEL_LABELS, MARKETING_CHANNEL_LABELS,
  type InboxAskLive, type MailComposeInput, type MailCopilotEvent, type MailParticipant, type MailThread, type NotificationAnswerInput, type NousOverview, type NousPaneBoardPane, type SpaceNotification, type UiLanguage } from "@space/contracts";
import { api } from "../../api.js";
import { ChatMarkdown } from "../agent-pane/ChatMarkdown.js";
import { browserTimeZone, formatUserTime, readDateTimeSettings } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockIconButton, useDockConfirm } from "../dock-kit/DockKit.js";
import { goToNeedsYouPane, refreshNotifications } from "../notifications/notification-store.js";
import { labelIds } from "../nous/needs-you-ids.js";
import { useNousUiIds } from "../nous/nous-ui-state.js";
import { AlertTriangle, ArrowUpRight, Check, ChevronDown, ChevronUp, CircleHelp, ClipboardCheck, Clock, KeyRound, Mail, MoreHorizontal, MousePointer2, Send, Smartphone, X } from "../ui-theme/app-icons.js";
import { useAgentLanguage, useUiLanguage, uiServerText, uiSourceLabel, uiText } from "../ui-language/ui-language.js";
import { NeedsYouChoices, RecommendedBadge, choiceCaption, type NeedsYouChoice, type NeedsYouStudio } from "./NeedsYouChoices.js";
import { NeedsYouFiles } from "./NeedsYouFiles.js";
import "./needs-you.css";

/**
 * One Needs you card everywhere (plans clipboard:ytwWl09xNH0Z, clipboard:va__qa_eBMYr): closed it is a title, one line, its live line, ONE
 * answer (the recommended one), "N more answers" and Details. Open, in this order: what it needs, chips, numbered answers (in agentLanguage),
 * its own words (Send shows once typed), then one "More" fold (steps, mail/draft, links, since then, checked, original, other answers, history).
 * The ⋯ menu holds Completed, Always answer like this, the opens and "Close without answering" (confirmed). A pane's hands card answers Go,
 * then "I already did it". Nothing here moves the screen by itself.
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
/** When the card asked its question: a pane's card is one record refreshed per ask, so its createdAt is the pane's first ask (nous_msg:832a500e). */
export const needsYouAskedAt = (item: SpaceNotification) => typeof item.payload.alertAt === "string" ? item.payload.alertAt : item.createdAt;

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
  return last ? { from: who(last.from), to: last.to.map(who).join(", "), cc: last.cc.map(who).join(", "), subject: last.subject || thread.subject, at: last.receivedAt ?? null, text: last.html && mostlyLinks(last.text) ? htmlAsText(last.html) : last.text,
    attachments: last.attachments.map((file) => file.filename).filter(Boolean) } : null;
}
/** A text part that is mostly tracking URLs (nous_msg:5bcbe4b0, Upwork): the sanitized HTML reads better. */
const mostlyLinks = (text: string) => (text.match(/https?:\/\/\S+/g) ?? []).join("").length * 2 > text.replace(/\s/g, "").length;
/** Sanitized HTML as text, each link written "label ( URL )" for mailTextParts; DOMParser's document is inert (no scripts, no loads). */
export function htmlAsText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("head, style, script").forEach((node) => node.remove());
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) node.nodeValue = node.nodeValue!.replace(/\s+/g, " ");
  doc.querySelectorAll("a[href^='http']").forEach((link) => link.append(` ( ${link.getAttribute("href")} )`));
  doc.querySelectorAll("br, p, div, tr, li, table, h1, h2, h3, h4, h5, h6").forEach((node) => node.after("\n"));
  return (doc.body.textContent ?? "").replace(/^ +| +$/gm, "");
}
const INVISIBLE = /\u034f|[\u00ad\u200b-\u200f\u2060\ufeff]/g;
const ENTITY = /&(nbsp|amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-f]{1,6});/gi;
const NAMED: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const decodeEntity = (entity: string, name: string) => {
  const code = name[0] !== "#" ? null : /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
  return code === null ? NAMED[name.toLowerCase()]! : code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
};
const MAIL_URL = /\(\s*(https?:\/\/[^\s()]+)\s*\)|<?(https?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?])>?/g;
// One linear pass: an anchored /[ \t]+$/m backtracks quadratically, so a mail with a long blank run froze the card (40k spaces: 2 s per render).
const trimLineEdge = (run: string, at: number, text: string) => at === 0 || text[at - 1] === "\n" || text[at + run.length] === undefined || text[at + run.length] === "\n" ? "" : run;
export type MailTextPart = string | { label: string; href: string };
/** A mail body as the operator reads it (nous_msg:5bcbe4b0): "label ( URL )" is a link named label, a bare URL a link named by its host/path
 *  (60 characters at most), and blank runs one blank line; URLs are found in one linear pass, never by backtracking over a line. */
export function mailTextParts(text: string): MailTextPart[] {
  // Gmail text parts end lines with \r\n and carry HTML entities (micro1 20/11): both go first, then indents, trailing spaces and blank runs.
  const clean = text.replace(/\r\n?/g, "\n").replace(ENTITY, decodeEntity).replace(INVISIBLE, "").replace(/[ \t\u00a0]+/g, trimLineEdge).replace(/\n{3,}/g, "\n\n").trim();
  const parts: MailTextPart[] = [];
  let at = 0;
  for (const match of clean.matchAll(MAIL_URL)) {
    const href = match[1] ?? match[2]!;
    let before = clean.slice(at, match.index);
    let label = linkLabel(href);
    if (label.length > 60) label = label.split("/")[0]!;
    if (match[1]) {
      const start = before.search(/[^\n|•·]*$/);
      const named = before.slice(start).trim();
      if (named) { label = named; before = before.slice(0, start) + before.slice(start).match(/^\s*/)![0]; }
    }
    if (before) parts.push(before);
    parts.push({ label, href });
    at = match.index + match[0].length;
  }
  if (at < clean.length) parts.push(clean.slice(at));
  return parts;
}
const MailText = ({ parts }: { parts: MailTextPart[] }) => <>{parts.map((part, index) => typeof part === "string" ? <Fragment key={index}>{part}</Fragment>
  : <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" title={part.href}>{part.label}</a>)}</>;
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
  /** A plan's card with no pane (the API's plan-needs-you.ts) opens its plan. */
  onOpenPlan?(id: string): void;
  /** A hands card's place now (the Inbox's InboxAsk.live): its first answer follows it. */
  live?: InboxAskLive;
  /** Close without answering in the Inbox closes its Thread (DISMISS); false: it did not work. Without it the card is dismissed on its own. */
  onDismiss?(): Promise<boolean>;
  /** The Thread's history, under More (a Thread whose one ask is this card). */
  history?: ReactNode;
  /** The pane board's panes by id: a pane id in the card's text reads as the pane's name. */
  panes?: ReadonlyMap<string, { name: string }>;
}

// Plan clipboard:va__qa_eBMYr: the generic answers fold under More → Other answers; the card's own answers are numbered.
const GENERIC = new Set<string>([NEEDS_YOU_GO_NOW, "Failed", "Need links/steps", NEEDS_YOU_LATER_TODAY, NEEDS_YOU_CHECK_AGAIN]);
const LIVE_TONE: Record<InboxAskLive["state"], string> = { READY: "", EXPIRED: " is-warn", PAGE_GONE: " is-gone", PANE_CLOSED: " is-gone", MOVED_ON: " is-info" };
interface Answer { key: string; label: string; tone?: "recommended" | "approve" | "decline"; badge?: boolean; icon?: typeof Check; run(): void }
interface MenuItem { key: string; label: string; title?: string; disabled?: boolean; run(): void }

export function NeedsYouCard({ item, variant, pane, unblocks = [], open: openProp, onOpenChange, onLater, onAnswered, onOpenPlan, live, onDismiss, history, panes }: NeedsYouCardProps) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = (next: boolean) => { if (onOpenChange) onOpenChange(next); else setOwnOpen(next); };
  const about = useAbout(item, open);
  const ask = needsYouAsk(item);
  const [text, setText] = useState("");
  const [allSteps, setAllSteps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [original, setOriginal] = useState(false);
  const [wholeMail, setWholeMail] = useState(false);
  const [studio, setStudio] = useState<NeedsYouStudio | null>(null);
  const [more, setMore] = useState(false);
  const [menu, setMenu] = useState(false);
  const { confirm, confirmDialog } = useDockConfirm();
  const checkedOpen = useNousUiIds("needs.checkedOpen");
  const language = useUiLanguage();
  const t = (words: string, vars?: Record<string, string | number>) => uiText(language, words, vars);
  // Labels and menus are the interface language; the card's own words and its answer zone the agents' language (operator 2/11 09:51, 27/11 B).
  const agents = useAgentLanguage();
  const say = (words: string) => uiText(agents, words);
  const ids = (words: string) => labelIds(words, agents, panes);
  const translation = needsYouTranslation(item, agents);
  const shown = translation && !original ? translation : null;
  // "Show original" changes the language only: Space's ids read as what they name in both (plan clipboard:T2uboz26Oh3q S6).
  const question = ids(shown?.question ?? ask.question);
  // Space's own answer words (Approve, Decline…) read from the one table, never the model's guess (12/11: a shifted translation made both buttons «Απόρριψη»).
  const optionLabel = (option: string) => (uiText(agents, option) !== option ? uiText(agents, option) : shown?.options[(ask.options ?? []).indexOf(option)]) || option;
  const place = needsYouPlace(item, pane?.mode);
  const kind: Kind = KIND_OF[needsYouGroup(item, pane?.mode)];
  const layout = needsYouLayout(item, pane?.mode);
  // A review or rule takes Approve or Decline; words go with them as a note.
  const decision = ask.answer.kind === "COPILOT_DECISION";
  // Operator 4/11 18:42 BKK («δεν μου δινει θεση να γραφω το τηλεφωνο»): a value to type (a phone, a name) leads with its field, closed or open.
  const typed = !ask.code && !decision && ask.answerKind === "text";
  // Hands in a pane: 1 is Go, 2 «I already did it» (operator 27/11 A), then the agent's own answers.
  const hands = place === "PANE" && !ask.code && !typed && !decision;
  // Go now is the pane's Go button, never one of the answers.
  const options = (ask.options ?? []).filter((option) => option !== NEEDS_YOU_GO_NOW);
  // Off Space with the default hands options (or none): "Done, all good", a problem in words (operator 3/11 19:30 BKK).
  const offDefault = place === "OFF_SPACE" && (!(ask.options ?? []).length || (ask.options ?? []).includes(NEEDS_YOU_GO_NOW));
  const answers = offDefault ? [...NEEDS_YOU_DONE_ANSWERS] : options;
  const recommended = offDefault ? DONE_OK : ask.recommended && ask.recommended !== NEEDS_YOU_GO_NOW ? ask.recommended : null;
  const starred = (option: string) => option === ask.recommended && !offDefault && place !== "OFF_SPACE";
  const completedAnswer = needsYouCompletedAnswer(item);
  const completed = completedAnswer !== null && !answers.includes(DONE_OK);

  const answer = async (input: NotificationAnswerInput): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      setSent((await api.answerNotification(item.id, input)).display);
      setText("");
      onAnswered?.();
      await refreshNotifications();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  // An answer the ask lists goes as its option (scored); Space's off-Space words on a card that does not list them go as the operator's words.
  const pick = (option: string, words?: string) => (ask.options ?? []).includes(option)
    ? answer({ option, ...(words ? { text: words } : {}) })
    : answer({ text: words ? `${option}: ${words}` : option });
  const choose = (option: string) => void pick(option, text.trim() || undefined);
  const pickCompleted = () => void pick(completedAnswer && "option" in completedAnswer ? completedAnswer.option : DONE_OK, text.trim() || undefined);
  // Operator 27/11 C: one way to close a card unanswered, confirmed first; it cancels the ask like the Inbox's Not relevant.
  const close = async () => {
    setMenu(false);
    if (!(await confirm({ title: t("Close without answering?"), message: t("What it asks is cancelled without an answer."), confirmLabel: t("Close without answering") }))) return;
    setBusy(true);
    setError(null);
    try {
      if (onDismiss) { if (!(await onDismiss())) return; } else { await api.dismissNotification(item.id); onAnswered?.(); await refreshNotifications(); }
      setSent(t("Closed without answering"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  // The body: Space's ids read as what they name. What Nous checked folds below.
  const body = ids(shown?.body ?? item.body);
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
  // A body the question already holds whole (a lead-in + the body) says nothing more.
  const { why, steps } = splitSteps(leads ? [...lines.slice(0, from), ...lines.slice(to)].join("\n").trim() : question.includes(rest) ? "" : rest);
  const stepsShown = allSteps ? steps : steps.slice(0, STEPS_SHOWN);

  const where = [pane?.roomName, pane?.name].filter(Boolean).join(" · ");
  // nous_msg:832a500e: a card about one plan never shows the pane's later report about another plan.
  const cardPlan = typeof item.payload.planId === "string" ? item.payload.planId : null;
  const movedOn = pane?.report && pane.report.at > needsYouAskedAt(item) && !(cardPlan && pane.report.planId && pane.report.planId !== cardPlan) ? pane.report : null;
  // The pane's report is its own words (English); the pane board's line written since says it in the board's language.
  const since = movedOn && pane?.summary.source === "MODEL" && pane.summary.generatedAt >= movedOn.at && pane.lineLanguage === agents ? pane.summary.line : movedOn?.summary ?? "";
  // S5: what changed since the operator's earlier answer to the same question (R16-2), as Nous gave it on its items.
  const answeredSince = (Array.isArray(item.payload.items) ? item.payload.items as Array<{ since?: unknown } | null> : []).flatMap((entry) => typeof entry?.since === "string" ? [entry.since] : []).join(" · ");
  const failed = (item.payload.answerError as { text?: unknown } | undefined)?.text;
  const lastFailure = typeof failed === "string" ? failed : null;
  const draft = about.mail ? null : reviewDraft(item);
  // The mail in a third language reads translated, made once when the card was raised (operator 21/11 nous_msg:e9b4df3e); "Show original" shows it as sent.
  const mailTranslation = about.mail ? needsYouMailTranslation(item, agents, about.mail) : null;
  const mailShown = mailTranslation && !original ? { ...about.mail!, ...mailTranslation } : about.mail;
  const readParts = mailTextParts(mailShown?.text ?? draft?.text ?? "");
  const readText = readParts.map((part) => typeof part === "string" ? part : part.label).join("");
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
  // A plan's card with no pane anywhere opens its plan (goToNeedsYouPane); in the dock its own "Open plan" link does.
  const planOnly = !item.paneId && !item.link?.paneId && !item.link?.surface && typeof item.payload.planId === "string";
  const opens = place !== "HERE" ? null : planOnly ? (onOpenPlan ? null : t("Open plan")) : needsYouMail(item) ? t("Open the mail") : /^(?:url|tab):/.test(item.link?.target ?? "") ? t("Open the page")
    : opensPane ? t("Open {name}", { name: opensPane.name }) : needsYouHasPlace(item, pane?.mode) ? t("Go to pane") : null;
  const Icon = kind === "off" ? Smartphone : kind === "review" ? ClipboardCheck : kind === "pane" ? MousePointer2
    : ask.code ? KeyRound : needsYouMail(item) ? Mail : CircleHelp;
  // Go happens only on the operator's click, never by itself.
  const goWord = planOnly ? "Open plan" : item.link?.surface && item.link.target ? "Open" : /^(?:url|tab):/.test(item.link?.target ?? "") ? "Go to the page" : "Go to pane";
  const go = () => goToNeedsYouPane(item);

  // The numbered answers: the card's own (recommended first), the generic ones under More unless they are all it has.
  const ownAnswers = answers.filter((option) => option !== PROBLEM && !tiled.has(option) && !(hands && option === DONE_OK)).sort((a, b) => Number(starred(b)) - Number(starred(a)));
  const plain = ownAnswers.filter((option) => !GENERIC.has(option));
  const numbered = hands || plain.length ? plain : ownAnswers;
  const others = numbered === plain ? ownAnswers.filter((option) => GENERIC.has(option)) : [];
  const optionAnswer = (option: string): Answer => {
    // A review's two answers never look alike, vouched or not (operator 12/11 21:38 BKK): Approve filled with a tick, Decline outlined with a cross.
    const side = decision && (option === "Approve" || option === "Decline") ? option : null;
    return { key: option, label: optionLabel(option), tone: side === "Approve" ? "approve" : side === "Decline" ? "decline" : option === recommended ? "recommended" : undefined,
      badge: starred(option), icon: side === "Approve" || option === DONE_OK ? Check : side === "Decline" ? X : undefined, run: () => choose(option) };
  };
  // Phase 2 (plan clipboard:va__qa_eBMYr §3): a hands card's first answer follows what its place looks like now.
  const first = ((): Answer => {
    switch (live?.state) {
      case "EXPIRED": return { key: "again", label: say("Go and ask for it again"), tone: "recommended", icon: ArrowUpRight,
        run: () => void answer({ text: "I am here now: offer the browser handoff again." }).then((done) => { if (done) go(); }) };
      case "PAGE_GONE": return about.page ? { key: "again", label: say("Open it again"), tone: "recommended", icon: ArrowUpRight, run: go }
        : { key: "tell", label: say("Tell the agent"), tone: "recommended", icon: Send, run: () => void answer({ text: "The page is no longer open: open it again and tell me when it is ready." }) };
      case "PANE_CLOSED": return { key: "close", label: say("Close without answering"), run: () => void close() };
      case "MOVED_ON": return { key: "close", label: say("It no longer needs me"), run: () => void close() };
      default: return { key: "go", label: say(goWord), tone: "recommended", badge: ask.recommended === NEEDS_YOU_GO_NOW, icon: ArrowUpRight, run: go };
    }
  })();
  const numberedAnswers: Answer[] = hands
    ? [first, ...(completedAnswer ? [{ key: "done", label: say("I already did it"), icon: Check, run: pickCompleted }] : []), ...numbered.map(optionAnswer)]
    : ask.code ? [] : numbered.map(optionAnswer);
  // Numbered by a CSS counter (.ny-opt::before), so an answer's name stays its words.
  const answerButton = (entry: Answer) => (
    <button key={entry.key} type="button" className={`ny-opt${entry.tone ? ` is-${entry.tone}` : ""}`} disabled={busy} onClick={entry.run}>
      <strong>{entry.label}{entry.badge ? <RecommendedBadge /> : null}</strong>
      {entry.icon ? <entry.icon aria-hidden="true" /> : null}
    </button>
  );

  const menuItems: MenuItem[] = [
    ...(completed && !hands ? [{ key: "completed", label: t("Completed"), disabled: busy, run: pickCompleted }] : []),
    ...(!offDefault && ask.recommended && needsYouAnswerKind(item) ? [{ key: "always", label: t("Always answer like this"), disabled: busy || Boolean(text.trim()),
      title: t("From now on, Space answers \"{answer}\" to cards like this one without asking you (Settings → Assistants & AI → Nous: Ask me again)", { answer: optionLabel(ask.recommended) }),
      run: () => void answer({ option: ask.recommended!, always: true }) }] : []),
    ...(onOpenPlan && !item.paneId && typeof item.payload.planId === "string" ? [{ key: "plan", label: t("Open plan"), run: () => onOpenPlan(item.payload.planId as string) }] : []),
    ...(studio ? [{ key: "studio", label: t(studio.source === "DESIGN" ? "Open in Design" : "Open in Video"), run: () => toPane(studio.roomId, studio.paneId, studio.target) }] : []),
    ...(opens && !(studio && opensPane?.paneId === studio.paneId) ? [{ key: "opens", label: opens, run: () => opensPane && item.roomId && item.paneId ? toPane(item.roomId, item.paneId) : go() }] : []),
    // A code, a value or a review in a pane: its field or answers lead, Go waits here.
    ...(place === "PANE" && !hands && live?.state !== "PANE_CLOSED" ? [{ key: "go", label: t(goWord), run: go }] : []),
  ];

  const codeForm = (
    <form className="ny-field" onSubmit={(event) => { event.preventDefault(); if (text.trim()) void answer({ text: text.trim() }); }}>
      {/* R27-3: a one-time code goes straight into the pane; the browser may offer the code it just received. Never stored here. */}
      <input value={text} onChange={(event) => setText(event.target.value)} maxLength={2_000} aria-label={t("One-time code")} autoComplete="one-time-code" placeholder={say("Type the code")} data-sensitive-masked="manual" />
      <DockButton type="submit" tone="primary" disabled={busy || !text.trim()}>{say("Send")}</DockButton>
    </form>
  );
  // A problem in words: off Space and on a card that lists it, sent as that answer with the words (operator 27/11).
  const problemWords = answers.includes(PROBLEM);
  // His words on every card (operator 4/11 18:42 BKK: off Space too): the answer itself on a value ask, else a note with a pick or an answer of its own.
  const wordsForm = (
    <form className={`ny-field${decision || typed ? "" : ` ny-own${text.trim() ? " has-words" : ""}`}`}
      onSubmit={(event) => { event.preventDefault(); if (text.trim() && !decision) void (problemWords ? pick(PROBLEM, text.trim()) : answer({ text: text.trim() })); }}>
      <input value={text} onChange={(event) => setText(event.target.value)} maxLength={2_000} aria-label={t(problemWords || hands ? "What went wrong?" : "Your answer")}
        placeholder={say(decision ? "Note (optional)" : typed ? "Type your answer" : hands ? "Problem? write it to the agent" : problemWords ? "Is there a problem? write it" : answers.length ? "Or answer in your words" : "Your answer")} />
      {decision ? null : typed || text.trim() ? <DockButton type="submit" tone={typed ? "primary" : "default"} icon={Send} disabled={busy || !text.trim()}>{say("Send")}</DockButton> : null}
    </form>
  );
  const field = ask.code ? codeForm : typed ? wordsForm : null;
  // Closed, the one answer is the recommended one (a tile's too), without its badge (mockup sheet b).
  const lead = !hands && recommended && tiled.has(recommended) && answers.includes(recommended)
    ? { ...optionAnswer(recommended), label: choices.find((choice) => choice.option === recommended)?.caption || optionLabel(recommended) } : numberedAnswers[0];
  const moreAnswers = numberedAnswers.length + (lead === numberedAnswers[0] ? 0 : choices.filter((choice) => choice.option).length) - 1;

  const liveLine = !live ? null : live.state === "READY" && live.until ? t("The page is open and waits for you until {time}.", { time: formatUserTime(live.until) })
    : live.state === "EXPIRED" && live.at ? t("The handoff ran out at {time}.", { time: formatUserTime(live.at) })
    : live.state === "MOVED_ON" ? `${t("The agent moved on:")} ${ids(live.line)}` : t(live.line);
  const LiveIcon = live?.state === "READY" ? Check : live?.state === "EXPIRED" || live?.state === "MOVED_ON" ? Clock : AlertTriangle;
  const folded = Boolean(translation || mailTranslation || steps.length || about.mail || draft || links.length || movedOn || answeredSince || checked || others.length || history);
  const moreButton = folded ? <button type="button" className="ny-link ny-more" aria-expanded={more} onClick={() => setMore(!more)}>{t("More")}{more ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button> : null;

  return (
    // nous-decision: the proofs find (and their captures hide) every card by it (space-needs-you-target-proof.mjs CAPTURE_HIDDEN).
    <article className={`nous-decision ny-card is-${variant} kind-${kind} layout-${layout.toLowerCase()}${open ? " is-open" : ""}${sent ? " is-done" : ""}`} aria-label={shown?.title ?? item.title} data-notification-id={item.id} data-needs-you-place={place}
      data-needs-you-layout={layout}>
      {/* The kind word on hover too: a narrow closed row keeps only its meta line's room · pane · time in sight. */}
      <span className="ny-tile" aria-hidden="true" title={t(KIND_LABEL[kind])}><Icon /></span>
      <div className="ny-head">
        <h3 className="ny-title">{heading}</h3>
        <p className="ny-meta">
          {/* lang: Space's kind word in the interface language. */}
          <span className="ny-kind" lang={language}>{t(KIND_LABEL[kind])}</span>
          <span className="ny-source">{uiSourceLabel(language, item.source)}</span>
          {item.severity === "URGENT" ? <span className="ny-urgent">{t("Urgent")}</span> : null}
          {due ? <span className={dueToday || due.overdue ? "ny-due" : undefined}><Clock aria-hidden="true" />{due.overdue ? t("Overdue") : dueToday ? t("Due today {time}", { time: formatUserTime(due.dueAt!) }) : t("Due {when}", { when: formatUserTime(due.dueAt!, { withDate: true }) })}</span> : null}
          {where ? <span className="ny-where">{where}</span> : null}
          <span>{formatUserTime(needsYouAskedAt(item), { withDate: true })}</span>
        </p>
      </div>
      <div className="ny-corners">
        {open && !sent ? (
          <div className="ny-menu" onKeyDown={(event) => { if (event.key === "Escape" && menu) { event.stopPropagation(); setMenu(false); } }}
            onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenu(false); }}>
            <DockIconButton className="ny-corner" label={t("More actions")} icon={MoreHorizontal} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} />
            {menu ? (
              <div className="ny-menu-list" role="menu">
                {menuItems.map((entry) => <button key={entry.key} type="button" role="menuitem" className="ny-link" title={entry.title} disabled={entry.disabled} onClick={() => { setMenu(false); entry.run(); }}>{entry.label}</button>)}
                {menuItems.length ? <hr /> : null}
                <button type="button" role="menuitem" className="ny-link danger" disabled={busy} onClick={() => void close()}>{t("Close without answering")}</button>
              </div>
            ) : null}
          </div>
        ) : null}
        {variant === "peek"
          ? <DockIconButton className="ny-corner" label={t("Later")} icon={X} onClick={() => onLater?.()} />
          : <DockIconButton className="ny-corner" label={t(open ? "Less" : "Details")} icon={open ? ChevronUp : ChevronDown} aria-expanded={open} onClick={() => setOpen(!open)} />}
      </div>
      <NeedsYouFiles item={item} fold={!open} />
      {liveLine && live && !sent ? <p className={`ny-live${LIVE_TONE[live.state]}`}><LiveIcon aria-hidden="true" />{liveLine}</p> : null}
      {sent ? <p className="ny-sent" role="status"><Check aria-hidden="true" />{sent}</p> : !open ? (
        <div className="ny-actions">
          {field ?? (decision ? <button type="button" className="ny-opt is-recommended" onClick={() => setOpen(true)}><strong>{t("Review and approve")}</strong><ChevronDown aria-hidden="true" /></button>
            : lead ? answerButton({ ...lead, badge: false })
            : <DockButton tone="primary" onClick={() => setOpen(true)}>{t("Answer")}</DockButton>)}
          {!field && !decision && moreAnswers > 0 ? <button type="button" className="ny-link" onClick={() => setOpen(true)}>{t(moreAnswers === 1 ? "1 more answer" : "{count} more answers", { count: moreAnswers })}</button> : null}
          {/* A list row opens on its chevron; the window has a Details button of its own (its corner is Later). */}
          {variant === "peek" ? <DockButton tone="ghost" aria-expanded={false} onClick={() => setOpen(true)}>{t("Details")}<ChevronDown aria-hidden="true" /></DockButton> : null}
        </div>
      ) : (
        <div className="ny-details">
          {why ? <section className="ny-what"><h4>{t("What it needs")}</h4><div className="ny-text"><ChatMarkdown content={needsYouMarkdown(uiServerText(agents, why))} /></div></section> : null}
          <dl className="ny-facts ny-chips">
            {about.page ? <div><dt>{t("Page")}</dt><dd><a href={about.page} target="_blank" rel="noopener noreferrer">{linkLabel(about.page)}</a></dd></div> : null}
            {about.site && !about.page ? <div><dt>{t("Site")}</dt><dd>{about.site}</dd></div> : null}
            {unblocks.length ? <div><dt>{t("Unblocks")}</dt><dd>{unblocks.map((plan) => plan.title).join(" · ")}</dd></div> : null}
            {due ? <div><dt>{t("Deadline")}</dt><dd>{formatUserTime(due.dueAt!, { withDate: true })}{due.overdue ? `, ${t("overdue")}` : ""}{unblocks.length > 1 ? ` (${due.title})` : ""}</dd></div> : null}
          </dl>
          {choices.length ? <NeedsYouChoices choices={choices} recommended={recommended} busy={busy} onChoose={choose} onStudio={setStudio} /> : null}
          {/* A review's note comes before its Approve or Decline, which sends it. */}
          {decision ? wordsForm : null}
          {ask.code ? codeForm : null}
          {numberedAnswers.length ? <div className="ny-answers ny-opts">{numberedAnswers.map(answerButton)}</div> : null}
          {!ask.code && !decision ? wordsForm : null}
          {/* The window's More and Less share one footer row (operator 27/11: two stacked toggles at its bottom). */}
          {variant === "peek" ? <div className="ny-footer">{moreButton}<button type="button" className="ny-link" onClick={() => setOpen(false)}>{t("Less")}<ChevronUp aria-hidden="true" /></button></div> : moreButton}
          {folded && more ? (
            <div className="ny-folded">
              {translation || mailTranslation ? <p className="ny-translated">{t(original ? "Original" : "Translated")} · <button type="button" className="ny-link" onClick={() => setOriginal(!original)}>{t(original ? "Show translation" : "Show original")}</button></p> : null}
              {stepsShown.length ? (
                <section><h4>{t("Steps")}</h4>
                  <div className="ny-text"><ChatMarkdown content={needsYouMarkdown(uiServerText(agents, stepsShown.join("\n")))} /></div>
                  {steps.length > STEPS_SHOWN ? <button type="button" className="ny-link" onClick={() => setAllSteps(!allSteps)}>{allSteps ? t("Fewer steps") : t("{count} more steps", { count: steps.length - STEPS_SHOWN })}</button> : null}
                </section>
              ) : null}
              {about.mail ? (
                <section className="ny-mail" aria-label={t("Mail")}>
                  <h4>{t("Mail")}</h4>
                  <dl className="ny-facts">
                    <dt>{t("From")}</dt><dd>{about.mail.from}</dd>
                    <dt>{t("To")}</dt><dd>{about.mail.to}</dd>
                    {about.mail.cc ? <><dt>{t("Cc")}</dt><dd>{about.mail.cc}</dd></> : null}
                    <dt>{t("Subject")}</dt><dd>{mailShown!.subject || t("(no subject)")}</dd>
                    {about.mail.at ? <><dt>{t("Received")}</dt><dd>{formatUserTime(about.mail.at, { withDate: true })}</dd></> : null}
                    {about.mail.attachments.length ? <><dt>{t("Attachments")}</dt><dd>{about.mail.attachments.join(" · ")}</dd></> : null}
                  </dl>
                  <div className={`ny-mail-body${longMail && !wholeMail ? " is-folded" : ""}`}><MailText parts={readParts} /></div>
                  {longMail ? <button type="button" className="ny-link" aria-expanded={wholeMail} onClick={() => setWholeMail(!wholeMail)}>{t(wholeMail ? "Show less" : "Show more")}</button> : null}
                </section>
              ) : draft ? (
                <section className="ny-mail" aria-label={t("Draft")}>
                  <h4>{t("Draft")}{draft.channel ? ` · ${draft.channel}` : ""}</h4>
                  <div className={`ny-mail-body${longMail && !wholeMail ? " is-folded" : ""}`}><MailText parts={readParts} /></div>
                  {longMail ? <button type="button" className="ny-link" aria-expanded={wholeMail} onClick={() => setWholeMail(!wholeMail)}>{t(wholeMail ? "Show less" : "Show more")}</button> : null}
                </section>
              ) : null}
              {links.length || movedOn || answeredSince ? (
                <dl className="ny-facts">
                  {links.length ? <><dt>{t("Links")}</dt><dd>{links.map((url, index) => <Fragment key={url}>{index ? " · " : ""}<a href={url} target="_blank" rel="noopener noreferrer">{linkLabel(url)}</a></Fragment>)}</dd></> : null}
                  {movedOn || answeredSince ? <><dt>{t("Since then")}</dt><dd className="ny-wrap">{answeredSince ? ids(answeredSince) : null}{movedOn && answeredSince ? <br /> : null}{movedOn ? `${formatUserTime(movedOn.at)}: ${ids(since)}` : null}</dd></> : null}
                </dl>
              ) : null}
              {checked ? <details className="ny-checked" open={checkedOpen.has(item.id)} onToggle={(event) => checkedOpen.setOpen(item.id, event.currentTarget.open)}><summary>{t(item.source === "AGENT" ? "What the agent checked" : "What Nous checked")}</summary><div className="ny-text"><ChatMarkdown content={needsYouMarkdown(checked)} /></div></details> : null}
              {others.length ? <section aria-label={t("Other answers")}><h4>{t("Other answers")}</h4><div className="ny-others">{others.map((option) => <DockButton key={option} disabled={busy} onClick={() => choose(option)}>{optionLabel(option)}</DockButton>)}</div></section> : null}
              {history ? <section className="ny-history"><h4>{t("History")}</h4>{history}</section> : null}
            </div>
          ) : null}
        </div>
      )}
      {/* R13-6: an answer that failed keeps the card waiting and says why, closed or open. */}
      {lastFailure && !error && !sent ? <p className="ny-error" role="alert"><AlertTriangle aria-hidden="true" />{t("Last try failed")}: {lastFailure}</p> : null}
      {error ? <p className="ny-error" role="alert"><AlertTriangle aria-hidden="true" />{t("Not sent: {reason}", { reason: error })}</p> : null}
      {confirmDialog}
    </article>
  );
}
