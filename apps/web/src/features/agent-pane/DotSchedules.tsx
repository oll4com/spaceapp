import { useEffect, useState, type FormEvent } from "react";
import { describeDotScheduleRecurrence, type DotProfile, type DotSchedule, type DotScheduleRecurrence } from "@space/contracts";
import { api } from "../../api.js";

const statusLabels: Record<DotSchedule["status"], string> = { PENDING_CONFIRMATION: "Needs your confirmation", ACTIVE: "Active", PAUSED: "Paused",
  COMPLETED: "Completed", CANCELLED: "Cancelled" };
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function defaultTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}
function localTime(iso: string | null, timeZone: string): string {
  if (!iso) return "Not scheduled";
  try { return new Date(iso).toLocaleString("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" }); } catch { return iso; }
}

/** Reminders and recurring work for one Dot: list, confirm, pause and create. */
export function DotSchedules({ dot, sessionId, read = api.dotSchedules, create = api.createDotSchedule, control = api.controlDotSchedule }: {
  dot: DotProfile; sessionId: string | null;
  read?: typeof api.dotSchedules; create?: typeof api.createDotSchedule; control?: typeof api.controlDotSchedule;
}) {
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
    } catch (err) { setError(err instanceof Error ? err.message : "The schedule could not be created."); }
    finally { setBusy(false); }
  }
  async function act(schedule: DotSchedule, action: "CONFIRM" | "PAUSE" | "RESUME" | "CANCEL") {
    setBusy(true); setError(null);
    try { await control(dot.dotId, schedule.scheduleId, action); setRevision((current) => current + 1); }
    catch (err) { setError(err instanceof Error ? err.message : "The schedule could not change."); }
    finally { setBusy(false); }
  }
  return <section className="dots-schedules" aria-label={`${dot.name}'s schedules`}>
    <div className="dots-schedules-head"><h4>Schedules</h4>
      {sessionId ? <button type="button" aria-expanded={formOpen} onClick={() => setFormOpen((open) => !open)}>{formOpen ? "Close" : "New schedule"}</button> : null}
    </div>
    {formOpen ? <form className="dots-schedule-form" onSubmit={(event) => void submit(event)}>
      <label><span>Title</span><input aria-label="Schedule title" value={title} maxLength={160} onChange={(event) => setTitle(event.currentTarget.value)} /></label>
      <label><span>What {dot.name} should do</span><textarea aria-label="Schedule instructions" rows={2} value={prompt} maxLength={4000}
        onChange={(event) => setPrompt(event.currentTarget.value)} /></label>
      <div className="dots-schedule-kinds" role="group" aria-label="Repeat">
        {(["ONCE", "DAILY", "WEEKLY", "INTERVAL"] as const).map((value) => <button key={value} type="button" aria-pressed={kind === value}
          onClick={() => setKind(value)}>{value === "ONCE" ? "Once" : value === "DAILY" ? "Daily" : value === "WEEKLY" ? "Weekly" : "Interval"}</button>)}
      </div>
      {kind === "ONCE" ? <label><span>Date and time</span><input type="datetime-local" aria-label="Run at" value={at} onChange={(event) => setAt(event.currentTarget.value)} /></label> : null}
      {kind === "DAILY" || kind === "WEEKLY" ? <label><span>Time</span><input type="time" aria-label="Time of day" value={time} onChange={(event) => setTime(event.currentTarget.value)} /></label> : null}
      {kind === "WEEKLY" ? <div className="dots-schedule-days" role="group" aria-label="Days">{weekdays.map((name, index) => <button key={name} type="button"
        aria-pressed={days.includes(index)} onClick={() => setDays((current) => current.includes(index) ? current.filter((day) => day !== index) : [...current, index])}>{name}</button>)}</div> : null}
      {kind === "INTERVAL" ? <label><span>Every (minutes)</span><input type="number" aria-label="Interval minutes" min={15} max={10080} value={minutes}
        onChange={(event) => setMinutes(Number(event.currentTarget.value))} /></label> : null}
      <label><span>Time zone</span><input aria-label="Time zone" value={timeZone} maxLength={80} onChange={(event) => setTimeZone(event.currentTarget.value)} /></label>
      <button type="submit" disabled={busy || !title.trim() || !prompt.trim() || !recurrence()}>{busy ? "Saving…" : "Create schedule"}</button>
    </form> : null}
    {error ? <p role="alert">{error}</p> : null}
    {items === null ? <p>Schedules unavailable.</p> : !items.length ? <p>No schedules yet.</p> : <ul className="dots-records">{items.map((schedule) => <li key={schedule.scheduleId}>
      <strong>{schedule.title}</strong>
      <span>{statusLabels[schedule.status]} · {describeDotScheduleRecurrence(schedule.recurrence, schedule.timeZone)}</span>
      {schedule.status === "ACTIVE" ? <span>Next: {localTime(schedule.nextRunAt, schedule.timeZone)}</span> : null}
      {schedule.lastOutcome ? <p>{schedule.lastOutcome}</p> : null}
      <p className="dots-schedule-prompt">{schedule.prompt}</p>
      <div className="dots-schedule-actions">
        {schedule.status === "PENDING_CONFIRMATION" ? <button type="button" disabled={busy} onClick={() => void act(schedule, "CONFIRM")}>Confirm</button> : null}
        {schedule.status === "ACTIVE" ? <button type="button" disabled={busy} onClick={() => void act(schedule, "PAUSE")}>Pause</button> : null}
        {schedule.status === "PAUSED" ? <button type="button" disabled={busy} onClick={() => void act(schedule, "RESUME")}>Resume</button> : null}
        {["PENDING_CONFIRMATION", "ACTIVE", "PAUSED"].includes(schedule.status) ? <button type="button" disabled={busy} onClick={() => void act(schedule, "CANCEL")}>Cancel</button> : null}
      </div>
    </li>)}</ul>}
  </section>;
}
