import { useState, type ReactNode } from "react";
import type { NousOverview, NousPlanHold, NousPlanHolds } from "@space/contracts";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockChips, DockState } from "../dock-kit/DockKit.js";
import { Nous } from "../ui-theme/app-icons.js";

/**
 * The Plans view (operator request 2026-10-25), the same picture Nous reads in its world: the server-wide holds, what to unblock
 * first (only what someone can act on, merged when plans wait on the same thing), the dates, and every plan grouped by what it
 * waits on; on a desktop a diagram from each blocker to the plans it holds. Redesigned the same day after the operator's review
 * (a wall of underlined links, every plan under Unblock first, an unreadable one-column diagram).
 */
type PlanRow = NousOverview["plans"][number];
type Blocker = NousPlanHolds["unblockFirst"][number];
type GroupKey = NousPlanHold["kind"] | "NONE";

const KIND_LABELS: Record<Blocker["kind"], string> = {
  OPERATOR: "You", THIRD_PARTY: "Third party", PROMOTE: "Promote", NOUS: "Nous", SERVER: "Server", PLAN: "Plan", DATE: "Date", FINISH: "Finish"
};
const GROUPS: Array<[GroupKey, string]> = [
  ["OPERATOR", "Waits on you"], ["THIRD_PARTY", "Waits on a third party"], ["PROMOTE", "Waits on a promote"], ["NOUS", "Waits on Nous"],
  ["SERVER", "Held by the server"], ["PLAN", "Waits on another plan"], ["DATE", "Waits for a date"], ["NONE", "No wait recorded"]
];
const GROUP_TITLE = new Map(GROUPS);
const when = (iso: string) => formatUserTime(iso, { withDate: true });
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const DATES_SHOWN = 6;

export function NousPlanMap({ overview, onOpen }: { overview: NousOverview | null; onOpen(id: string): void }) {
  const [view, setView] = useState<"list" | "diagram">("list");
  const [allDates, setAllDates] = useState(false);
  if (!overview) return <DockState kind="loading" title="Loading the plans" />;
  const plans = overview.plans;
  if (!plans.length) return <DockState kind="empty" icon={Nous} title="No open plans" detail="Plans you or Nous record appear here with what they wait on, their dates and what depends on what." />;
  const holds = overview.planHolds ?? { holds: [], unblockFirst: [], dates: [] };
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  const titleOf = (id: string) => byId.get(id)?.title ?? id;
  const chip = (id: string) => (
    <button key={id} type="button" className="nous-plans-btn nous-plan-chip" title={titleOf(id)} onClick={() => onOpen(id)}>{titleOf(id)}</button>
  );
  const waitingOnYou = plans.filter((plan) => plan.hold?.kind === "OPERATOR").length;
  const overdue = holds.dates.filter((date) => date.kind === "DUE" && date.overdue).length;
  const groups = GROUPS.map(([key, title]) => ({ key, title, plans: plans.filter((plan) => (plan.hold?.kind ?? "NONE") === key)
    .sort((left, right) => (left.level ?? 0) - (right.level ?? 0) || (sortTime(left) ?? "9").localeCompare(sortTime(right) ?? "9") || left.title.localeCompare(right.title)) }))
    .filter((group) => group.plans.length);
  const dates = allDates ? holds.dates : holds.dates.slice(0, DATES_SHOWN);

  return (
    <div className="nous-plans" data-view={view}>
      <div className="nous-plans-bar">
        <p className="nous-plans-summary">
          <strong>{plural(plans.length, "open plan")}</strong>
          {waitingOnYou ? <span className="is-you">{waitingOnYou} wait on you</span> : null}
          {overdue ? <span className="is-overdue">{overdue} overdue</span> : null}
        </p>
        {/* The diagram is for a desktop: in a container under 40rem the toggle and the diagram are hidden by CSS and the list shows. */}
        <div className="nous-plan-map-toggle">
          <DockChips label="Plan map view" value={view} onChange={setView} options={[{ id: "list", label: "List" }, { id: "diagram", label: "Diagram" }]} />
        </div>
      </div>

      {holds.holds.length ? (
        <div className="nous-plan-holds" role="alert">
          <strong>Holding every plan</strong>
          <ul>{holds.holds.map((hold) => <li key={hold.kind}>{hold.text}{hold.since ? ` Since ${when(hold.since)}.` : ""}</li>)}</ul>
        </div>
      ) : null}

      {view === "diagram" ? <PlanDiagram plans={plans} blockers={holds.unblockFirst} onOpen={onOpen} /> : null}

      <div className="nous-plans-list">
        <section className="nous-plans-section" aria-label="Unblock first">
          <h3>Unblock first</h3>
          {holds.unblockFirst.length ? (
            <ol className="nous-unblock">
              {holds.unblockFirst.map((item) => (
                <li key={`${item.kind}:${item.planIds.join(",") || item.what}`} className="nous-unblock-item">
                  <span className={`nous-kind is-${item.kind.toLowerCase()}`}>{KIND_LABELS[item.kind]}</span>
                  <div className="nous-unblock-body">
                    {item.kind === "FINISH" ? (
                      <button type="button" className="nous-plans-btn nous-unblock-finish" onClick={() => onOpen(item.planIds[0]!)}>{titleOf(item.planIds[0]!)}</button>
                    ) : <p className="nous-unblock-what" title={item.what}>{item.what}</p>}
                    {item.kind === "SERVER" ? <p className="nous-unblock-plans">Holds every plan</p>
                      : item.kind === "FINISH" ? <p className="nous-unblock-plans">Other plans depend on it</p>
                      : <p className="nous-unblock-plans"><span>Holds</span><span className="nous-plan-chips">{item.planIds.map(chip)}</span></p>}
                  </div>
                  <span className="nous-unblock-count" title={`Clearing it lets ${plural(item.unsticks, "plan")} move`}>{plural(item.unsticks, "plan")}</span>
                </li>
              ))}
            </ol>
          ) : <p className="nous-muted">Nothing to unblock: no plan waits on you, a third party, a promote, Nous or the server.</p>}
        </section>

        {holds.dates.length ? (
          <section className="nous-plans-section" aria-label="Dates">
            <h3>Dates</h3>
            <ol className="nous-plan-dates">
              {dates.map((date) => (
                <li key={`${date.kind}:${date.planId}`} className={date.overdue ? "is-overdue" : undefined}>
                  <time dateTime={date.at}>{when(date.at)}</time>
                  <span className="nous-plan-date-kind">{date.kind === "DUE" ? "Due" : "Resumes"}</span>
                  <button type="button" className="nous-plans-btn nous-plan-date-title" onClick={() => onOpen(date.planId)}>{date.title}</button>
                  {date.overdue ? <span className="nous-plan-date-flag">{date.kind === "DUE" ? "Overdue" : "Passed"}</span> : null}
                </li>
              ))}
            </ol>
            {holds.dates.length > DATES_SHOWN ? (
              <button type="button" className="nous-plans-btn nous-plans-more" onClick={() => setAllDates(!allDates)}>
                {allDates ? "Show fewer dates" : `Show all ${holds.dates.length} dates`}
              </button>
            ) : null}
          </section>
        ) : null}

        <section className="nous-plans-section" aria-label="All plans">
          <h3>All plans</h3>
          {groups.map((group) => (
            <div key={group.key} className="nous-plan-group">
              <h4>{group.title}<span className="nous-plan-group-count">{group.plans.length}</span></h4>
              <ul aria-label={group.title}>
                {group.plans.map((plan) => <PlanItem key={plan.id} plan={plan} chip={chip} onOpen={onOpen} />)}
              </ul>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

/** A plan's resume time (a wait for a date) or due date, for sorting inside its group. */
const sortTime = (plan: PlanRow) => plan.hold?.kind === "DATE" && plan.hold.until ? plan.hold.until : plan.dueAt ?? null;

function PlanItem({ plan, chip, onOpen }: { plan: PlanRow; chip(id: string): ReactNode; onOpen(id: string): void }) {
  const hold = plan.hold ?? null;
  const resumes = hold?.kind === "DATE" ? hold.until : null;
  const phrase = hold ? GROUP_TITLE.get(hold.kind)!.toLowerCase() : null;
  return (
    <li className="nous-plan-item">
      <button type="button" className={`nous-plans-btn nous-plan-row is-${plan.status.toLowerCase()}`} onClick={() => onOpen(plan.id)}
        aria-label={`Open the plan ${plan.title}, ${plan.progress}%${phrase ? `, ${phrase}` : ""}${plan.overdue ? ", overdue" : ""}`}>
        <span className="nous-plan-row-head">
          <span className="nous-plan-row-title">{plan.title}</span>
          <span className="nous-plan-row-pct">{plan.progress}%</span>
        </span>
        <span className="nous-progress" aria-hidden="true"><span style={{ width: `${plan.progress}%` }} /></span>
        {hold && hold.kind !== "PLAN" ? <span className="nous-plan-row-detail" title={hold.what}>{hold.what}</span> : null}
        <span className="nous-plan-row-meta">
          <span>{plan.pane ? `${plan.pane}${plan.room ? ` · ${plan.room}` : ""}` : plan.paneClosed ? "Pane closed" : "No pane"}</span>
          {resumes ? <span>Resumes {when(resumes)}</span> : null}
          {plan.dueAt ? <span className={plan.overdue ? "is-overdue" : undefined}>Due {when(plan.dueAt)}{plan.overdue ? " · overdue" : ""}</span> : null}
        </span>
      </button>
      {plan.dependsOn?.length ? <p className="nous-plan-needs"><span>Needs</span><span className="nous-plan-chips">{plan.dependsOn.map(chip)}</span></p> : null}
    </li>
  );
}

const NODE_W = 248; const NODE_H = 88; const GAP_X = 56; const GAP_Y = 12;

/**
 * Blockers on the left, the plans they hold to the right (one column per dependency level), an arrow from each blocker to its
 * plans and from each plan to the plans that depend on it. Fixed-size HTML boxes over an SVG of the arrows: the text stays
 * readable at every size and the diagram scrolls instead of shrinking.
 */
function PlanDiagram({ plans, blockers, onOpen }: { plans: PlanRow[]; blockers: Blocker[]; onOpen(id: string): void }) {
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  const dependents = new Map<string, string[]>();
  for (const plan of plans) for (const dep of plan.dependsOn ?? []) if (byId.has(dep)) dependents.set(dep, [...(dependents.get(dep) ?? []), plan.id]);
  const nextY: number[] = [];
  const at = new Map<string, { col: number; y: number }>();
  const top = () => Math.max(0, ...nextY.map((y) => y ?? 0));
  const place = (id: string, minY: number) => {
    if (at.has(id) || !byId.has(id)) return;
    const col = 1 + (byId.get(id)!.level ?? 0);
    const y = Math.max(nextY[col] ?? 0, minY);
    at.set(id, { col, y });
    nextY[col] = y + NODE_H + GAP_Y;
    for (const dep of dependents.get(id) ?? []) place(dep, y);
  };
  const boxes: Array<{ blocker: Blocker; y: number }> = [];
  for (const blocker of blockers.filter((item) => item.kind !== "SERVER")) {
    const band = top();
    for (const id of blocker.planIds) place(id, band);
    if (blocker.kind === "FINISH") continue;
    const ys = blocker.planIds.map((id) => at.get(id)?.y).filter((y): y is number => y !== undefined);
    const y = Math.max(nextY[0] ?? 0, ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : band);
    nextY[0] = y + NODE_H + GAP_Y;
    boxes.push({ blocker, y });
  }
  if (!at.size) return <DockState kind="empty" icon={Nous} title="Nothing to unblock" detail="No plan waits on you, a third party, a promote, Nous or another plan." />;
  // Without blocker boxes the plans start at the left edge.
  const shift = boxes.length ? 0 : 1;
  const x = (col: number) => (col - shift) * (NODE_W + GAP_X);
  const cols = Math.max(...[...at.values()].map((entry) => entry.col)) + 1 - shift;
  const width = cols * (NODE_W + GAP_X) - GAP_X;
  const height = top() - GAP_Y;
  const edge = (fromX: number, fromY: number, toX: number, toY: number) => {
    const startX = fromX + NODE_W; const startY = fromY + NODE_H / 2; const endY = toY + NODE_H / 2;
    return `M${startX},${startY} C${startX + GAP_X / 2},${startY} ${toX - GAP_X / 2},${endY} ${toX},${endY}`;
  };
  const edges = [
    ...boxes.flatMap(({ blocker, y }) => blocker.planIds.filter((id) => at.has(id)).map((id) => ({ key: `${blocker.kind}:${blocker.what}>${id}`, d: edge(x(0), y, x(at.get(id)!.col), at.get(id)!.y) }))),
    ...[...at].flatMap(([id, from]) => (dependents.get(id) ?? []).filter((dep) => at.has(dep)).map((dep) => ({ key: `${id}>${dep}`, d: edge(x(from.col), from.y, x(at.get(dep)!.col), at.get(dep)!.y) })))
  ];
  const left = plans.length - at.size;
  return (
    <div className="nous-plan-diagram-wrap">
      <div className="nous-plan-diagram-scroll">
      <div className="nous-plan-diagram" role="group" aria-label="Plan dependencies" style={{ width, height }}>
        <svg className="nous-plan-edges" width={width} height={height} aria-hidden="true">
          <defs>
            <marker id="nous-plan-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" /></marker>
          </defs>
          {edges.map((item) => <path key={item.key} className="nous-plan-edge" d={item.d} markerEnd="url(#nous-plan-arrow)" />)}
        </svg>
        {boxes.map(({ blocker, y }) => (
          <div key={`${blocker.kind}:${blocker.what}`} className={`nous-diagram-node is-blocker is-${blocker.kind.toLowerCase()}`} style={{ left: x(0), top: y }} title={blocker.what}>
            <span className={`nous-kind is-${blocker.kind.toLowerCase()}`}>{KIND_LABELS[blocker.kind]}</span>
            <span className="nous-diagram-text">{blocker.what}</span>
          </div>
        ))}
        {[...at].map(([id, entry]) => {
          const plan = byId.get(id)!;
          const resumes = plan.hold?.kind === "DATE" ? plan.hold.until : null;
          return (
            <button key={id} type="button" className={`nous-plans-btn nous-diagram-node is-plan${plan.overdue ? " is-overdue" : ""}`} style={{ left: x(entry.col), top: entry.y }}
              aria-label={`Open the plan ${plan.title}`} title={plan.title} onClick={() => onOpen(id)}>
              <span className="nous-diagram-text">{plan.title}</span>
              <span className="nous-diagram-meta">{plan.progress}%{plan.dueAt ? ` · due ${when(plan.dueAt)}` : resumes ? ` · resumes ${when(resumes)}` : ""}</span>
              <span className="nous-progress" aria-hidden="true"><span style={{ width: `${plan.progress}%` }} /></span>
            </button>
          );
        })}
      </div>
      </div>
      {left ? <p className="nous-muted">{plural(left, "other plan")} wait{left === 1 ? "s" : ""} on nothing you can unblock: see the list.</p> : null}
    </div>
  );
}
