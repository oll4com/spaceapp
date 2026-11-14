import { Fragment, type ReactNode } from "react";
import { appointmentOverdue, appointmentSections, type Appointment } from "@space/contracts";
import type { DateTimeSettings } from "../date-time-settings/date-time-settings.js";
import { FileMentionText } from "../terminal-pane/AgentFileLinks.js";
import { ChevronLeft, ExternalLink } from "../ui-theme/app-icons.js";
import { AppointmentBadges } from "./AppointmentBadges.js";
import { APPOINTMENT_KIND_LABELS, appointmentCalendarDayLabel, appointmentClock, appointmentCountdown, appointmentDay, appointmentLink } from "./appointments-view.js";

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

export function AppointmentDetail({ item, settings, zone, hoursZone = zone, now, onBack, onEdit }: {
  item: Appointment; settings: DateTimeSettings; zone: string; hoursZone?: string; now: number; onBack(): void; onEdit?(): void;
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
      <p className="appointments-heading"><AppointmentBadges item={item} settings={settings} hoursZone={hoursZone} /></p>
      <h2>{item.title}</h2>
      <p className="appointments-detail-when">
        <span className="appointments-kind">{APPOINTMENT_KIND_LABELS[item.kind]}</span>{" "}
        {appointmentCalendarDayLabel(appointmentDay(item.startsAt, zone), settings, "long")} {span(settings)} ({zone})
        {item.timeZone !== zone ? <> · {span(booked)} {item.timeZone}</> : null}
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
      {item.sourceRef ? (
        <p className="appointments-source">
          Source: {source ? <a href={source} target="_blank" rel="noreferrer noopener">Open the mail thread</a> : item.sourceRef}
        </p>
      ) : null}
    </article>
  );
}
