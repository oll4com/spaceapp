import { useEffect, useState, type FormEvent } from "react";
import type { DotProfile, DotSchedule, DotScheduleRecurrence } from "@space/contracts";
import { api } from "../../api.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

type Translate = (text: string, vars?: Record<string, string | number>) => string;

const statusLabels: Record<DotSchedule["status"], string> = { PENDING_CONFIRMATION: "Needs your confirmation", ACTIVE: "Active", PAUSED: "Paused",
  COMPLETED: "Completed", CANCELLED: "Cancelled" };
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function defaultTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}
function localTime(iso: string | null, timeZone: string, t: Translate): string {
  if (!iso) return t("Not scheduled");
  try { return new Date(iso).toLocaleString("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" }); } catch { return iso; }
}
/** The wording of describeDotScheduleRecurrence (contracts), through the interface language. */
function recurrenceText(recurrence: DotScheduleRecurrence, zone: string, t: Translate): string {
  switch (recurrence.kind) {
    case "ONCE": return t("Once at {when} ({zone})", { when: new Date(recurrence.at).toLocaleString("en-GB", { timeZone: zone, dateStyle: "medium", timeStyle: "short" }), zone });
    case "DAILY": return t("Every day at {time} ({zone})", { time: recurrence.time, zone });
    case "WEEKLY": return t("Every {days} at {time} ({zone})", { days: recurrence.days.map((day) => t(weekdays[day]!)).join(", "), time: recurrence.time, zone });
    case "INTERVAL": return t("Every {interval}", { interval: recurrence.minutes >= 60 && recurrence.minutes % 60 === 0
      ? t("{count} h", { count: recurrence.minutes / 60 }) : t("{count} min", { count: recurrence.minutes }) });
  }
}

/** Reminders and recurring work for one Dot: list, confirm, pause and create. */
export function DotSchedules({ dot, sessionId, read = api.dotSchedules, create = api.createDotSchedule, control = api.controlDotSchedule }: {
  dot: DotProfile; sessionId: string | null;
  read?: typeof api.dotSchedules; create?: typeof api.createDotSchedule; control?: typeof api.controlDotSchedule;
}) {
  const language = useUiLanguage();
  const t: Translate = (text, vars) => uiText(language, text, vars);
  const [items, setItems] = useState<DotSchedule[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<DotScheduleRecurrence["kind"]>("DAILY");
  const [time, setTime] = useState("09:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [at, setAt] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [timeZone, setTimeZone] = useState(defaultTimeZone);
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => read(dot.dotId)).then((result) => {
      if (current && result.dotId === dot.dotId) setItems(result.items.filter((item) => item.dotId === dot.dotId));
    }).catch(() => { if (current) setItems(null); });
    return () => { current = false; };
  }, [dot.dotId, revision, read]);
  function recurrence(): DotScheduleRecurrence | null {
    if (kind === "ONCE") return at ? { kind, at: new Date(at).toISOString() } : null;
    if (kind === "INTERVAL") return { kind, minutes };
    if (kind === "WEEKLY") return days.length ? { kind, days: [...days].sort(), time } : null;
    return { kind, time };
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = recurrence();
    if (!sessionId || !value || !title.trim() || !prompt.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      await create(dot.dotId, { sessionId, title: title.trim(), prompt: prompt.trim(), recurrence: value, timeZone: timeZone.trim() });
      setFormOpen(false); setTitle(""); setPrompt(""); setRevision((current) => current + 1);
    } catch (err) { setError(err instanceof Error ? err.message : t("The schedule could not be created.")); }
    finally { setBusy(false); }
  }
  async function act(schedule: DotSchedule, action: "CONFIRM" | "PAUSE" | "RESUME" | "CANCEL") {
    setBusy(true); setError(null);
    try { await control(dot.dotId, schedule.scheduleId, action); setRevision((current) => current + 1); }
    catch (err) { setError(err instanceof Error ? err.message : t("The schedule could not change.")); }
    finally { setBusy(false); }
  }
  return <section className="dots-schedules" aria-label={t("{name}'s schedules", { name: dot.name })}>
    <div className="dots-schedules-head"><h4>{t("Schedules")}</h4>
      {sessionId ? <button type="button" aria-expanded={formOpen} onClick={() => setFormOpen((open) => !open)}>{formOpen ? t("Close") : t("New schedule")}</button> : null}
    </div>
    {formOpen ? <form className="dots-schedule-form" onSubmit={(event) => void submit(event)}>
      <label><span>{t("Title")}</span><input aria-label={t("Schedule title")} value={title} maxLength={160} onChange={(event) => setTitle(event.currentTarget.value)} /></label>
      <label><span>{t("What {name} should do", { name: dot.name })}</span><textarea aria-label={t("Schedule instructions")} rows={2} value={prompt} maxLength={4000}
        onChange={(event) => setPrompt(event.currentTarget.value)} /></label>
      <div className="dots-schedule-kinds" role="group" aria-label={t("Repeat")}>
        {(["ONCE", "DAILY", "WEEKLY", "INTERVAL"] as const).map((value) => <button key={value} type="button" aria-pressed={kind === value}
          onClick={() => setKind(value)}>{value === "ONCE" ? t("Once") : value === "DAILY" ? t("Daily") : value === "WEEKLY" ? t("Weekly") : t("Interval")}</button>)}
      </div>
      {kind === "ONCE" ? <label><span>{t("Date and time")}</span><input type="datetime-local" aria-label={t("Run at")} value={at} onChange={(event) => setAt(event.currentTarget.value)} /></label> : null}
      {kind === "DAILY" || kind === "WEEKLY" ? <label><span>{t("Time")}</span><input type="time" aria-label={t("Time of day")} value={time} onChange={(event) => setTime(event.currentTarget.value)} /></label> : null}
      {kind === "WEEKLY" ? <div className="dots-schedule-days" role="group" aria-label={t("Days")}>{weekdays.map((name, index) => <button key={name} type="button"
        aria-pressed={days.includes(index)} onClick={() => setDays((current) => current.includes(index) ? current.filter((day) => day !== index) : [...current, index])}>{t(name)}</button>)}</div> : null}
      {kind === "INTERVAL" ? <label><span>{t("Every (minutes)")}</span><input type="number" aria-label={t("Interval minutes")} min={15} max={10080} value={minutes}
        onChange={(event) => setMinutes(Number(event.currentTarget.value))} /></label> : null}
      <label><span>{t("Time zone")}</span><input aria-label={t("Time zone")} value={timeZone} maxLength={80} onChange={(event) => setTimeZone(event.currentTarget.value)} /></label>
      <button type="submit" disabled={busy || !title.trim() || !prompt.trim() || !recurrence()}>{busy ? t("Saving…") : t("Create schedule")}</button>
    </form> : null}
    {error ? <p role="alert">{error}</p> : null}
    {items === null ? <p>{t("Schedules unavailable.")}</p> : !items.length ? <p>{t("No schedules yet.")}</p> : <ul className="dots-records">{items.map((schedule) => <li key={schedule.scheduleId}>
      <strong>{schedule.title}</strong>
      <span>{t(statusLabels[schedule.status])} · {recurrenceText(schedule.recurrence, schedule.timeZone, t)}</span>
      {schedule.status === "ACTIVE" ? <span>{t("Next: {when}", { when: localTime(schedule.nextRunAt, schedule.timeZone, t) })}</span> : null}
      {schedule.lastOutcome ? <p>{schedule.lastOutcome}</p> : null}
      <p className="dots-schedule-prompt">{schedule.prompt}</p>
      <div className="dots-schedule-actions">
        {schedule.status === "PENDING_CONFIRMATION" ? <button type="button" disabled={busy} onClick={() => void act(schedule, "CONFIRM")}>{t("Confirm")}</button> : null}
        {schedule.status === "ACTIVE" ? <button type="button" disabled={busy} onClick={() => void act(schedule, "PAUSE")}>{t("Pause")}</button> : null}
        {schedule.status === "PAUSED" ? <button type="button" disabled={busy} onClick={() => void act(schedule, "RESUME")}>{t("Resume")}</button> : null}
        {["PENDING_CONFIRMATION", "ACTIVE", "PAUSED"].includes(schedule.status) ? <button type="button" disabled={busy} onClick={() => void act(schedule, "CANCEL")}>{t("Cancel")}</button> : null}
      </div>
    </li>)}</ul>}
  </section>;
}
