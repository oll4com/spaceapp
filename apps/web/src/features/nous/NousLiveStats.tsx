import { useEffect, useState, type ReactNode } from "react";
import type { NousLoad, NousOverview } from "@space/contracts";
import { api } from "../../api.js";
import { loadPlanCompletion, PlanCompletionBar, type PlanCompletion } from "../clipboard-dock/PlanCompletionBar.js";
import { LinkedLoadList, useLinkedLoads } from "./NousLoad.js";
import { useUiText } from "../ui-language/ui-language.js";
import type { AgentsDashboardPreset } from "../agents-dashboard/dashboard-model.js";

/**
 * The Nous dock's live stats (operator request 2026-10-17, plan clipboard:wr9yNPJwkDrp): rooms, agents by state and agents on a plan,
 * from Nous's overview. The system tiles and sparklines left on 2026-10-21 (operator request): the right rail shows those figures.
 */
export function NousLiveStats({ overview, active, onOpenLoad, onOpenAgents }: {
  overview: NousOverview | null; active: boolean; onOpenLoad?(): void; onOpenAgents?(preset: AgentsDashboardPreset): void;
}) {
  const live = overview?.live;
  const onPlans = plansOnPanes(overview);
  // The Load view's own figures (operator 13/11 07:51 BKK, nous_msg:ceb66b0357124a2d8586e795), read again with each overview.
  const [load, setLoad] = useState<NousLoad | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    api.nousLoad("1h").then((next) => { if (!cancelled) setLoad(next); }).catch(() => {});
    return () => { cancelled = true; };
  }, [active, overview]);
  const percent = load?.overall == null ? "—" : `${Math.round(load.overall)}%`;
  // Each linked SpaceApp's load beside this one's (operator nous_msg:766c70a6); nothing without links.
  const linked = useLinkedLoads(active);
  const t = useUiText();
  // Each count opens the Agents Dashboard on its own filter (operator nous_msg:ad2b3a6a); without onOpenAgents it is a plain figure.
  const tile = (label: string, value: number | string, preset: AgentsDashboardPreset, attention = false) => (
    <div className={attention ? "is-attention" : undefined}><dt>{t(label)}</dt><dd>
      {onOpenAgents ? <button type="button" className="nous-live-load-open" onClick={() => onOpenAgents(preset)}
        aria-label={t("Open the Agents Dashboard: {label} {value}", { label: t(label), value })}>{value}</button> : value}
    </dd></div>
  );
  return (
    <section className="nous-live" aria-label={t("Live stats")} data-motion={active ? "on" : "off"}>
      <h3>{t("Live")}</h3>
      <NousLivePlans overview={overview} active={active}>
        <dl className="nous-live-counts">
          {tile("Rooms", live ? live.rooms : "—", { filter: "all", roomFilter: "all", groupBy: "room" })}
          {tile("Running", live ? live.agents.running : "—", { filter: "working", roomFilter: "all" })}
          {tile("Idle", live ? live.agents.idle : "—", { filter: "idle", roomFilter: "all" })}
          {tile("Waiting", live ? live.agents.waiting : "—", { filter: "waiting", roomFilter: "all" }, Boolean(live?.agents.waiting))}
          {/* The dashboard has no plan filter: every agent, grouped by project. */}
          {tile("On a plan", overview ? onPlans.length : "—", { filter: "all", roomFilter: "all", groupBy: "project" })}
          <div className={`nous-live-load${load?.limit ? " is-attention" : ""}`}><dt>{t("Load")}</dt><dd>
            {onOpenLoad ? <button type="button" className="nous-live-load-open" onClick={onOpenLoad}
              aria-label={`Open the Load view: ${percent} of capacity in use${load ? `, target ${load.target}%` : ""}`}>{percent}</button> : percent}
            {load ? <small>{t("target {percent}%", { percent: load.target })}</small> : null}
          </dd></div>
        </dl>
        <LinkedLoadList rows={linked} />
      </NousLivePlans>
    </section>
  );
}

// A plan closed parked under 100% with its pane still open is still worked on (operator 22/11: Bob and Andy on a plan were not counted).
const plansOnPanes = (overview: NousOverview | null) => [...overview?.plans ?? [], ...overview?.closedPlans ?? []].filter((plan) => plan.pane);

/**
 * Live's plans: "Plans completed" (the Clipboard dock's figures, read again whenever the overview changes, plan clipboard:RXqSSUQSdwJK)
 * and every open plan, those on a pane first with their active mark, then those on no pane (operator request 2026-10-26: see them all,
 * apart), then those closed with work left (closed under 100%; operator 22/11), those on an open pane among the plans on a pane; with onOpen a row opens the plan.
 */
export function NousLivePlans({ overview, active, onOpen, children }: {
  overview: NousOverview | null; active: boolean; onOpen?(id: string): void; children?: ReactNode;
}) {
  const onPlans = plansOnPanes(overview);
  const offPlans = (overview?.plans ?? []).filter((plan) => !plan.pane);
  const closedPlans = (overview?.closedPlans ?? []).filter((plan) => !plan.pane);
  const activePlans = onPlans.filter((plan) => plan.active).length;
  const t = useUiText();
  const [completion, setCompletion] = useState<PlanCompletion | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    loadPlanCompletion().then((next) => { if (!cancelled) setCompletion(next); }).catch(() => {});
    return () => { cancelled = true; };
  }, [active, overview]);
  const rows = (plans: NousOverview["plans"]) => plans.map((plan) => {
    const where = plan.pane ?? t(plan.paneClosed ? "Pane closed" : "No pane");
    const working = t("Active: {pane} is working", { pane: plan.pane ?? "" });
    const row = (
      <>
        {plan.active
          ? <span className="nous-live-dot is-active" role="img" aria-label={working} title={working} />
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
        <p className="nous-live-plans-legend"><span className="nous-live-dot is-active" aria-hidden="true" />{t("Active {active} · On a pane {count}", { active: activePlans, count: onPlans.length })}</p>
      ) : null}
      {onPlans.length ? <ul className="nous-live-plans" aria-label={t("Plans on a pane")}>{rows(onPlans)}</ul> : null}
      {offPlans.length ? <p className="nous-live-plans-legend">{t("Not on a pane {count}", { count: offPlans.length })}</p> : null}
      {offPlans.length ? <ul className="nous-live-plans is-off-pane" aria-label={t("Plans not on a pane")}>{rows(offPlans)}</ul> : null}
      {closedPlans.length ? <p className="nous-live-plans-legend">{t("Closed with work left {count}", { count: closedPlans.length })}</p> : null}
      {closedPlans.length ? <ul className="nous-live-plans is-off-pane" aria-label={t("Plans closed with work left")}>{rows(closedPlans)}</ul> : null}
    </>
  );
}
