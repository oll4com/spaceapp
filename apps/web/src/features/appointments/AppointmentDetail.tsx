import { Fragment, useState, type ReactNode } from "react";
import { appointmentHoursOf, appointmentOverdue, appointmentSections, type Appointment, type AppointmentHours } from "@space/contracts";
import { api } from "../../api.js";
import type { DateTimeSettings } from "../date-time-settings/date-time-settings.js";
import { FileMentionText } from "../terminal-pane/AgentFileLinks.js";
import { ChevronLeft, ExternalLink } from "../ui-theme/app-icons.js";
import { AppointmentBadges } from "./AppointmentBadges.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import { APPOINTMENT_KIND_LABELS, appointmentCalendarDayLabel, appointmentClock, appointmentCountdown, appointmentDay, appointmentDayText, appointmentLink,
  appointmentAfterCall, appointmentNotesWithAfterCall, appointmentRecontact, appointmentRecurrenceLabel } from "./appointments-view.js";
import { AppointmentDateInput } from "./AppointmentDateInput.js";

/**
 * One appointment's whole record (operator 4/11 14:39 BKK, nous_msg:a60162597d984866b79b9a2f «να ανοίγω κάθε εγγραφή και να βλέπω όλα όσα θα
 * χρειαστώ»): when and in which zone it was booked, the join link, every section of its notes with their links, and the mail it came from.
 */
const WEB_ADDRESS = /https?:\/\/[^\s<>"«»]+[^\s<>"«»),.;:!?]/g;

/** Text with its web addresses as links that open in a new tab, and its Agent Files ids and paths opening their preview (the prep file). */
export function LinkedText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(WEB_ADDRESS)) {
    parts.push(<FileMentionText key={`t${at}`} text={text.slice(at, match.index)} />, <a key={match.index} href={match[0]} target="_blank" rel="noreferrer noopener">{match[0]}</a>);
    at = match.index + match[0].length;
  }
  parts.push(<FileMentionText key={`t${at}`} text={text.slice(at)} />);
  return <>{parts}</>;
}

/** `gmail:<account>:<threadId>` opens that thread in the account's Gmail. */
export function appointmentSourceHref(sourceRef: string | null): string | null {
  const mail = /^gmail:([^:\s]+@[^:\s]+):([0-9a-f]+)$/i.exec(sourceRef ?? "");
  return mail ? `https://mail.google.com/mail/u/${encodeURIComponent(mail[1]!)}/#all/${mail[2]}` : null;
}

/**
 * Post-call notes and a recontact date (operator 25/11 16:52 BKK, nous_msg:805b311060d04be19dd8ca26), on an upcoming or completed record: the notes
 * replace its «ΣΗΜΕΙΩΣΕΙΣ ΜΕΤΑ ΤΗΝ ΚΛΗΣΗ» section through the PATCH; Set recontact (operator 26/11, nous_msg:cfce1783) adds (or moves) a copy of
 * the whole record as a FLEXIBLE call that day, completes this one, links the two, and hands the new one to `onRecontact` to show.
 */
export function AppointmentFollowUp({ item, hours, settings, onChanged, onRecontact }: {
  item: Appointment; hours: AppointmentHours; settings: DateTimeSettings; onChanged(): unknown; onRecontact?(created: Appointment, message: string): void;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const saved = appointmentAfterCall(item.notes);
  const [notes, setNotes] = useState(saved);
  const [day, setDay] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  async function run(write: () => Promise<unknown>, done: string) {
    setBusy(true);
    setStatus(null);
    try {
      await write();
      setStatus(done);
      await onChanged();
    } catch (cause) {
      setStatus(cause instanceof Error && cause.message ? cause.message : t("That did not work."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="appointments-followup">
      <label>{t("Post-call notes")}<textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      <button type="button" disabled={busy || notes.trim() === saved}
        onClick={() => void run(() => api.updateAppointment(item.id, { notes: appointmentNotesWithAfterCall(item.notes, notes) }), t("Notes saved."))}>{t("Save notes")}</button>
      <AppointmentDateInput label={t("Recontact")} value={day} onChange={setDay} settings={settings} />
      <button type="button" disabled={busy || !day} onClick={() => void run(async () => {
        const { input, closed } = appointmentRecontact(item, day, hours, notes, settings);
        const created = await api.addAppointment(input);
        await api.updateAppointment(item.id, { status: "DONE", notes: closed(created) });
        onRecontact?.(created, t("Recontact set for {day}: «{title}» copied there, this one completed.", { day: appointmentDayText(day, settings.dateFormat), title: item.title }));
      }, t("Recontact set for {day}.", { day: appointmentDayText(day, settings.dateFormat) }))}>{t("Set recontact")}</button>
      {status ? <p role="status">{status}</p> : null}
    </div>
  );
}

export function AppointmentDetail({ item, settings, zone, hours = appointmentHoursOf(null, zone), now, onBack, onEdit, onChanged, onRecontact }: {
  item: Appointment; settings: DateTimeSettings; zone: string; hours?: AppointmentHours; now: number; onBack(): void; onEdit?(): void; onChanged?(): unknown;
  onRecontact?(created: Appointment, message: string): void;
}) {
  const link = appointmentLink(item);
  const source = appointmentSourceHref(item.sourceRef);
  const span = (at: DateTimeSettings) => `${appointmentClock(item.startsAt, at)}${item.endsAt ? `–${appointmentClock(item.endsAt, at)}` : ""}`;
  const booked = { ...settings, timeZone: item.timeZone };
  return (
    <article className="appointments-detail" aria-label={`${item.title}: details`}>
      <div className="appointments-detail-bar">
        <button type="button" onClick={onBack} aria-label="Back to appointments" autoFocus><ChevronLeft aria-hidden="true" />Back</button>
        {item.status === "UPCOMING" && onEdit ? <button type="button" onClick={onEdit} aria-label={`Edit ${item.title}`}>Edit</button> : null}
      </div>
      <p className="appointments-heading"><AppointmentBadges item={item} settings={settings} hours={hours} /></p>
      <h2>{item.title}</h2>
      <p className="appointments-detail-when">
        <span className="appointments-kind">{APPOINTMENT_KIND_LABELS[item.kind]}</span>{" "}
        {appointmentCalendarDayLabel(appointmentDay(item.startsAt, zone), settings, "long")} {span(settings)} ({zone})
        {item.timeZone !== zone ? <> · {span(booked)} {item.timeZone}</> : null}
        {item.recurrence ? <> · {appointmentRecurrenceLabel(item, settings)}</> : null}
        {" · "}{appointmentOverdue(item, now) ? <span className="appointments-overdue">Expired</span> : item.status === "UPCOMING" ? appointmentCountdown(item.startsAt, now) : item.status === "DONE" ? "Completed" : "Cancelled"}
      </p>
      {link ? (
        <p className="appointments-where">
          <a className="appointments-join" href={link.href} target="_blank" rel="noreferrer noopener"><ExternalLink aria-hidden="true" />Open {link.host}</a>
          {item.location ? <span className="appointments-meta"><LinkedText text={item.location} /></span> : null}
        </p>
      ) : item.location ? <p className="appointments-where">{item.location}</p> : null}
      <dl className="appointments-detail-sections">
        {appointmentSections(item.notes).map((section, index) => (
          <Fragment key={index}>
            {section.heading ? <dt>{section.heading}</dt> : null}
            <dd><LinkedText text={section.text} /></dd>
          </Fragment>
        ))}
      </dl>
      {onChanged && item.status !== "CANCELLED" ? <AppointmentFollowUp key={item.id} item={item} hours={hours} settings={settings} onChanged={onChanged} onRecontact={onRecontact} /> : null}
      {item.sourceRef ? (
        <p className="appointments-source">
          Source: {source ? <a href={source} target="_blank" rel="noreferrer noopener">Open the mail thread</a> : item.sourceRef}
        </p>
      ) : null}
    </article>
  );
}
