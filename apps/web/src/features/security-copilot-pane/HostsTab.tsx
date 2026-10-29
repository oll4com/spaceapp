import type { SecurityHostView, SecuritySummary } from "./types.js";

const REACH_LABEL: Record<SecurityHostView["reach"], string> = { LOCAL: "This server", SSH: "SSH", PVE_SHELL: "Proxmox shell", QM_GUEST_EXEC: "Guest agent", PCT_EXEC: "Container exec", NONE: "Not reachable" };
const STATUS_LABEL: Record<SecurityHostView["status"], string> = { ACTIVE: "Running", STOPPED: "Stopped", UNREACHABLE: "Unreachable" };

/** Hosts: every Proxmox host the copilot knows, how it reaches it, when it last looked and what waits there; and the feeds' state. */
export function HostsTab({ hosts, summary }: { hosts: SecurityHostView[]; summary: SecuritySummary | null }) {
  const feeds = Object.entries(summary?.feeds ?? {});
  return (
    <div className="sc-hosts" role="tabpanel" id="jc-panel-hosts" aria-labelledby="jc-tab-hosts">
      {summary ? <p className="jc-muted">{summary.hosts.inventoried} of {summary.hosts.active} running hosts inventoried · {summary.hosts.total} known</p> : null}
      <ul className="jc-list sc-host-list" aria-label="Hosts">
        {hosts.map((host) => (
          <li key={host.id} className="sc-host" data-status={host.status.toLowerCase()}>
            <div className="jc-row">
              <strong>{host.label}</strong>
              <span className={`jc-pill status-${host.status.toLowerCase()}`}>{STATUS_LABEL[host.status]}</span>
              {host.rebootRequired ? <span className="jc-pill sc-kev">Reboot pending</span> : null}
            </div>
            <p className="jc-muted">{host.alias} · {REACH_LABEL[host.reach]} · {host.osFamily === "UNKNOWN" ? "OS not read yet" : `${host.osFamily.toLowerCase()} ${host.osVersion}`}
              {host.osFamily === "WINDOWS" || host.osFamily === "MACOS" ? " · listed only (not patched in this version)" : ""}</p>
            <p className="sc-host-line">{host.inventoryAt ? `Inventory ${new Date(host.inventoryAt).toLocaleString()} · ${host.packages} packages · ${host.pendingSecurity} security updates waiting · ${host.openFindings} open findings` : "Not inventoried yet"}</p>
            {host.note ? <p className="jc-muted">{host.note}</p> : null}
          </li>
        ))}
      </ul>
      {!hosts.length ? <p className="jc-muted jc-empty">No hosts yet: the copilot discovers them on its first run.</p> : null}
      {feeds.length ? (
        <section className="jc-card" aria-label="Vulnerability feeds">
          <strong>Feeds</strong>
          <ul className="sc-feeds">
            {feeds.map(([name, feed]) => (
              <li key={name}>{name.replace(/^news:/, "")}: {feed.lastError ? <span className="sc-feed-error">{feed.lastError}</span> : feed.lastOkAt ? `read ${new Date(feed.lastOkAt).toLocaleString()}` : "not read yet"}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
