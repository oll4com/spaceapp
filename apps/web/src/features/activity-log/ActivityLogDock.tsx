import { useEffect, useState } from "react";
import type { ActivityLogEvent, ActivityLogSettings } from "@space/contracts";
import { History, RefreshCw, ShieldCheck } from "../ui-theme/app-icons.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { api } from "../../api.js";

interface ActivityLogDockProps {
  canManage: boolean;
}

function metadataString(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function ActivityLogDock({ canManage }: ActivityLogDockProps) {
  const [settings, setSettings] = useState<ActivityLogSettings | null>(null);
  const [events, setEvents] = useState<ActivityLogEvent[]>([]);
  const [pending, setPending] = useState(false);
  const [togglePending, setTogglePending] = useState(false);
  const [onlyWithReason, setOnlyWithReason] = useState(false);
  const [actorFilter, setActorFilter] = useState("");
  const [debouncedActorFilter, setDebouncedActorFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedActorFilter(actorFilter), 300);
    return () => window.clearTimeout(timer);
  }, [actorFilter]);

  async function loadLog() {
    setPending(true);
    setError(null);
    try {
      const [settingsPayload, eventsPayload] = await Promise.all([
        api.activityLogSettings(),
        api.activityLog({
          pageSize: 50,
          hasReason: onlyWithReason || undefined,
          actorUserId: debouncedActorFilter.trim() || undefined
        })
      ]);
      setSettings(settingsPayload);
      setEvents(eventsPayload.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Activity log load failed");
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    void loadLog();
  }, [onlyWithReason, debouncedActorFilter]);

  async function toggleLogEnabled() {
    if (!settings) return;
    setTogglePending(true);
    setError(null);
    try {
      const updated = await api.updateActivityLogSettings(!settings.enabled);
      setSettings(updated);
      if (!updated.enabled) setEvents([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Activity log settings update failed");
    } finally {
      setTogglePending(false);
    }
  }

  return (
    <div className="dock-panel event-dock">
      <h2>Activity Log</h2>
      <section className="event-source" aria-label="Activity log status">
        <div>
          <History aria-hidden="true" />
          <span>
            <strong>Room creation activity</strong>
            <small>Records room creation events with the actor and the optional reason.</small>
          </span>
        </div>
        <button
          className="compact-action"
          onClick={loadLog}
          disabled={pending}
          title="Refresh activity log"
          aria-label="Refresh activity log"
        >
          <RefreshCw aria-hidden="true" />
          <span>{pending ? "Loading" : "Refresh"}</span>
        </button>
      </section>

      {canManage ? (
        <section className="event-source" aria-label="Activity log capture settings">
          <div>
            <ShieldCheck aria-hidden="true" />
            <span>
              <strong>Capture room creation</strong>
              <small>When disabled, no activity entries are recorded at all.</small>
            </span>
          </div>
          <button
            className="compact-action"
            onClick={toggleLogEnabled}
            disabled={togglePending || settings === null}
            title={settings?.enabled ? "Disable activity log capture" : "Enable activity log capture"}
            aria-label={settings?.enabled ? "Disable activity log capture" : "Enable activity log capture"}
          >
            <span>{settings ? (settings.enabled ? "Enabled" : "Disabled") : "…"}</span>
          </button>
        </section>
      ) : null}

      <section className="activity-log-filter" aria-label="Activity log filters">
        <SpaceToggle
          className="activity-log-reason-toggle"
          label="Only events with a reason"
          checked={onlyWithReason}
          onChange={setOnlyWithReason}
        />
        <label>
          <span>Actor</span>
          <input
            className="activity-log-actor-input"
            type="text"
            value={actorFilter}
            onChange={(event) => setActorFilter(event.target.value)}
            maxLength={128}
            placeholder="user id or cli:…"
            aria-label="Filter by actor"
          />
        </label>
      </section>

      <section className="event-feed" aria-label="Activity log events">
        {events.length ? (
          events.map((event) => (
            <article key={event.id} className="event-entry">
              <div>
                <strong>{event.action}</strong>
                <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
              </div>
              <small>Room: {metadataString(event.metadata?.roomName ?? event.roomId ?? "unknown")}</small>
              {event.actorUserId ? <small>Actor: {event.actorUserId}</small> : <small>Actor: System</small>}
              {event.reason ? <small>Reason: {event.reason}</small> : null}
              <code className="raw-code" title={event.traceId}>
                {event.traceId}
              </code>
            </article>
          ))
        ) : (
          <div className="empty-mini" role="status">
            {settings && !settings.enabled
              ? "Activity log is disabled. An admin can enable capture above to start recording room creation events."
              : "No activity log events"}
          </div>
        )}
      </section>

      {error ? (
        <div className="validation-result bad" role="alert">
          <strong>ACTIVITY_LOG_ERROR</strong>
          <small>{error}</small>
        </div>
      ) : null}
    </div>
  );
}
