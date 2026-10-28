import { useEffect, useState, type ReactNode } from "react";
import type { NousOverview } from "@space/contracts";
import { loadPlanCompletion, PlanCompletionBar, type PlanCompletion } from "../clipboard-dock/PlanCompletionBar.js";

/**
 * The Nous dock's live stats (operator request 2026-10-17, plan clipboard:wr9yNPJwkDrp): rooms, agents by state and agents on a plan,
 * from Nous's overview. The system tiles and sparklines left on 2026-10-21 (operator request): the right rail shows those figures.
 */
export function NousLiveStats({ overview, active }: { overview: NousOverview | null; active: boolean }) {
  const live = overview?.live;
  const onPlans = plansOnPanes(overview);
  return (
    <section className="nous-live" aria-label="Live stats" data-motion={active ? "on" : "off"}>
      <h3>Live</h3>
      <NousLivePlans overview={overview} active={active}>
        <dl className="nous-live-counts">
          <div><dt>Rooms</dt><dd>{live ? live.rooms : "—"}</dd></div>
          <div><dt>Running</dt><dd>{live ? live.agents.running : "—"}</dd></div>
          <div><dt>Idle</dt><dd>{live ? live.agents.idle : "—"}</dd></div>
          <div className={live?.agents.waiting ? "is-attention" : undefined}><dt>Waiting</dt><dd>{live ? live.agents.waiting : "—"}</dd></div>
          <div><dt>On a plan</dt><dd>{overview ? onPlans.length : "—"}</dd></div>
        </dl>
      </NousLivePlans>
    </section>
  );
}

const plansOnPanes = (overview: NousOverview | null) => (overview?.plans ?? []).filter((plan) => plan.pane);

/**
 * Live's plans: "Plans completed" (the Clipboard dock's figures, read again whenever the overview changes, plan clipboard:RXqSSUQSdwJK)
 * and every open plan, those on a pane first with their active mark, then those on no pane (operator request 2026-10-26: see them all,
 * apart); with onOpen a row opens the plan.
 */
export function NousLivePlans({ overview, active, onOpen, children }: {
  overview: NousOverview | null; active: boolean; onOpen?(id: string): void; children?: ReactNode;
}) {
  const onPlans = plansOnPanes(overview);
  const offPlans = (overview?.plans ?? []).filter((plan) => !plan.pane);
  const activePlans = onPlans.filter((plan) => plan.active).length;
  const [completion, setCompletion] = useState<PlanCompletion | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    loadPlanCompletion().then((next) => { if (!cancelled) setCompletion(next); }).catch(() => {});
    return () => { cancelled = true; };
  }, [active, overview]);
  const rows = (plans: NousOverview["plans"]) => plans.map((plan) => {
    const where = plan.pane ?? (plan.paneClosed ? "Pane closed" : "No pane");
    const row = (
      <>
        {plan.active
          ? <span className="nous-live-dot is-active" role="img" aria-label={`Active: ${plan.pane} is working`} title={`Active: ${plan.pane} is working`} />
          : <span className="nous-live-dot" aria-hidden="true" />}
        <span className="nous-live-plan-name" title={`${plan.title} (${where})`}>{plan.pane ? `${plan.pane} · ${plan.title}` : plan.title}</span>
        <span className="nous-progress" aria-hidden="true">
          <span style={{ width: `${plan.progress}%` }} />
        </span>
        <span className="nous-live-plan-percent">{plan.progress}%</span>
      </>
    );
    return (
      <li key={plan.id} className={plan.active ? "is-active" : undefined}>
        {onOpen ? (
          <button type="button" className="nous-live-plan-open" onClick={() => onOpen(plan.id)}
            aria-label={`Open the plan ${plan.title}, ${where}, ${plan.progress}%${plan.active ? ", active" : ""}`}>{row}</button>
        ) : row}
      </li>
    );
  });
  return (
    <>
      {completion ? <PlanCompletionBar {...completion} /> : null}
      {children}
      {onPlans.length ? (
        <p className="nous-live-plans-legend"><span className="nous-live-dot is-active" aria-hidden="true" />Active {activePlans} · On a pane {onPlans.length}</p>
      ) : null}
      {onPlans.length ? <ul className="nous-live-plans" aria-label="Plans on a pane">{rows(onPlans)}</ul> : null}
      {offPlans.length ? <p className="nous-live-plans-legend">Not on a pane {offPlans.length}</p> : null}
      {offPlans.length ? <ul className="nous-live-plans is-off-pane" aria-label="Plans not on a pane">{rows(offPlans)}</ul> : null}
    </>
  );
}
