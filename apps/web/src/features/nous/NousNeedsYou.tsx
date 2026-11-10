import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NEEDS_YOU_GROUPS, needsYouGroup, withoutAccountFacts, type ClipboardItem, type NeedsYouGroup, type NousDecision,
  type NousOverview, type NousPaneBoard, type NousPlanHold, type SpaceNotification, type UiLanguage } from "@space/contracts";
import { api } from "../../api.js";
import { DockIconButton, DockState } from "../dock-kit/DockKit.js";
import { useNotificationStore } from "../notifications/notification-store.js";
import { NeedsYouCard, needsYouDueToday, soonestDue, type NeedsYouBoardPane } from "../needs-you/NeedsYouCard.js";
import { Nous, Send } from "../ui-theme/app-icons.js";
import { useNousUiIds } from "./nous-ui-state.js";
import { useUiLanguage, uiServerText, uiText } from "../ui-language/ui-language.js";

export { needsYouMarkdown } from "../needs-you/NeedsYouCard.js";

/**
 * Needs you requests the operator did not go to (operator request 2026-10-24): every needs-you record still waiting (open, or read
 * by "Not now") on a pane that is still open, newest first. The server resolves the ones that no longer need them, and each change
 * reaches this tab through the notification store, so the list re-reads with it.
 */
/** Every needs-you request, 200 a page, paging on the oldest one's time (until 31/10 the newest 200). */
async function allNeedsYou(): Promise<SpaceNotification[]> {
  const out: SpaceNotification[] = [];
  for (let before: string | undefined; ;) {
    const { notifications } = await api.notifications({ status: "NEEDS_YOU", limit: 200, ...(before ? { before } : {}) });
    out.push(...notifications);
    if (notifications.length < 200) return out;
    before = notifications.at(-1)!.createdAt;
  }
}

export function useNeedsYouRequests(active: boolean): SpaceNotification[] | null {
  const { items } = useNotificationStore();
  const [requests, setRequests] = useState<SpaceNotification[] | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void allNeedsYou().then((result) => { if (!cancelled) setRequests(result); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [active, items]);
  return requests;
}

/** The mail facts the server writes above a decision's body (mail-context.ts). Account facts are Nous's and never shown (operator 2/11 09:49 BKK). */
const DECISION_FACT = /^Mail (?:from|with) \S+ in \d+ days: /;

/**
 * A decision's body as markdown in the operator's language (nous_msg:40900116, stable 1/11: the facts ran together in English): each fact
 * Space wrote is its own list item, also on records stored before the server wrote them as items; Nous's own text stays as written.
 */
export function decisionMarkdown(language: UiLanguage, body: string): string {
  return uiServerText(language, withoutAccountFacts(body).split("\n").map((line) => DECISION_FACT.test(line) ? `- ${line}` : line).join("\n"));
}

/**
 * Plan clipboard:PHmjUTRmWM6C (operator 31/10 13:20 BKK): what ties an ask to an open plan. It names the plan (a decision's refs.planId,
 * the plan its pane's needs-you report named, a Nous card item's ref), it sits on the plan's pane, or what the plan waits on names it by id.
 */
type Ask = { id: string; paneId: string | null; planIds: string[] };
export type PlanTie = { id: string; paneId?: string | null; what?: string | null };
const noticeAsk = (item: SpaceNotification): Ask => ({ id: item.id, paneId: item.paneId,
  planIds: [item.payload.planId, ...(Array.isArray(item.payload.items) ? item.payload.items.map((entry) => (entry as { ref?: unknown } | null)?.ref) : [])]
    .filter((ref): ref is string => typeof ref === "string" && ref.startsWith("clipboard:")) });
const decisionAsk = (decision: NousDecision): Ask => ({ id: decision.id, paneId: decision.refs.paneId ?? null, planIds: decision.refs.planId ? [decision.refs.planId] : [] });
const asksPlan = (plan: PlanTie, ask: Ask) => ask.planIds.includes(plan.id) || Boolean(plan.paneId && ask.paneId === plan.paneId) || Boolean(plan.what?.includes(ask.id));

type Row = { id: string; at: string; due: string | null; group: NeedsYouGroup; node: ReactNode };
const GROUP_TITLES: Record<NeedsYouGroup, string> = { OFF_SPACE: "Off Space", QUESTIONS: "Questions", APPROVALS: "Approvals", PANE: "In a pane" };

/**
 * Needs you as questions (operator request 2026-10-27, plan clipboard:5AQvaoSR-IZa): each card asks its ONE question and is answered here, the
 * answer reaching whoever asked without visiting the pane. Plan clipboard:PHmjUTRmWM6C: Nous's open decisions are listed too; `part` shows a
 * plan's own asks. No filters (operator 3/11 12:36 BKK). Plan clipboard:ytwWl09xNH0Z (design §3.3, approved 3/11 ~19:53 BKK): closed rows grouped
 * by where the work is (off Space, questions with Nous's decisions, approvals, in a pane), the nearest deadline then the newest first, one open
 * at a time; `focus` opens the card a toast, the window or a pop-up was clicked for (a new object each click, so the same card reopens).
 */
export function NousNeedsYou({ requests, decisions = [], renderDecision, plans = [], part = false, focus = null }: {
  requests: SpaceNotification[] | null; decisions?: NousDecision[]; renderDecision?(decision: NousDecision): ReactNode;
  plans?: NousOverview["plans"]; part?: boolean; focus?: { id: string | null } | null;
}) {
  const [board, setBoard] = useState<NousPaneBoard | null>(null);
  const [openId, setOpenId] = useState<string | null>(focus?.id ?? null);
  const scrollTo = useRef<string | null>(focus?.id ?? null);
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  // What the operator folded on each card stays so on this device; answered or resolved cards are forgotten (by the whole list only).
  const ids = requests && !part ? requests.map((item) => item.id) : null;
  useNousUiIds("needs.checkedOpen", ids);
  useEffect(() => {
    if (!requests?.length && !decisions.length) return;
    let cancelled = false;
    void api.nousPaneBoard().then((result: { board: NousPaneBoard }) => { if (!cancelled) setBoard(result.board); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [requests, decisions.length]);
  useEffect(() => { if (focus?.id) { setOpenId(focus.id); scrollTo.current = focus.id; } }, [focus]);
  // The clicked card is brought into view once the list holds it (the dock mounts, then loads).
  useEffect(() => {
    const id = scrollTo.current;
    const card = id ? [...document.querySelectorAll<HTMLElement>(".ny-card[data-notification-id]")].find((element) => element.dataset.notificationId === id) : null;
    if (card) { card.scrollIntoView?.({ block: "nearest" }); scrollTo.current = null; }
  }, [requests, openId]);
  const panes = useMemo(() => new Map<string, NeedsYouBoardPane>((board?.rooms ?? []).flatMap((room) => room.panes.map((pane) => [pane.paneId, { ...pane, roomName: room.name, lineLanguage: board!.settings.language }] as const))), [board]);
  const planOf = (ask: Ask) => plans.filter((plan) => asksPlan({ id: plan.id, paneId: plan.paneId, what: plan.hold?.what }, ask)).map((plan) => plan.id);
  const rows: Row[] = requests === null ? [] : [
    ...requests.map((item): Row => {
      const planIds = planOf(noticeAsk(item));
      const unblocks = plans.filter((plan) => planIds.includes(plan.id));
      const pane = item.paneId ? panes.get(item.paneId) : undefined;
      return { id: item.id, at: item.createdAt, due: soonestDue(unblocks)?.dueAt ?? null, group: needsYouGroup(item, pane?.mode),
        node: <NeedsYouCard key={item.id} variant="row" item={item} pane={pane} unblocks={unblocks} open={openId === item.id} onOpenChange={(open) => setOpenId(open ? item.id : null)} /> };
    }),
    ...decisions.map((decision): Row => ({ id: decision.id, at: decision.createdAt, due: null, group: "QUESTIONS",
      node: <div key={decision.id} style={{ display: "contents" }} data-sensitive-masked="manual">{renderDecision?.(decision)}</div> }))
  ].sort((left, right) => (left.due ?? "\uffff").localeCompare(right.due ?? "\uffff") || right.at.localeCompare(left.at));
  const dueToday = requests?.filter((item) => needsYouDueToday(soonestDue(plans.filter((plan) => planOf(noticeAsk(item)).includes(plan.id))))).length ?? 0;
  // The mask covers the requests' own words, never Space's labels, so a masked shot still shows the layout in the operator's language (plan clipboard:32etNsBgtbI- step 4).
  return (
    <div className={part ? "nous-plan-needs-list ny-list" : "nous-decisions ny-list"}>
      {requests === null ? <DockState kind="loading" title={t("Loading what waits for you")} /> : null}
      {requests !== null && !rows.length ? <DockState kind="empty" icon={Nous} title={t("Nothing waits for you")}
        detail={t("When a pane asks you something and you do not go, its question waits here until you answer it or it no longer needs you.")} /> : null}
      {!part && rows.length ? <p className="ny-summary">{dueToday ? <><strong>{t("{count} due today", { count: dueToday })}</strong> · </> : null}{t("{count} wait for you", { count: rows.length })}</p> : null}
      {/* One flat keyed list (headings between rows): a card the pane board moves to another group keeps its state (a typed answer). */}
      {NEEDS_YOU_GROUPS.flatMap((group) => {
        const inGroup = rows.filter((row) => row.group === group);
        return inGroup.length ? [<h3 key={`group:${group}`} className="ny-group-title">{t(GROUP_TITLES[group])}<span>{inGroup.length}</span></h3>, ...inGroup.map((row) => row.node)] : [];
      })}
    </div>
  );
}

/**
 * Plan clipboard:PHmjUTRmWM6C step 2: a plan held on the operator, or asked about, says what it needs from them: its open needs-you cards and
 * Nous decisions, answered here as in Needs you. Held on them with none, it says what it waits on and the answer goes to Nous with the plan's id.
 */
export function PlanNeedsYou({ plan, hold, needs, decisions, renderDecision }: {
  plan: ClipboardItem; hold: NousPlanHold | null | undefined; needs: SpaceNotification[] | null; decisions: NousDecision[]; renderDecision(decision: NousDecision): ReactNode;
}) {
  const what = hold?.kind === "OPERATOR" ? hold.what : plan.waitsOn?.kind === "OPERATOR" ? plan.waitsOn.what : null;
  const tied = [plan.waitsOn?.what, hold?.what].filter(Boolean).join("\n");
  // Memoized on the list: the cards' pane board read follows the list's own refreshes, not every render of the dock.
  const cards = useMemo(() => (needs ?? []).filter((item) => asksPlan({ id: plan.id, paneId: plan.paneId, what: tied }, noticeAsk(item))), [needs, plan.id, plan.paneId, tied]);
  const asked = decisions.filter((decision) => decision.status === "OPEN" && !decision.runsWhen && asksPlan({ id: plan.id, paneId: plan.paneId, what: tied }, decisionAsk(decision)));
  const language = useUiLanguage();
  if (!what && !cards.length && !asked.length) return null;
  return (
    <section className="nous-plan-needs-you" aria-label={uiText(language, "What it needs from you")}>
      <h3>{uiText(language, "What it needs from you")}</h3>
      {what ? <p className="nous-recommendation">{what}</p> : null}
      {cards.length || asked.length ? <NousNeedsYou part requests={cards} decisions={asked} renderDecision={renderDecision} />
        : needs === null ? null : <PlanReply plan={plan} />}
    </section>
  );
}

function PlanReply({ plan }: { plan: ClipboardItem }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const language = useUiLanguage();
  const t = (text: string) => uiText(language, text);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      // Like the pane board's "[Room · Pane]" reply: the label names the plan by its id, so Nous knows exactly which plan the answer is for.
      await api.sendNousMessage(`[Plan ${plan.title ?? plan.id} · ${plan.id}] ${text.trim()}`);
      setText("");
      setSent(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="nous-muted">{t("No card or decision asks it yet. Answer here and Nous gets it with this plan.")}</p>
      <form className="nous-decision-answer" onSubmit={(event) => { event.preventDefault(); if (text.trim()) void send(); }}>
        <input value={text} onChange={(event) => setText(event.target.value)} maxLength={2_000} aria-label={t("Your answer to Nous about this plan")} placeholder={t("Your answer to Nous")} />
        <DockIconButton label={t("Send to Nous")} icon={Send} type="submit" disabled={busy || !text.trim()} />
      </form>
      {sent ? <p className="nous-recommendation" role="status">{t("Sent to Nous with this plan.")}</p> : null}
      {error ? <p className="nous-muted" role="alert">{error}</p> : null}
    </>
  );
}
