import { useEffect, useId, useState } from "react";
import { LINK_APP } from "@space/contracts";
import { api, type InstanceLink, type LiveDevices } from "../../api.js";
import { openSettingsSection } from "../settings/settings-section-request.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";

const time = (value: string) => new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Space Link's marks under Nous's status (ADR-014, operator 13/11): "Remote" while another SpaceApp's Nous is connected to this one,
 * "Managing N" while this one's Nous manages others. Hovering (or focusing) shows which Nous, from which address, since when, what it may
 * do, its last request and the round trip; a click opens Settings > Account, where Devices revokes a link and Linked SpaceApps removes one.
 * Take back holds every link at reading (and lets this Nous work on its own again) until Give back (lease.ts).
 * Nothing shows where neither answers (no link, or a USER account). Refreshed every 30 s while the dock is open, like the overview.
 * The same text is each button's accessible description (title alone reaches neither the keyboard nor a screen reader).
 */
export function NousRemoteMark({ active }: { active: boolean }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [live, setLive] = useState<LiveDevices>({ sessions: [], lease: null, takenBackAt: null });
  const [managed, setManaged] = useState<InstanceLink[]>([]);
  const id = useId();

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    // An older SpaceApp answers these routes without the lists: show nothing rather than break the dock.
    const load = () => {
      void api.liveDeviceSessions().then((result) => { if (!cancelled) setLive({ sessions: result.sessions ?? [], lease: result.lease ?? null, takenBackAt: result.takenBackAt ?? null }); }, () => undefined);
      void api.listInstanceLinks().then((result) => { if (!cancelled) setManaged(result.links ?? []); }, () => undefined);
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [active]);

  const remote = live.sessions.filter((session) => session.app === LINK_APP);
  if (!remote.length && !managed.length && !live.takenBackAt) return null;
  const manage = (action: "take-back" | "give-back") => void api.linkManagement(action).then(setLive, () => undefined);
  const remoteInfo = [t("Another SpaceApp's Nous is connected to this SpaceApp:"), ...remote.map((session) => [
    t("{name} from {ip}", { name: session.name, ip: session.ip }),
    t("Connected since {time}", { time: time(session.since) }),
    t("May {scopes}", { scopes: session.scopes.join(", ") }),
    ...(live.lease?.deviceId === session.deviceId ? [t("Manages this SpaceApp since {time}: this Nous's own turns wait", { time: time(live.lease.since) })] : []),
    session.last ? t("Last request {request} at {time}", { request: `${session.last.method} ${session.last.path}`, time: time(session.last.at) }) : t("No request yet"),
    ...(session.rttMs === null ? [] : [t("Round trip {ms} ms", { ms: session.rttMs })])
  ].join("\n")), t("Click to revoke it in Settings > Account > Devices.")].join("\n\n");
  const managedInfo = [t("This Nous manages these SpaceApps:"), ...managed.map((link) => t("{label} at {origin}: may {scopes}; {seen}", {
    label: link.label, origin: link.origins.join(", "), scopes: link.scopes.join(", "),
    seen: link.lastSeenAt ? t("last answered {time}", { time: time(link.lastSeenAt) }) : t("never connected yet") }))].join("\n");

  return (
    <p className="nous-remote-line">
      {remote.length ? <span id={`${id}-remote`} className="sr-only">{remoteInfo}</span> : null}
      {managed.length ? <span id={`${id}-managed`} className="sr-only">{managedInfo}</span> : null}
      {remote.length ? <button type="button" className="nous-remote-mark is-remote" title={remoteInfo} aria-describedby={`${id}-remote`} onClick={() => openSettingsSection("account")}>
        {remote.length > 1 ? t("Remote ({count})", { count: remote.length }) : t("Remote")}</button> : null}
      {managed.length ? <button type="button" className="nous-remote-mark" title={managedInfo} aria-describedby={`${id}-managed`} onClick={() => openSettingsSection("account")}>
        {t("Managing {count}", { count: managed.length })}</button> : null}
      {live.takenBackAt ? <button type="button" className="nous-remote-mark" title={t("You took management back at {time}: linked SpaceApps only read.", { time: time(live.takenBackAt) })}
        onClick={() => manage("give-back")}>{t("Give back")}</button>
        : remote.length ? <button type="button" className="nous-remote-mark" title={t("Hold every linked SpaceApp at reading and let this Nous work on its own again.")}
          onClick={() => manage("take-back")}>{t("Take back")}</button> : null}
    </p>
  );
}
