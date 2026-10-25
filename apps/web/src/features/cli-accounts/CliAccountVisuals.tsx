import type { CSSProperties } from "react";
import "./cli-accounts.css";
import { Check } from "../ui-theme/app-icons.js";
import {
  CLI_ACCOUNT_BLOCKED_COLOR,
  cliAccountAvailabilityColor,
  cliAccountInitials,
  type CliAccountAvailability,
} from "./cli-account-availability.js";

export function accountColorStyle(availability: CliAccountAvailability): CSSProperties {
  return { "--cli-account-color": availability.color } as CSSProperties;
}

// Initials inside a ring coloured by the account's availability; a check marks the active one.
export function CliAccountAvatar({ name, availability, active = false }: {
  name: string;
  availability: CliAccountAvailability;
  active?: boolean;
}) {
  return (
    <span className="cli-account-avatar" data-tone={availability.tone} style={accountColorStyle(availability)} aria-hidden="true">
      {cliAccountInitials(name)}
      {active ? (
        <span className="cli-account-avatar-check">
          <Check />
        </span>
      ) : null}
    </span>
  );
}

// Remaining quota as a bar in the same colour; accounts without quota data show an empty track.
// Several reported windows show as one thin bar each, so a spent window stays visible.
export function CliAccountMeter({ availability }: { availability: CliAccountAvailability }) {
  const windows = availability.windows.filter((window) => window.percent != null);
  if (windows.length > 1) {
    return (
      <span className="cli-account-meter-split" aria-hidden="true">
        {windows.map((window) => {
          const percent = Math.min(Math.max(window.percent!, 0), 100);
          const spent = percent < 1;
          return (
            <span
              key={window.label}
              className="cli-account-meter"
              data-tone={spent ? "blocked" : "ready"}
              style={{ "--cli-account-color": spent ? CLI_ACCOUNT_BLOCKED_COLOR : cliAccountAvailabilityColor(percent) } as CSSProperties}
              title={`${window.label} ${Math.round(percent)}%`}
            >
              <span className="cli-account-meter-fill" style={{ width: `${percent}%` }} />
            </span>
          );
        })}
      </span>
    );
  }
  const percent = availability.percent;
  const width = availability.tone === "blocked"
    ? Math.max(percent ?? 0, 0)
    : percent ?? (availability.tone === "ready" ? 100 : 0);
  return (
    <span className="cli-account-meter" data-tone={availability.tone} style={accountColorStyle(availability)} aria-hidden="true">
      <span className="cli-account-meter-fill" style={{ width: `${Math.min(Math.max(width, 0), 100)}%` }} />
    </span>
  );
}

// Explains the colour scale once: empty to full quota, red when the account cannot be used now.
export function CliAccountColorLegend() {
  return (
    <span className="cli-account-legend" aria-hidden="true">
      <span className="cli-account-legend-dot is-blocked" />
      <span>Unavailable</span>
      <span className="cli-account-legend-scale" />
      <span>Full quota</span>
    </span>
  );
}
