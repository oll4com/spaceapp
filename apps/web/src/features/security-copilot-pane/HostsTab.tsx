import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import type { SecurityHostView, SecuritySummary } from "./types.js";

const REACH_LABEL: Record<SecurityHostView["reach"], string> = { LOCAL: "This server", SSH: "SSH", PVE_SHELL: "Proxmox shell", QM_GUEST_EXEC: "Guest agent", PCT_EXEC: "Container exec", NONE: "Not reachable" };
const STATUS_LABEL: Record<SecurityHostView["status"], string> = { ACTIVE: "Running", STOPPED: "Stopped", UNREACHABLE: "Unreachable" };

/** Hosts: every Proxmox host the copilot knows, how it reaches it, when it last looked and what waits there; and the feeds' state. */
export function HostsTab({ hosts, summary }: { hosts: SecurityHostView[]; summary: SecuritySummary | null }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const feeds = Object.entries(summary?.feeds ?? {});
  return (
    <div className="sc-hosts" role="tabpanel" id="jc-panel-hosts" aria-labelledby="jc-tab-hosts">
      {summary ? <p className="jc-muted">{t("{inventoried} of {active} running hosts inventoried · {total} known", { inventoried: summary.hosts.inventoried, active: summary.hosts.active, total: summary.hosts.total })}</p> : null}
      <ul className="jc-list sc-host-list" aria-label={t("Hosts")}>
        {hosts.map((host) => (
          <li key={host.id} className="sc-host" data-status={host.status.toLowerCase()}>
            <div className="jc-row">
              <strong>{host.label}</strong>
              <span className={`jc-pill status-${host.status.toLowerCase()}`}>{t(STATUS_LABEL[host.status])}</span>
              {host.rebootRequired ? <span className="jc-pill sc-kev">{t("Reboot pending")}</span> : null}
            </div>
            <p className="jc-muted">{[host.alias, t(REACH_LABEL[host.reach]), host.osFamily === "UNKNOWN" ? t("OS not read yet") : `${host.osFamily.toLowerCase()} ${host.osVersion}`,
              ...(host.osFamily === "WINDOWS" || host.osFamily === "MACOS" ? [t("listed only (not patched in this version)")] : [])].join(" · ")}</p>
            <p className="sc-host-line">{host.inventoryAt ? t("Inventory {time} · {packages} packages · {pending} security updates waiting · {findings} open findings", { time: new Date(host.inventoryAt).toLocaleString(), packages: host.packages, pending: host.pendingSecurity, findings: host.openFindings }) : t("Not inventoried yet")}</p>
            {host.note ? <p className="jc-muted">{host.note}</p> : null}
          </li>
        ))}
      </ul>
      {!hosts.length ? <p className="jc-muted jc-empty">{t("No hosts yet: the copilot discovers them on its first run.")}</p> : null}
      {feeds.length ? (
        <section className="jc-card" aria-label={t("Vulnerability feeds")}>
          <strong>{t("Feeds")}</strong>
          <ul className="sc-feeds">
            {feeds.map(([name, feed]) => (
              <li key={name}>{name.replace(/^news:/, "")}: {feed.lastError ? <span className="sc-feed-error">{feed.lastError}</span> : feed.lastOkAt ? t("read {time}", { time: new Date(feed.lastOkAt).toLocaleString() }) : t("not read yet")}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
