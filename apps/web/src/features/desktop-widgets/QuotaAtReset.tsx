import { quotaResetCreditsText } from "@space/contracts";
import { CLI_ACCOUNT_BLOCKED_COLOR, cliAccountAvailabilityColor } from "../cli-accounts/cli-account-availability.js";
import { formatUntil } from "../toolbar-metrics/account-availability.js";
import type { ProviderAtReset, QuotaAtResetEntry } from "./quota-overview.js";
import "./quota-at-reset.css";

const paceText: Record<QuotaAtResetEntry["pace"], string> = { AHEAD: "ahead of pace", ON: "on pace", UNDER: "under pace" };

/**
 * A provider card's "At reset 56% free at Fri 06:00 · on pace" (plan clipboard:FDitYcI63D9R): quotaLeftAtReset over the pane account
 * menus' accounts, in their words and colour scale, so the card and the menu show one figure.
 */
export function QuotaAtReset({ atReset: { entries, unknown }, clock }: { atReset: ProviderAtReset; clock: number }) {
  return (
    <span className="quota-at-reset">
      <span className="quota-at-reset-label">At reset</span>
      <span className="quota-at-reset-values">{entries.length ? entries.map((entry) => {
        const until = formatUntil(entry.resetAt, clock);
        const when = !until ? "at reset" : until === "now" || until.startsWith("in ") ? until : `at ${until}`;
        const percent = Math.round(entry.percent);
        return (
          <span key={entry.scope ?? "all"} title={`At the current pace, ${percent}% of the ${entry.scope ? `${entry.scope} ` : ""}weekly quota is still free when it resets ${when} (${paceText[entry.pace]}).${entry.resetCredits ? ` Plus ${quotaResetCreditsText(entry.resetCredits).slice(1)}: each reset credit gives a fresh week.` : ""} API keys are not counted.`}>
            {entry.scope ? `${entry.scope} ` : ""}<b style={{ color: entry.percent >= 1 ? cliAccountAvailabilityColor(entry.percent) : CLI_ACCOUNT_BLOCKED_COLOR }}>{percent}%</b> free {when} · {paceText[entry.pace]}{entry.resetCredits ? ` · ${quotaResetCreditsText(entry.resetCredits)}` : ""}
          </span>
        );
      }) : <span>unknown{unknown ? ` (${unknown})` : ""}</span>}</span>
    </span>
  );
}
