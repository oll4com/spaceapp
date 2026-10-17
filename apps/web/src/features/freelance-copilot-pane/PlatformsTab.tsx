import { useEffect, useState } from "react";
import { FREELANCE_CHANNELS, FREELANCE_CHANNEL_LABELS, type FreelanceAccount, type FreelanceFunnel, type FreelanceLead, type FreelanceLeadStatus } from "@space/contracts";
import { api } from "../../api.js";
import { ExternalLink } from "../ui-theme/app-icons.js";
import { LeadRow } from "./LeadsTab.js";
import { ACCOUNT_STATUS_LABEL } from "./SetupTab.js";

/** A platform's leads in working order: clients and conversations first, closed ones last. */
const ORDER: FreelanceLeadStatus[] = ["CLIENT_READY", "TALKING", "PROPOSED", "QUALIFIED", "NEW", "WON", "LOST", "SKIPPED"];

/** Platforms: per site, the account, its numbers and every job with its proposals and messages. */
export function PlatformsTab({ paneId, leads, funnel, onChanged }: { paneId: string; leads: FreelanceLead[]; funnel: FreelanceFunnel | null; onChanged(): void }) {
  const [accounts, setAccounts] = useState<FreelanceAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.freelanceAccounts().then((response) => { if (!cancelled) setAccounts(response.accounts); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return (
    <div className="mk-posts" role="tabpanel" id="jc-panel-platforms" aria-labelledby="jc-tab-platforms">
      {FREELANCE_CHANNELS.map((channel) => {
        const label = FREELANCE_CHANNEL_LABELS[channel];
        const account = accounts.find((entry) => entry.channel === channel);
        const counts = funnel?.channels[channel];
        const entries = leads.filter((lead) => lead.channel === channel).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
        return (
          <section key={channel} className="mk-group" aria-label={label}>
            <h4>{label} <span className="jc-tag">{ACCOUNT_STATUS_LABEL[account?.status ?? "NOT_STARTED"]}</span>
              {account?.profileUrl ? <a className="jc-event-link" href={account.profileUrl} target="_blank" rel="noreferrer noopener"><ExternalLink aria-hidden="true" /> Profile</a> : null}</h4>
            {account?.email ? <p className="jc-muted">{account.email}</p> : null}
            {account?.notes ? <p className="jc-muted">{account.notes}</p> : null}
            {counts ? (
              <p className="fl-funnel">
                <span><strong>{entries.length}</strong> jobs</span><span><strong>{counts.sent}</strong> sent</span><span><strong>{counts.talking}</strong> conversations</span>
                <span><strong>{counts.won}</strong> won</span><span><strong>{counts.lost}</strong> lost</span>
              </p>
            ) : null}
            {entries.length ? <ul className="mk-post-list">{entries.map((lead) => <LeadRow key={lead.id} lead={lead} paneId={paneId} onChanged={onChanged} />)}</ul>
              : <p className="jc-muted">No jobs or proposals yet.</p>}
          </section>
        );
      })}
    </div>
  );
}
