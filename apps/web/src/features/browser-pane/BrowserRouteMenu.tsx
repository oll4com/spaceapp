import { useEffect, useId, useState } from "react";
import { FREELANCE_EGRESS_LABELS, FREELANCE_EGRESS_ROUTES, type CliGlobalEgressStatus, type FreelanceEgressRoute } from "@space/contracts";
import { api } from "../../api.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

/**
 * Where this pane browser's traffic leaves from (operator 31/10 01:00 BKK, plan clipboard:iLvBs5eOMZjF): this server or one of the
 * CLI VPN routes, kept for the pane. The server restarts a running browser on the new route.
 */
export function BrowserRouteMenu({ paneId, title, onChanged }: { paneId: string; title: string; onChanged(): void }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const describedBy = useId();
  const [route, setRoute] = useState<FreelanceEgressRoute | null>(null);
  // A self-hosted install offers only "direct": the VPN routes exist on the SpaceApp server alone.
  const [routes, setRoutes] = useState<readonly FreelanceEgressRoute[]>(FREELANCE_EGRESS_ROUTES);
  // Settings → CLI VPN route, read on every open: a VPN added or removed there shows here the next time the menu opens.
  const [egress, setEgress] = useState<CliGlobalEgressStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.browserRoute(paneId).then((answer) => { if (live) { setRoute(answer.route); if (answer.routes) setRoutes(answer.routes); } },
      (err: unknown) => { if (live) setError(err instanceof Error ? err.message : t("The network route could not be read.")); });
    api.cliGlobalEgress().then((status) => { if (live && status.supported) setEgress(status); }, () => undefined);
    return () => { live = false; };
  }, [paneId]);
  const choose = async (next: FreelanceEgressRoute) => {
    setBusy(true);
    setError(null);
    try {
      setRoute((await api.setBrowserRoute(paneId, next)).route);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("The network route could not be saved."));
    } finally {
      setBusy(false);
    }
  };
  /** The exit IP the route leaves from, or why it has none. */
  const state = (id: FreelanceEgressRoute): string | null => {
    if (!egress) return null;
    if (id === "direct") return egress.directEgressIpv4;
    const profile = egress.profiles[id];
    if (!profile.profileConfigured) return t(egress.removedProfiles.includes(id) ? "VPN removed" : "not configured");
    return profile.status === "CONNECTED" ? profile.egressIpv4 ?? t("connected") : t("not connected");
  };
  // A VPN without a profile cannot carry traffic; it stays listed only while this pane is still on it.
  const shown = routes.filter((id) => id === "direct" || id === route || !egress || egress.profiles[id].profileConfigured);
  return (
    <div className="browser-bookmark-popover browser-route-popover toolbar-floating-menu jc-pane" role="dialog" aria-label={t("Network route {title}", { title })}>
      <p className="jc-muted">{t("Where this browser's traffic leaves from. The pane keeps it; a running browser restarts on the same page.")}</p>
      <div className="browser-route-options" role="radiogroup" aria-label={t("Network route")}>
        {shown.map((id) => {
          const detail = state(id);
          return (
            <button key={id} type="button" role="radio" aria-checked={route === id} className={`jc-button${route === id ? " primary" : ""}`}
              aria-label={t(FREELANCE_EGRESS_LABELS[id])} aria-describedby={detail ? `${describedBy}-${id}` : undefined} disabled={busy || route === null} onClick={() => void choose(id)}>
              <span>{t(FREELANCE_EGRESS_LABELS[id])}</span>
              {detail ? <small id={`${describedBy}-${id}`}>{detail}</small> : null}
            </button>
          );
        })}
      </div>
      <p className="jc-muted">{t("Panes on the same browser account share one browser and one route: a change restarts it for all of them. A route that is down loads no pages; it never falls back to this server.")}</p>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
