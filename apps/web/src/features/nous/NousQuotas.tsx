import { useCallback, useEffect, useState } from "react";
import { formatAppTime, useDateTimeSettings } from "../date-time-settings/date-time-settings.js";
import { ApiProviders, ProviderSummary } from "../desktop-widgets/AiQuotaWidget.js";
import { computeApiProviderMetrics } from "../desktop-widgets/quota-aggregates.js";
import { buildQuotaOverview } from "../desktop-widgets/quota-overview.js";
import { fetchSharedQuotaMetrics, peekSharedQuotaMetrics, subscribeSharedQuota } from "../desktop-widgets/shared-quota-cache.js";
import { DockIconButton, DockState } from "../dock-kit/DockKit.js";
import { Gauge, RotateCw } from "../ui-theme/app-icons.js";
import { NousTokenUsage } from "./NousTokenUsage.js";

/** Resources → Accounts & quotas on one page, one card per provider and no account list, count or e-mail (operator 2026-10-29 and 6/11, plan clipboard:4pyungpPsrfD). */
export function NousQuotas({ active }: { active: boolean }) {
  const [sample, setSample] = useState(() => peekSharedQuotaMetrics());
  const [clock, setClock] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const { settings } = useDateTimeSettings();
  const refresh = useCallback((force: boolean) => {
    setLoading(true);
    void fetchSharedQuotaMetrics(force).then(setSample).finally(() => { setLoading(false); setClock(Date.now()); });
  }, []);
  useEffect(() => subscribeSharedQuota(setSample), []);
  useEffect(() => {
    if (!active) return;
    refresh(false);
    // The shared sample lives a minute (shared-quota-cache.ts); read it again as it expires while the dock is shown.
    const timer = setInterval(() => { if (document.visibilityState === "visible") refresh(false); }, 60_000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  if (!sample) return <DockState kind="loading" icon={Gauge} title="Loading quotas" />;
  const overview = buildQuotaOverview(sample, clock);
  const api = computeApiProviderMetrics(sample.api);
  return (
    <section className="nous-overview" aria-label="Quotas">
      <div className="aiq">
        {overview.providers.map((provider) => <ProviderSummary key={provider.provider} overview={provider} clock={clock} settings={settings} perProvider />)}
        {!overview.providers.length && !api.totalProviders ? <p className="aiq-empty">No AI accounts or API keys are connected in this installation yet.</p> : null}
        {api.totalProviders ? <>
          <h3>API providers · {api.connectedProviders}/{api.totalProviders} connected{api.totalBalanceUsd > 0 ? ` · $${api.totalBalanceUsd.toFixed(2)}` : ""}</h3>
          <ApiProviders sample={sample} />
        </> : null}
        <footer className="aiq-footer">
          <span>Updated {formatAppTime(sample.fetchedAt)}</span>
          <DockIconButton label="Refresh quotas now" icon={RotateCw} busy={loading} disabled={loading} onClick={() => refresh(true)} />
        </footer>
      </div>
      <NousTokenUsage active={active} />
    </section>
  );
}
