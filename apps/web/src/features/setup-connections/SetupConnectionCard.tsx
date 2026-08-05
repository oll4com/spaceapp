import {
  Ban,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  Terminal
} from "lucide-react";
import type {
  SetupConnection,
  SetupConnectionCheckEvent
} from "@space/contracts";

const reasonMessages: Record<string, string> = {
  CREDENTIAL_REQUIRED: "Sign in to this CLI so Space can use its saved credential.",
  NOT_VERIFIED: "A saved credential is ready. Check the provider response when you want fresh live evidence.",
  PROVIDER_QUOTA_LIMITED: "The CLI is functional, but the provider account is currently quota limited.",
  PROVIDER_CHECK_FAILED: "The CLI is functional, but the provider did not return a successful live response.",
  PROVIDER_CHECK_TIMED_OUT: "The CLI is functional, but the live provider response timed out.",
  CHECK_EXECUTION_FAILED: "The CLI remains functional. The latest live check could not complete safely.",
  SMOKE_FAILED: "The CLI is functional, but the latest live provider check failed.",
  CREDENTIAL_CHANGED: "The saved provider account changed. Run a new live check for fresh evidence.",
  CREDENTIAL_CHANGED_DURING_VERIFICATION: "The provider account changed during the check. Retry after login settles.",
  VERIFICATION_STALE: "The CLI is functional. Its previous live evidence is more than 30 days old.",
  CLI_RUNTIME_UNAVAILABLE: "This CLI is unavailable in the current Space runtime. Open maintenance to repair it."
};

const liveStatusLabels: Record<SetupConnection["liveVerificationState"], string> = {
  VERIFIED: "Live verified",
  QUOTA_LIMITED: "Quota limited",
  NOT_CHECKED: "Not live verified",
  PROVIDER_FAILED: "Provider failed",
  TIMED_OUT: "Timed out",
  CREDENTIAL_CHANGED: "Credential changed"
};

function FunctionalStatusIcon({
  connection,
  checking
}: {
  connection: SetupConnection;
  checking: boolean;
}) {
  if (checking) return <LoaderCircle className="is-spinning" aria-hidden="true" />;
  if (connection.functionalState === "FUNCTIONAL") return <CheckCircle2 aria-hidden="true" />;
  if (connection.functionalState === "UNAVAILABLE") return <Ban aria-hidden="true" />;
  return <CircleAlert aria-hidden="true" />;
}

function functionalStatusLabel(connection: SetupConnection): string {
  if (connection.functionalState === "FUNCTIONAL") return "Functional";
  if (connection.functionalState === "UNAVAILABLE") return "Unavailable";
  return "Needs setup";
}

interface SetupConnectionCardProps {
  checking: boolean;
  connection: SetupConnection;
  events: SetupConnectionCheckEvent[];
  onCheck: () => void;
  onConnect: () => void;
  onOpenMaintenance?: () => void;
}

export function SetupConnectionCard({
  checking,
  connection,
  events,
  onCheck,
  onConnect,
  onOpenMaintenance
}: SetupConnectionCardProps) {
  const canConnect =
    connection.functionalState === "NEEDS_SETUP" &&
    connection.actions.includes("OPEN_LOGIN_PANE");
  const canCheck =
    connection.functionalState === "FUNCTIONAL" &&
    connection.actions.includes("VERIFY");
  const canOpenMaintenance =
    connection.actions.includes("RUN_HOST_LAUNCHER") &&
    onOpenMaintenance;
  const latestEvent = events.at(-1);
  const completedSteps = latestEvent?.state === "COMPLETED"
    ? events.length
    : Math.max(0, events.length - 1);
  const reason = connection.reasonCode
    ? reasonMessages[connection.reasonCode] ?? "This CLI needs attention before its next live check."
    : connection.verifiedAt
      ? `Live response verified ${new Date(connection.verifiedAt).toLocaleString()}.`
      : "This CLI is functional and ready in Space.";

  return (
    <article
      className="setup-connection-card"
      data-functional-state={connection.functionalState}
      data-live-state={connection.liveVerificationState}
    >
      <div className="setup-connection-card-main">
        <span className="setup-connection-icon" aria-hidden="true">
          <Terminal />
        </span>
        <div className="setup-connection-copy">
          <div className="setup-connection-title">
            <div>
              <h3>{connection.label}</h3>
              <span className="setup-connection-provider">{connection.providerName}</span>
            </div>
            <div className="setup-connection-badges">
              <span className="setup-connection-status">
                <FunctionalStatusIcon connection={connection} checking={checking} />
                {functionalStatusLabel(connection)}
              </span>
              <span className="setup-connection-live-status">
                {liveStatusLabels[connection.liveVerificationState]}
              </span>
            </div>
          </div>
          <p>{reason}</p>

          {events.length ? (
            <div className="setup-connection-stage" aria-live="polite">
              <div>
                <span>Current stage</span>
                <strong>{latestEvent?.stage}</strong>
                <span>{completedSteps} steps completed</span>
              </div>
              <ol aria-label={`${connection.label} check stages`}>
                {events.map((event) => (
                  <li
                    key={event.sequence}
                    data-state={
                      event.state === "COMPLETED" ||
                      event.sequence < (latestEvent?.sequence ?? 0)
                        ? "COMPLETED"
                        : "RUNNING"
                    }
                  >
                    {event.stage}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      </div>

      <div className="setup-connection-actions">
        {canConnect ? (
          <button
            type="button"
            className="setup-connection-primary"
            disabled={checking}
            aria-label={`Connect ${connection.label}`}
            onClick={onConnect}
          >
            <Terminal aria-hidden="true" />
            Connect
          </button>
        ) : null}

        {canCheck ? (
          <button
            type="button"
            disabled={checking}
            aria-label={`Check live response for ${connection.label}`}
            onClick={onCheck}
          >
            <RefreshCw aria-hidden="true" />
            Check live response
          </button>
        ) : null}

        {canOpenMaintenance ? (
          <button type="button" onClick={onOpenMaintenance}>
            Open maintenance
          </button>
        ) : null}
      </div>
    </article>
  );
}
