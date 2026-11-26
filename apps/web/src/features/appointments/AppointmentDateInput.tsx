import { useEffect, useId, useState } from "react";
import type { DateTimeSettings } from "../date-time-settings/date-time-settings.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import { appointmentDayFromText, appointmentDayText, appointmentTimeFromText, appointmentTimeText } from "./appointments-view.js";

/**
 * A date (and time) typed in the operator's Settings format (operator 26/11 11:08 BKK, nous_msg:cfce1783: the native picker showed the US
 * 01/31/2027), as labelled text fields with the pattern as their hint; `value` and `onChange` stay "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" ("" when unset).
 */
export function AppointmentDateInput({ label, value, onChange, settings, withTime = false, required = false }: {
  label: string; value: string; onChange(value: string): void; settings: DateTimeSettings; withTime?: boolean; required?: boolean;
}) {
  const language = useUiLanguage();
  const id = useId();
  const pattern = settings.dateFormat ?? "DD/MM/YYYY";
  const clock = settings.timeFormat === "12h" ? "h:mm AM/PM" : "HH:mm";
  const [day = "", time = ""] = value.split("T");
  const [dayText, setDayText] = useState(day ? appointmentDayText(day, pattern) : "");
  const [timeText, setTimeText] = useState(time ? appointmentTimeText(time, settings.timeFormat) : "");
  // A value set from outside (another zone, an edit) or a new Settings format shows again; what is being typed stays.
  useEffect(() => {
    if (value && value !== `${appointmentDayFromText(dayText, pattern) ?? ""}${withTime ? `T${appointmentTimeFromText(timeText) ?? ""}` : ""}`) {
      setDayText(day ? appointmentDayText(day, pattern) : "");
      setTimeText(time ? appointmentTimeText(time, settings.timeFormat) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only an outside change re-formats the fields.
  }, [value, pattern, settings.timeFormat]);
  const dayOk = !dayText.trim() || appointmentDayFromText(dayText, pattern) !== null;
  const timeOk = !timeText.trim() || appointmentTimeFromText(timeText) !== null;
  function update(nextDay: string, nextTime: string) {
    setDayText(nextDay);
    setTimeText(nextTime);
    const parsedDay = appointmentDayFromText(nextDay, pattern);
    const parsedTime = withTime ? appointmentTimeFromText(nextTime) : "";
    onChange(parsedDay && parsedTime !== null ? `${parsedDay}${withTime ? `T${parsedTime}` : ""}` : "");
  }
  // aria-label keeps the field's name to its label; the hint inside the label is its description.
  const invalid = (ok: boolean, hint: string) => ({
    "aria-invalid": !ok || undefined,
    ref: (input: HTMLInputElement | null) => input?.setCustomValidity(ok ? "" : uiText(language, "Use {pattern}.", { pattern: hint }))
  });
  return (
    <>
      <label>{label}
        <input aria-label={label} inputMode="numeric" autoComplete="off" required={required} placeholder={pattern} aria-describedby={`${id}-day`} value={dayText}
          onChange={(event) => update(event.target.value, timeText)} {...invalid(dayOk, pattern)} />
        <small id={`${id}-day`} className="appointments-input-hint">{dayOk ? pattern : uiText(language, "Use {pattern}.", { pattern })}</small>
      </label>
      {withTime ? (
        <label>{uiText(language, "{label} time", { label })}
          <input aria-label={uiText(language, "{label} time", { label })} autoComplete="off" required={required} placeholder={clock} aria-describedby={`${id}-time`} value={timeText}
            onChange={(event) => update(dayText, event.target.value)} {...invalid(timeOk, clock)} />
          <small id={`${id}-time`} className="appointments-input-hint">{timeOk ? clock : uiText(language, "Use {pattern}.", { pattern: clock })}</small>
        </label>
      ) : null}
    </>
  );
}
