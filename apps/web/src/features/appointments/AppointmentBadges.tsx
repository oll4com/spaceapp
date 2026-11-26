import { appointmentOutOfHours, type Appointment, type AppointmentHours } from "@space/contracts";
import type { DateTimeSettings } from "../date-time-settings/date-time-settings.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import { appointmentClock, appointmentShortDay } from "./appointments-view.js";
import "./appointments.css";

export const APPOINTMENT_FORMAT_LABELS: Record<NonNullable<Appointment["format"]>, { icon: string; label: string }> = {
  AI_INTERVIEW: { icon: "🤖", label: "AI interview" }, RECORDED_VIDEO: { icon: "🎥", label: "Recorded video" },
  LIVE_HUMAN_VIDEO: { icon: "👤", label: "Live with a person" }, PHONE: { icon: "📞", label: "Phone" }, IN_PERSON: { icon: "🤝", label: "In person" },
  WEBINAR: { icon: "🖥️", label: "Webinar" }, TEST: { icon: "📝", label: "Test" }, OTHER: { icon: "📅", label: "Other" }
};

/**
 * Who or what is on the other side, whether the time is strict or any time until a deadline, and a time outside the operator's hours
 * (operator 6/11 10:15 BKK, nous_msg:ea6f0792). They are chrome, so they read the Interface language, never the Agent language (operator 6/11
 * 11:58 BKK, nous_msg:1affa0ad: Greek badges on his English interface). `hours`: the owner's Appointment hours the server checks (operator 17/11).
 */
export function AppointmentBadges({ item, settings, hours }: { item: Appointment; settings: DateTimeSettings; hours: AppointmentHours }) {
  const language = useUiLanguage();
  const format = item.format ? APPOINTMENT_FORMAT_LABELS[item.format] : null;
  const deadline = item.deadlineAt ? `${appointmentShortDay(item.deadlineAt, settings, language)} ${appointmentClock(item.deadlineAt, settings)}` : "";
  // A deadline is a cut-off, not a meeting, so its hour is no warning.
  const outside = appointmentOutOfHours(item, hours);
  return (
    <>
      {format ? <span className="appointments-badge"><span aria-hidden="true">{format.icon} </span>{uiText(language, format.label)}</span> : null}
      {/* A space between badges, so a screen reader reads them as separate words. */}
      {item.timing === "FIXED" ? <> <span className="appointments-badge"><span aria-hidden="true">⏰ </span>{uiText(language, "Strict time")}</span></> : null}
      {/* Short "until Sat 7/11 20:42" on screen (operator 6/11 11:02 BKK); a screen reader still hears "Flexible". */}
      {item.timing === "FLEXIBLE" ? <> <span className="appointments-badge is-flexible"><span aria-hidden="true">⏳ </span><span className="sr-only">{uiText(language, "Flexible")} </span>{uiText(language, "until {when}", { when: deadline })}</span></> : null}
      {outside ? <> <span className="appointments-badge is-warning"><span aria-hidden="true">⚠️ </span>{uiText(language, "Outside {from}–{to}", { from: hours.start, to: hours.end })}</span></> : null}
    </>
  );
}
