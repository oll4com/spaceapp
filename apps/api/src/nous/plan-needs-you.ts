import { planIsParked, type ClipboardItem, type NotificationListQuery, type NotificationRaiseInput, type NousDecision, type PlanResumeCondition, type SpaceNotification } from "@space/contracts";
import type { NousRepository } from "@space/db";
import type { SpaceStore } from "@space/runtime";
import { agentNeedsYouKey } from "../pane-reports.js";
import { allNotifications, NOUS_PANE_NOTICE_PREFIX, NOUS_PLAN_NOTICE_PREFIX } from "./pane-notices.js";

/**
 * Operator 13/11 (nous_msg:2e24947d «Γιατί δεν έρχεται Needs you για plan που με χρειάζεται???»): every open plan that waits on the operator
 * (waitsOn.kind OPERATOR, or a parked plan's open OPERATOR condition) has a Needs you item. A closed pane's open cards move to their plan's item
 * instead of vanishing (`carry`). Operator 13/11 14:41 BKK: a real card that asks for the plan is shown instead of Space's, never both.
 * Operator 13/11 23:56 BKK (nous_msg:4258ef8d, 4 plans waited on him with no card: asking Nous to raise one was not enough): when no real card
 * or decision asks for the plan, Space raises its own (`derived`) with the wait as its question and Done / Need help from an agent / Not now,
 * and resolves it when the wait clears or a real card appears.
 * Operator 14/11 00:41 BKK (nous_msg:f8a4d2df, an answered plan item stayed in Needs you): every answer closes the card and records the wait it
 * answered (`answeredWait`); Space raises no card for that wait again until it is reopened or its words change.
 */
export const PLAN_NOTICE_PREFIX = NOUS_PLAN_NOTICE_PREFIX;
export const planNoticeKey = (planId: string) => `${PLAN_NOTICE_PREFIX}${planId}`;

type Notifications = {
  list(owner: string, query: NotificationListQuery): Promise<SpaceNotification[]>;
  raise(input: NotificationRaiseInput, options?: { realert?: boolean }): Promise<SpaceNotification>;
  resolve(owner: string, dedupeKey: string, reason?: string): Promise<number>;
};
export interface PlanNeedsYouDeps {
  /** The owner's plans that are not completed (parked ones included). */
  plans(owner: string): Promise<ClipboardItem[]>;
  /** The owner's open decisions Needs you shows (not the ones an allowance runs). */
  decisions(owner: string): Promise<NousDecision[]>;
  notifications: Notifications;
}

const live = (item: SpaceNotification) => item.status === "OPEN" || item.status === "READ";
// A closed plan still parked is not finished (score.ts): its operator conditions wait on them too.
const open = (plan: ClipboardItem) => planIsParked(plan) || (!plan.isCompleted && plan.executionStatus !== "COMPLETED");
/** The answers of Space's own plan card: Done clears the plan's wait (`unblockPlanWait`); each answer closes the card. */
export const PLAN_CARD_OPTIONS = ["Done", "Need help from an agent", "Not now"] as const;
/** What a plan waits on the operator for: its waitsOn, else a parked plan's open OPERATOR condition; null when nothing of theirs. */
export const operatorWait = (plan: ClipboardItem): string | null => plan.waitsOn?.kind === "OPERATOR" ? plan.waitsOn.what
  : planIsParked(plan) ? plan.parked.conditions.find((condition) => condition.who === "OPERATOR" && condition.state === "OPEN")?.what ?? null : null;
const titleOf = (plan: ClipboardItem) => (plan.title ?? plan.text.split("\n")[0] ?? plan.id).slice(0, 200);
/** The plans a card names: its `planId`, and the plan ids its items came from. */
const plansOf = (card: SpaceNotification) => [card.payload.planId, ...(Array.isArray(card.payload.items) ? card.payload.items.map((item: { ref?: unknown }) => item?.ref) : [])]
  .filter((id): id is string => typeof id === "string" && id.startsWith("clipboard:"));
// The web's `asksPlan` (NousNeedsYou.tsx): the card names the plan, sits on its pane, or what the plan waits on names the card.
const ties = (plan: ClipboardItem, ask: { id: string; planIds: string[]; paneId: string | null }) => ask.planIds.includes(plan.id)
  || Boolean(plan.paneId && ask.paneId === plan.paneId) || Boolean(plan.waitsOn?.what.includes(ask.id));
const askOf = (card: SpaceNotification) => ({ id: card.id, paneId: card.paneId,
  planIds: [...plansOf(card), ...(card.dedupeKey?.startsWith(PLAN_NOTICE_PREFIX) ? [card.dedupeKey.slice(PLAN_NOTICE_PREFIX.length)] : [])] });
/** The plan wait a card the operator acted on ended for them: the one recorded with the answer, else a derived card's own (not after Done); null when none. */
const actedWait = (card: SpaceNotification): unknown => card.status !== "ACKED" && !(card.status === "RESOLVED" && card.payload.answer) ? null
  : card.payload.answeredWait !== undefined ? card.payload.answeredWait
    : card.payload.derived && (card.payload.answer as { text?: unknown } | undefined)?.text !== "Done" ? card.payload.what : null;

export function createPlanNeedsYou(deps: PlanNeedsYouDeps) {
  const notifications = deps.notifications;
  // The plans whose card could not be raised at the last sync (the Score's lever names them).
  const missing = new Map<string, Set<string>>();
  // The newest card on the plan's own key or its pane's keys was answered for this very wait.
  const answered = async (owner: string, plan: ClipboardItem, what: string) => {
    for (const key of [planNoticeKey(plan.id), ...(plan.paneId ? [`${NOUS_PANE_NOTICE_PREFIX}${plan.paneId}`, agentNeedsYouKey(plan.paneId)] : [])]) {
      const [latest] = await notifications.list(owner, { status: "ALL", dedupeKey: key, limit: 1 });
      if (latest && actedWait(latest) === what) return true;
    }
    return false;
  };
  return {
    /** Raises Space's card for each plan waiting on the operator that no real card asks for, and resolves the ones no longer needed. */
    async sync(owner: string, reopened: string[] = []): Promise<{ raised: number; resolved: number; missing: string[] }> {
      const plans = new Map((await deps.plans(owner)).filter(open).map((plan) => [plan.id, plan]));
      const cards = await allNotifications(notifications.list, owner, { status: "NEEDS_YOU" });
      const own = cards.filter((card) => card.dedupeKey?.startsWith(PLAN_NOTICE_PREFIX));
      const asks = [...cards.filter((card) => !card.dedupeKey?.startsWith(PLAN_NOTICE_PREFIX)).map((card) => ({ id: card.id, planIds: plansOf(card), paneId: card.paneId })),
        ...(await deps.decisions(owner)).map((decision) => ({ id: decision.id, planIds: decision.refs.planId ? [decision.refs.planId] : [], paneId: decision.refs.paneId ?? null }))];
      let raised = 0;
      let resolved = 0;
      const failed: string[] = [];
      for (const card of own) {
        const plan = plans.get(card.dedupeKey!.slice(PLAN_NOTICE_PREFIX.length));
        // A carried card or Nous's own plan card stays until its plan closes; Space's own only while the plan waits and nothing else asks.
        // An answered one is from before 14/11, when only Done closed it.
        const reason = !plan ? "its plan is closed" : !card.payload.derived ? null : card.payload.answer ? "you answered it" : !operatorWait(plan) ? "the plan no longer waits on you"
          : asks.some((ask) => ties(plan, ask)) ? "another card asks for the plan" : null;
        if (reason) resolved += await notifications.resolve(owner, card.dedupeKey!, reason);
      }
      for (const plan of plans.values()) {
        const what = operatorWait(plan);
        if (!what || asks.some((ask) => ties(plan, ask))) continue;
        const key = planNoticeKey(plan.id);
        const current = own.find((card) => card.dedupeKey === key);
        // Nous's or a carried card stays; Space's own is raised again only for a new wait (or an old text item without answers).
        if (current && (!current.payload.derived || (current.payload.what === what && Array.isArray((current.payload.ask as { options?: unknown } | undefined)?.options)))) continue;
        // shortcut: only the plan's own key and its pane's keys are read, so an answer on a card tied by planId from another pane is not seen; read
        // the tied cards too if such an item comes back. A reopened wait (`reopened`, from the plan's update) is asked again.
        if (!reopened.includes(plan.id) && await answered(owner, plan, what)) continue;
        const question = `This plan waits on you: ${what}`;
        try {
          await notifications.raise({
            ownerUserId: owner, roomId: plan.roomId, paneId: null, source: "NOUS", kind: "NEEDS_YOU", severity: "ATTENTION", title: titleOf(plan),
            body: what.length > 2000 ? `${what.slice(0, 1999)}…` : what, link: plan.roomId ? { roomId: plan.roomId } : {}, dedupeKey: key, telegram: null,
            // No recommendation: "Always answer like this" answers with it, and only the operator can say the wait is done.
            payload: { planId: plan.id, derived: true, what, ask: { question: question.length > 300 ? `${question.slice(0, 299)}…` : question,
              options: [...PLAN_CARD_OPTIONS], answer: { kind: "NOUS" } } }
          }, { realert: Boolean(current) });
          raised += 1;
        } catch {
          failed.push(plan.id);
        }
      }
      missing.set(owner, new Set(failed));
      return { raised, resolved, missing: failed };
    },

    /** What the plan a card asks for waits on the operator for (the first open plan it ties to that waits); null when none. */
    async waitOf(owner: string, card: SpaceNotification): Promise<string | null> {
      const ask = askOf(card);
      for (const plan of (await deps.plans(owner)).filter(open)) {
        const what = operatorWait(plan);
        if (what && ties(plan, ask)) return what;
      }
      return null;
    },

    /** A plan whose card the last sync could not raise. */
    missing: (owner: string, planId: string) => missing.get(owner)?.has(planId) ?? false,

    /**
     * A closing pane's open needs-you cards (its agent's and Nous's) move to their plan's item, so its ask stays: the plan the card names, else
     * an open plan its items name, else the open plan running in that pane. Call before the pane's cards are resolved.
     */
    async carry(owner: string, paneId: string): Promise<number> {
      const cards: SpaceNotification[] = [];
      for (const key of [agentNeedsYouKey(paneId), `${NOUS_PANE_NOTICE_PREFIX}${paneId}`]) {
        cards.push(...(await notifications.list(owner, { status: "WAITING", dedupeKey: key, limit: 200 })).filter(live));
      }
      if (!cards.length) return 0;
      const plans = (await deps.plans(owner)).filter(open);
      const byPlan = new Map<string, SpaceNotification[]>();
      for (const card of cards) {
        // shortcut: a pane running several plans gives its cards to the first; the card's own planId wins when it has one.
        const plan = plansOf(card).map((id) => plans.find((entry) => entry.id === id)).find(Boolean) ?? plans.find((entry) => entry.paneId === paneId);
        if (plan) byPlan.set(plan.id, [...(byPlan.get(plan.id) ?? []), card]);
      }
      for (const [planId, [first, ...more]] of byPlan) {
        const plan = plans.find((entry) => entry.id === planId)!;
        // The pane is gone: an answer goes to Nous (never into the closed pane), and a one-time code has nowhere to go.
        const ask = first!.payload.ask as { code?: boolean } | undefined;
        const body = [first!, ...more].map((card) => more.length ? `${card.title}\n${card.body}` : card.body).join("\n\n");
        await notifications.raise({
          ownerUserId: owner, roomId: first!.roomId ?? plan.roomId, paneId: null, source: "NOUS", kind: "NEEDS_HANDS", severity: first!.severity === "INFO" ? "ATTENTION" : first!.severity,
          title: first!.title, body: body.length > 2000 ? `${body.slice(0, 1999)}…` : body, link: first!.roomId ? { roomId: first!.roomId } : {}, dedupeKey: planNoticeKey(planId), telegram: null,
          // Carried, never `derived`: it stays until the plan closes or it is answered, whatever the plan's waitsOn says.
          payload: { ...first!.payload, planId, derived: false, carried: [first!, ...more].map((card) => ({ paneId, dedupeKey: card.dedupeKey, id: card.id })),
            ask: ask && !ask.code ? { ...ask, answer: { kind: "NOUS" } } : undefined }
        });
      }
      return [...byPlan.values()].reduce((sum, list) => sum + list.length, 0);
    }
  };
}
export type PlanNeedsYou = ReturnType<typeof createPlanNeedsYou>;

type PlanStore = Pick<SpaceStore, "getClipboardItem" | "updateClipboardItemProgress">;
// derivedPark copies a plan's OPERATOR wait into a MANUAL resume condition: it is the same wait, so the same answer meets it.
const operatorHold = (condition: PlanResumeCondition) => condition.who === "OPERATOR" && condition.state === "OPEN" && condition.check.kind === "MANUAL";
/** Clears a plan's wait on the operator (its waitsOn, and a parked plan's open OPERATOR condition); false when it waits on nothing of theirs. */
export async function unblockPlanWait(store: PlanStore, owner: string, planId: string, evidence = "The operator answered"): Promise<boolean> {
  const plan = await store.getClipboardItem(owner, planId);
  if (!plan) return false;
  const waits = plan.waitsOn?.kind === "OPERATOR";
  // Operator 13/11 nous_msg:0fa7d370: with only waitsOn cleared, the parked condition kept the plan "waiting on you" (plan map, pendings list).
  const held = planIsParked(plan) && plan.parked.conditions.some(operatorHold);
  if (!waits && !held) return false;
  const at = new Date().toISOString();
  await store.updateClipboardItemProgress(owner, planId, { ...(waits ? { waitsOn: null } : {}),
    ...(held ? { parked: { ...plan.parked!, conditions: plan.parked!.conditions.map((condition) => operatorHold(condition) ? { ...condition, state: "MET" as const, metAt: at, checkedAt: at, evidence } : condition) } } : {}) });
  return true;
}

/**
 * Operator 13/11 15:37 BKK: a plan's item stayed open after its decision was approved and done. Every answer to a decision that names a plan
 * (whatever path answers it) ends the plan's wait on the operator, and the card Nous raised for that wait goes with it (a card carried from a
 * closed pane holds that pane's own ask and stays); a cancelled decision leaves both. The parked-plan check resumes a plan whose conditions are all met.
 * shortcut: a plan waiting on the operator for two things loses the wait on the first answer; give waitsOn the decision id if that happens.
 */
export function closePlanWaitOnAnswer(repository: Pick<NousRepository, "answerDecision">, store: PlanStore, notifications?: Pick<Notifications, "list" | "resolve">): void {
  const answer = repository.answerDecision.bind(repository);
  repository.answerDecision = async (owner, id, patch) => {
    const decision = await answer(owner, id, patch);
    const planId = decision && decision.status !== "CANCELLED" ? decision.refs.planId : null;
    if (!planId || !await unblockPlanWait(store, owner, planId, `Decision ${id} ${decision!.status.toLowerCase()}`).catch(() => false)) return decision;
    const key = planNoticeKey(planId);
    const cards = await notifications?.list(owner, { status: "WAITING", dedupeKey: key, limit: 200 }).catch(() => []) ?? [];
    if (cards.some((card) => live(card) && !card.payload.carried)) await notifications!.resolve(owner, key, `Decision ${id} ${decision!.status.toLowerCase()}`).catch(() => 0);
    return decision;
  };
}
