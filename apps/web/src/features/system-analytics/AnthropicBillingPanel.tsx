import { useEffect, useState } from "react";
import type { GatewayAnthropicBillingReport, SystemAnalyticsRange } from "@space/contracts";
import { api } from "../../api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { CreditCard } from "../ui-theme/app-icons.js";
import { formatUsd } from "./token-totals.js";

const daysFor = (range: SystemAnalyticsRange) => (range === "30d" ? 30 : range === "7d" ? 7 : 1);

/**
 * Anthropic's own bill for the Claude API (operator request 2026-10-18), read by Space Gateway with the operator's
 * Admin API key, next to the gateway's list-price estimate. Hidden for users who are not administrators.
 */
export function AnthropicBillingPanel({ range, refreshToken }: { range: SystemAnalyticsRange; refreshToken: number }) {
  const [report, setReport] = useState<GatewayAnthropicBillingReport | null>(null);
  useEffect(() => {
    let active = true;
    api.gatewayAnthropicBilling(daysFor(range)).then((next) => { if (active) setReport(next); }).catch(() => { if (active) setReport(null); });
    return () => { active = false; };
  }, [range, refreshToken]);
  if (!report) return null;
  const { status, days } = report;
  const sum = (pick: (day: GatewayAnthropicBillingReport["days"][number]) => number) => days.reduce((total, day) => total + pick(day), 0);
  const models = new Map<string, { billedUsd: number; listUsd: number; gatewayEstimateUsd: number; gatewayBilledUsd: number }>();
  for (const model of days.flatMap((day) => day.models)) {
    const entry = models.get(model.model) ?? { billedUsd: 0, listUsd: 0, gatewayEstimateUsd: 0, gatewayBilledUsd: 0 };
    models.set(model.model, { billedUsd: entry.billedUsd + model.billedUsd, listUsd: entry.listUsd + model.listUsd,
      gatewayEstimateUsd: entry.gatewayEstimateUsd + model.gatewayEstimateUsd, gatewayBilledUsd: entry.gatewayBilledUsd + model.gatewayBilledUsd });
  }
  const period = daysFor(range) === 1 ? "Today (UTC)" : `Last ${daysFor(range)} days (UTC)`;
  const unreported = days.filter((day) => !day.reported).map((day) => day.day);
  return <section className="system-analytics-panel" aria-label="Anthropic bill">
    <header><CreditCard aria-hidden="true" /><div><strong>Anthropic bill</strong>
      <small>{status.configured ? `${period} · from Anthropic's Admin API · last sync ${status.lastSyncAt ? formatUserTime(status.lastSyncAt, { withDate: true }) : "pending"}`
        : "Claude API cost as Anthropic bills it"}</small></div></header>
    {!status.configured ? <p>Save an Anthropic Admin API key in Space Gateway → Settings → Anthropic billing to see the real Claude API charge here.</p> : <>
      {status.lastError ? <p className="system-analytics-error" role="alert">The last sync with Anthropic failed ({status.lastError}).</p> : null}
      <div className="system-analytics-stats">
        <article className="system-analytics-stat"><span>Organization</span><strong>{formatUsd(sum((day) => day.organizationUsd))}</strong><small>Every workspace and cost type</small></article>
        <article className="system-analytics-stat"><span>Gateway keys' workspace</span><strong>{formatUsd(sum((day) => day.workspaceUsd))}</strong><small>Including its use outside Space Gateway</small></article>
        <article className="system-analytics-stat"><span>Space Gateway estimate</span><strong>{formatUsd(sum((day) => day.gatewayEstimateUsd))}</strong><small>Claude API-key accounts at list prices</small></article>
        <article className="system-analytics-stat"><span>Space Gateway real charge</span><strong>{formatUsd(sum((day) => day.gatewayBilledUsd))}</strong><small>What the daily cost limits count</small></article>
      </div>
      {unreported.length ? <p>Anthropic has not posted {unreported.join(", ")} yet. Until it does, the real charge there is the gateway estimate times the last 7 days' factor.</p> : null}
      {models.size > 0 ? <div className="system-analytics-table-scroll"><table aria-label="Anthropic bill by model"><thead><tr><th>Model</th><th>Billed</th><th>Same tokens at list price</th><th>Factor</th><th>Gateway estimate</th><th>Gateway real charge</th></tr></thead><tbody>
        {[...models].sort((a, b) => b[1].billedUsd - a[1].billedUsd).map(([model, row]) => <tr key={model}><td><strong>{model}</strong></td><td>{formatUsd(row.billedUsd)}</td>
          <td>{formatUsd(row.listUsd)}</td><td>{row.listUsd >= 0.05 ? `×${(row.billedUsd / row.listUsd).toFixed(2)}` : "—"}</td><td>{formatUsd(row.gatewayEstimateUsd)}</td><td>{formatUsd(row.gatewayBilledUsd)}</td></tr>)}
      </tbody></table></div> : <p>No Claude API charges in this period.</p>}
      <p>Anthropic reports a request about 5 minutes after it ends. The factor is Anthropic's charge divided by the same tokens at list price; Space Gateway multiplies its estimate by it, so the daily cost limits of keys on the Claude API-key account count the real charge.</p>
    </>}
  </section>;
}
