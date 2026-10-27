import { api } from "../../api.js";

export interface PlanCompletion { total: number; completed: number }

/** Every plan in the clipboard, whatever a view filters: completed = all plans − open plans (counts only). */
export async function loadPlanCompletion(): Promise<PlanCompletion> {
  const [all, open] = await Promise.all([
    api.clipboardItems({ source: "PLAN", includeCompleted: true, page: 1, pageSize: 1 }),
    api.clipboardItems({ source: "PLAN", includeCompleted: false, page: 1, pageSize: 1 })
  ]);
  return { total: all.pagination.totalItems, completed: all.pagination.totalItems - open.pagination.totalItems };
}

/** "Plans completed X / Y NN%": the Clipboard dock and the Nous dock's Live view show the same bar and numbers. */
export function PlanCompletionBar({ total, completed }: PlanCompletion) {
  if (!total) return null;
  const percent = Math.round((completed / total) * 100);
  return (
    <div className="clipboard-plan-stats" role="group" aria-label="Plan completion">
      <span className="clipboard-plan-stats-label">Plans completed</span>
      <div className="clipboard-plan-progress-bar" role="progressbar" aria-label="Plans completed" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className={`clipboard-plan-progress-fill${percent === 100 ? " is-completed" : ""}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="clipboard-plan-stats-count">{completed} / {total}</span>
      <span className="clipboard-plan-pct">{percent}%</span>
    </div>
  );
}
