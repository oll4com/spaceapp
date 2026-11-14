import { useEffect, useState } from "react";
import { NOTIFICATION_SOURCES, NOTIFICATION_SOURCE_LABELS, defaultNotificationSettings, resolveNotificationSettings, type NotificationSettings, type NotificationSource } from "@space/contracts";
import { api } from "../../api.js";
import { DockNotice } from "../dock-kit/DockKit.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { desktopNotificationPermission, desktopNotificationsEnabled, nativeNotificationsAvailable, pushNotificationsEnabled, pushNotificationsSupported, setDesktopNotifications, setPushNotifications } from "./desktop-notifications.js";

/**
 * Settings → Notifications: the "Show notifications" kill switch (every pop-up), then the channels every
 * notification source uses (in-app, toast, sound, desktop, Telegram, push in the Android app) and per-source overrides.
 */
export function NotificationSettingsCard({ suppressNotifications, onSuppressNotificationsChange }: { suppressNotifications: boolean; onSuppressNotificationsChange(suppressed: boolean): void }) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [desktop, setDesktop] = useState(desktopNotificationsEnabled);
  const [permission, setPermission] = useState(desktopNotificationPermission);
  const [push, setPush] = useState(pushNotificationsEnabled);
  const [pushAvailable, setPushAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [leadText, setLeadText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The kill switch renders at once; the channels wait for the settings (or fall back to the defaults).
    Promise.resolve().then(() => api.userSettings()).then((user) => { if (!cancelled) setSettings(resolveNotificationSettings(user.notifications)); })
      .catch(() => { if (!cancelled) setSettings(defaultNotificationSettings); });
    return () => { cancelled = true; };
  }, []);

  function save(next: NotificationSettings) {
    const previous = settings;
    setSettings(next);
    setError(null);
    void api.updateUserSettings({ notifications: next }).catch((caught: unknown) => {
      setSettings(previous);
      setError(caught instanceof Error ? caught.message : "Notification settings could not be saved.");
    });
  }
  const channel = (key: keyof NotificationSettings["channels"], checked: boolean) => settings && save({ ...settings, channels: { ...settings.channels, [key]: checked } });
  const perSource = (source: NotificationSource, key: "inApp" | "desktop" | "telegram" | "push", checked: boolean) => settings
    && save({ ...settings, perSource: { ...settings.perSource, [source]: { ...settings.perSource[source], [key]: checked } } });
  const current = settings ?? defaultNotificationSettings;
  const quiet = (patch: Partial<NotificationSettings["quietHours"]>) => settings && save({ ...settings, quietHours: { ...settings.quietHours, ...patch } });
  const reminders = (patch: Partial<NotificationSettings["appointmentReminders"]>) => settings && save({ ...settings, appointmentReminders: { ...settings.appointmentReminders, ...patch } });
  const leads = current.appointmentReminders.leadMinutes;
  function saveLeads(text: string) {
    const parsed = parseLeadTimes(text);
    if (!parsed) return setError("Write lead times like 1d, 3h, 30m (up to 30 days each).");
    setLeadText(null);
    reminders({ leadMinutes: parsed });
  }

  return (
    <section className="agent-settings-card settings-flat-card suppress-notifications-settings-card" aria-label="Notification settings" aria-busy={!settings}>
      <SpaceToggle className="settings-flat-row settings-flat-toggle-row suppress-notifications-toggle" name="show-notifications" label="Show notifications"
        help="Turns every pop-up message and alert on or off for your account. Turn it off when you want no interruptions."
        detail={suppressNotifications ? "Pop-up messages and alerts are hidden for your account." : undefined}
        checked={!suppressNotifications} onChange={(show) => onSuppressNotificationsChange(!show)} />
      <SpaceToggle className="settings-flat-row settings-flat-toggle-row" name="notifications-in-app" label="In-app badges and Notification Center" help="Counts on the toolbar bell and rooms, and the records in the Notification Center."
        checked={current.channels.inApp} disabled={!settings} onChange={(checked) => channel("inApp", checked)} />
      <SpaceToggle className="settings-flat-row settings-flat-toggle-row" name="notifications-toast" label="Pop-up toasts" help="A short card in the corner while Space is in front."
        checked={current.channels.toast} disabled={!settings} onChange={(checked) => channel("toast", checked)} />
      <SpaceToggle className="settings-flat-row settings-flat-toggle-row" name="notifications-sound" label="Sound" help="A chime for notifications that need you (follows the Space volume)."
        checked={current.channels.sound} disabled={!settings} onChange={(checked) => channel("sound", checked)} />
      <SpaceToggle className="settings-flat-row settings-flat-toggle-row" name="notifications-desktop" label={nativeNotificationsAvailable() ? "System notifications on this device" : "Desktop notifications in this browser"}
        help="Shown while Space is in the background; a tap brings Space back. Turning it on may ask the browser or the system for permission."
        detail={permission === "unsupported" ? "This browser cannot show desktop notifications." : permission === "denied" ? "Blocked in the browser; allow notifications for this site to turn them on." : undefined}
        checked={desktop && current.channels.desktop} disabled={!settings || permission === "unsupported" || permission === "denied"}
        onChange={(checked) => { void setDesktopNotifications(checked).then((on) => { setDesktop(on); setPermission(desktopNotificationPermission()); channel("desktop", checked); }); }} />
      <SpaceToggle className="settings-flat-row settings-flat-toggle-row" name="notifications-telegram" label="Telegram" help="Notifications that need you also go to the paired Telegram bot (Settings → Telegram)."
        checked={current.channels.telegram} disabled={!settings} onChange={(checked) => channel("telegram", checked)} />
      {pushNotificationsSupported() ? (
        <SpaceToggle className="settings-flat-row settings-flat-toggle-row" name="notifications-push" label="Push notifications on this device"
          help="Notifications that need you arrive also while the app is closed; a tap opens them. Turning it on may ask the system for permission."
          detail={!pushAvailable ? "On, but this Space server has no push key yet: nothing is pushed until it has one." : undefined}
          checked={push} disabled={!settings}
          onChange={(checked) => {
            setError(null);
            void setPushNotifications(checked, api).then((state) => { setPush(state.on); setPushAvailable(state.available); })
              .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Push notifications could not be changed."));
          }} />
      ) : null}
      <SpaceToggle className="settings-flat-row settings-flat-toggle-row" name="notifications-quiet-hours" label="Quiet hours for hand requests"
        help="Between the times below, in your working time zone (Settings → Date & time zone; without one nothing is held), sign-ins, CAPTCHAs, handoffs and needs-you requests wait without alerts and come as one morning batch. Urgent ones still alert."
        checked={current.quietHours.enabled} disabled={!settings} onChange={(checked) => quiet({ enabled: checked })} />
      {current.quietHours.enabled ? (
        <div className="settings-flat-row notification-quiet-hours">
          <label>From <input type="time" name="quiet-hours-start" value={current.quietHours.start} disabled={!settings}
            onChange={(event) => { if (/^\d{2}:\d{2}$/.test(event.target.value)) quiet({ start: event.target.value }); }} /></label>
          <label>Until <input type="time" name="quiet-hours-end" value={current.quietHours.end} disabled={!settings}
            onChange={(event) => { if (/^\d{2}:\d{2}$/.test(event.target.value)) quiet({ end: event.target.value }); }} /></label>
        </div>
      ) : null}
      <SpaceToggle className="settings-flat-row settings-flat-toggle-row" name="notifications-appointments" label="Appointment reminders"
        detail={current.appointmentReminders.enabled
          ? `Before every appointment: ${leads.length ? leads.map(leadLabel).join(", ") : "no lead times set"}.`
          : undefined}
        help="Reminds you before every appointment at the lead times below. A reminder that falls in your quiet hours comes 5 minutes before they start, never dropped."
        checked={current.appointmentReminders.enabled} disabled={!settings} onChange={(checked) => reminders({ enabled: checked })} />
      {current.appointmentReminders.enabled ? (
        <div className="settings-flat-row notification-quiet-hours">
          <label>Remind me before <input name="appointment-reminder-leads" value={leadText ?? leads.map(leadLabel).join(", ")} disabled={!settings}
            onChange={(event) => setLeadText(event.target.value)} onBlur={(event) => { if (leadText !== null) saveLeads(event.target.value); }}
            onKeyDown={(event) => { if (event.key === "Enter") saveLeads(event.currentTarget.value); }} /></label>
        </div>
      ) : null}
      <details className="settings-flat-row notification-source-settings">
        <summary>Per source</summary>
        {NOTIFICATION_SOURCES.map((source) => (
          <div key={source} className="notification-source-row">
            <strong>{NOTIFICATION_SOURCE_LABELS[source]}</strong>
            <SpaceToggle compact label="In-app" help="This source's notifications in the bell, the rooms' counts and the Notification Center." checked={current.perSource[source]?.inApp ?? current.channels.inApp} disabled={!settings} onChange={(checked) => perSource(source, "inApp", checked)} />
            <SpaceToggle compact label="Desktop" help="This source's notifications as desktop or system notifications." checked={current.perSource[source]?.desktop ?? current.channels.desktop} disabled={!settings} onChange={(checked) => perSource(source, "desktop", checked)} />
            <SpaceToggle compact label="Telegram" help="This source's notifications that need you, also through the paired Telegram bot." checked={current.perSource[source]?.telegram ?? current.channels.telegram} disabled={!settings} onChange={(checked) => perSource(source, "telegram", checked)} />
            {pushNotificationsSupported() ? <SpaceToggle compact label="Push" help="This source's notifications that need you, also as push notifications while the app is closed." checked={current.perSource[source]?.push ?? current.channels.push} disabled={!settings} onChange={(checked) => perSource(source, "push", checked)} /> : null}
          </div>
        ))}
      </details>
      <div className="settings-flat-actions">
        <button type="button" className="settings-flat-button" disabled={!settings} onClick={() => {
          setMessage(null);
          void api.testNotification().then(() => setMessage("A test notification was raised; it follows the channels above.")).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "The test failed."));
        }}>Send a test notification</button>
        {message ? <small className="dock-muted-text" role="status">{message}</small> : null}
      </div>
      {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
    </section>
  );
}

/** "1d", "3h", "30m" for a lead time in minutes. */
export const leadLabel = (minutes: number) => (minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`);
/** "1d, 3h, 1h" (or bare minutes) as minutes, longest first; null when a part does not read or passes 30 days. An empty list is none. */
export function parseLeadTimes(text: string): number[] | null {
  const parts = text.split(/[,\s]+/).filter(Boolean);
  const minutes = parts.map((part) => {
    const match = /^(\d+)(d|h|m|min)?$/i.exec(part);
    return match ? Number(match[1]) * ({ d: 1440, h: 60 }[match[2]?.toLowerCase() as "d" | "h"] ?? 1) : Number.NaN;
  });
  return minutes.every((value) => Number.isInteger(value) && value >= 1 && value <= 43_200) ? [...new Set(minutes)].sort((a, b) => b - a) : null;
}
