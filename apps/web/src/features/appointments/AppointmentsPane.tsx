import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { APPOINTMENT_FORMATS, APPOINTMENT_KINDS, APPOINTMENT_TIMINGS, appointmentOverdue, type Appointment, type Pane } from "@space/contracts";
import { api } from "../../api.js";
import { dayLabel, monthDays, shiftDay, shiftMonth, weekDays } from "../task-dock/calendar-days.js";
import { CalendarClock, CalendarDays, ChevronLeft, ChevronRight, Columns3, ExternalLink, List, Plus, Timer, type LucideIcon } from "../ui-theme/app-icons.js";
import {
  APPOINTMENT_KIND_COLORS, APPOINTMENT_KIND_ICONS, APPOINTMENT_KIND_LABELS, appointmentClock, appointmentCountdown, appointmentDay,
  appointmentCalendarDayLabel, appointmentMonthLabel, appointmentLink, appointmentRelativeDay, appointmentsByDay, appointmentWhen,
  isoToZonedInput, useAppointments, zonedInputToIso
} from "./appointments-view.js";
import { AppointmentDetail } from "./AppointmentDetail.js";
import { APPOINTMENT_FORMAT_LABELS, AppointmentBadges } from "./AppointmentBadges.js";
import { AgentFileMentions, FileMentionText } from "../terminal-pane/AgentFileLinks.js";
import { useNousUiState } from "../nous/nous-ui-state.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import "./appointments.css";

/**
 * Appointments (operator 2/11 15:22 BKK): every call, interview, webinar and deadline of the operator in their working zone, as a list
 * (upcoming with a countdown, past on a toggle) or a Monday-first week or month calendar (operator 3/11 12:43 BKK); a day opens its
 * appointments with Completed, Edit and Cancel (Completed closes what the server links to it, appointments.ts). Space reminds them before each
 * (Settings → Notifications).
 */
type Draft = { zone: string; id?: string; title: string; starts: string; ends: string; kind: Appointment["kind"]; location: string; notes: string;
  format: NonNullable<Appointment["format"]>; timing: NonNullable<Appointment["timing"]>; deadline: string };
// The sections the server requires of an upcoming appointment (appointment-content.ts in contracts), to fill in.
const NOTES_TEMPLATE = "WHAT IT IS: \nTIME: \nHOW TO JOIN: \nWHY IT MATTERS: \nWHAT YOU NEED: \nSOURCE: ";
const blank = (zone: string): Draft => ({ zone, title: "", starts: "", ends: "", kind: "CALL", location: "", notes: NOTES_TEMPLATE,
  format: "LIVE_HUMAN_VIDEO", timing: "FIXED", deadline: "" });
type View = "list" | "week" | "month";
const VIEWS: Array<{ id: View; label: string; icon: LucideIcon }> = [
  { id: "list", label: "List", icon: List }, { id: "week", label: "Week", icon: Columns3 }, { id: "month", label: "Month", icon: CalendarDays }
];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const JOINS: ReadonlySet<Appointment["kind"]> = new Set(["CALL", "INTERVIEW", "WEBINAR"]);
const viewKey = (paneId?: string) => `space.appointments.view:${paneId ?? "default"}`;
function readView(paneId?: string): View {
  try {
    const stored = window.localStorage.getItem(viewKey(paneId));
    return stored === "week" || stored === "month" ? stored : "list";
  } catch {
    return "list";
  }
}
const kindStyle = (kind: Appointment["kind"]) => ({ "--appt-kind": APPOINTMENT_KIND_COLORS[kind] }) as CSSProperties;

function Notes({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 140 || text.includes("\n");
  return (
    <span className={`appointments-notes${long ? " is-collapsible" : ""}${open ? " is-open" : ""}`}>
      <span className="appointments-notes-text"><FileMentionText text={text} /></span>
      {long ? <button type="button" className="appointments-link-button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Less" : "More"}</button> : null}
    </span>
  );
}

export function AppointmentsPane({ pane }: { pane?: Pane }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [byDeadline, setByDeadline] = useNousUiState<boolean>("appointments.byDeadline", false, (v): v is boolean => typeof v === "boolean");
  const [view, setViewState] = useState<View>(() => readView(pane?.id));
  const [when, setWhen] = useState<"upcoming" | "past">("upcoming");
  const { list, error, reload, now, settings, zone } = useAppointments(view === "list" ? when : "all");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The day the week or month shows and the day opened under it; today until the operator moves.
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The appointment whose whole record is open over the list (nous_msg:a6016259); a click on its row or chip opens it.
  const [openId, setOpenId] = useState<string | null>(null);
  const opened = openId ? list?.appointments.find((item) => item.id === openId) : undefined;
  const shortDay = (day: string) => appointmentCalendarDayLabel(day, settings, "short");
  const today = appointmentDay(new Date(now).toISOString(), zone);
  const focus = cursor ?? today;
  const chosen = selected ?? today;
  const days = appointmentsByDay(list?.appointments ?? [], zone, byDeadline);
  const nextId = view === "list" && when === "upcoming" ? list?.appointments.find((item) => item.status === "UPCOMING" && !appointmentOverdue(item, now))?.id : undefined;

  // Preserve the instants of an open draft when settings change; never reinterpret its wall time in the new zone.
  useEffect(() => {
    setDraft((current) => {
      if (!current || current.zone === zone) return current;
      const convert = (value: string) => value ? isoToZonedInput(zonedInputToIso(value, current.zone), zone) : "";
      return { ...current, zone, starts: convert(current.starts), ends: convert(current.ends) };
    });
  }, [zone]);

  function setView(next: View) {
    setViewState(next);
    try { window.localStorage.setItem(viewKey(pane?.id), next); } catch { /* Preference storage is optional. */ }
  }

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setFailure(null);
    try {
      await run();
      await reload();
      return true;
    } catch (cause) {
      setFailure(cause instanceof Error && cause.message ? cause.message : "That did not work.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const fields = { title: draft.title.trim(), startsAt: zonedInputToIso(draft.starts, draft.zone), endsAt: draft.ends ? zonedInputToIso(draft.ends, draft.zone) : null,
      kind: draft.kind, location: draft.location.trim() || null, notes: draft.notes.trim() || null,
      format: draft.format, timing: draft.timing, deadlineAt: draft.timing === "FLEXIBLE" && draft.deadline ? zonedInputToIso(draft.deadline, draft.zone) : null };
    if (await act(() => (draft.id ? api.updateAppointment(draft.id, fields) : api.addAppointment(fields)))) setDraft(null);
  }

  const edit = (item: Appointment) => setDraft({ zone, id: item.id, title: item.title, starts: isoToZonedInput(item.startsAt, zone), ends: item.endsAt ? isoToZonedInput(item.endsAt, zone) : "",
    kind: item.kind, location: item.location ?? "", notes: item.notes ?? "",
    format: item.format ?? "LIVE_HUMAN_VIDEO", timing: item.timing ?? "FIXED", deadline: item.deadlineAt ? isoToZonedInput(item.deadlineAt, zone) : "" });

  function renderItem(item: Appointment) {
    const link = appointmentLink(item.location);
    const Icon = APPOINTMENT_KIND_ICONS[item.kind];
    const isNext = item.id === nextId;
    const when = appointmentWhen(item, byDeadline);
    return (
      <li key={item.id} className={`appointments-item is-${item.kind.toLowerCase()} is-${item.status.toLowerCase()}${isNext ? " is-next" : ""}`} style={kindStyle(item.kind)}
        onClick={(event) => { if (!(event.target as HTMLElement).closest("a, button")) setOpenId(item.id); }}>
        <span className="appointments-icon" aria-hidden="true"><Icon /></span>
        <span className="appointments-time">
          <strong>{appointmentClock(when, settings)}{item.endsAt ? <>–<wbr />{appointmentClock(item.endsAt, settings)}</> : null}</strong>
          {appointmentOverdue(item, now) ? <span className="appointments-overdue" title="Its time is over and it is not completed or cancelled">Expired</span>
            : item.status === "UPCOMING" ? <span className="appointments-countdown">{appointmentCountdown(when, now)}</span>
            : <span className={item.status === "DONE" ? "appointments-completed" : undefined}>{item.status === "DONE" ? "Completed" : "Cancelled"}</span>}
        </span>
        <span className="appointments-body">
          <span className="appointments-heading">
            {isNext ? <span className="appointments-next">Next up</span> : null}
            <span className="appointments-kind">{APPOINTMENT_KIND_LABELS[item.kind]}</span>
            <AppointmentBadges item={item} settings={settings} hoursZone={list?.timeZone ?? zone} />
          </span>
          <button type="button" className="appointments-title" onClick={() => setOpenId(item.id)} aria-label={`${item.title}: open details`}>{item.title}</button>
          {link ? (
            <span className="appointments-where">
              <a className="appointments-join" href={link.href} target="_blank" rel="noreferrer noopener" aria-label={`${JOINS.has(item.kind) ? "Join" : "Open"} on ${link.host}`}>
                <ExternalLink aria-hidden="true" />{JOINS.has(item.kind) ? "Join" : "Open"}
              </a>
              <span className="appointments-meta">{link.host}{link.rest ? ` ${link.rest}` : ""}</span>
            </span>
          ) : item.location ? <span className="appointments-where">{item.location}</span> : null}
          {item.notes ? <Notes text={item.notes} /> : null}
          {item.sourceRef ? <span className="appointments-source">From {item.sourceRef}</span> : null}
        </span>
        {item.status === "UPCOMING" ? (
          <span className="appointments-actions">
            <button type="button" onClick={() => void act(() => api.updateAppointment(item.id, { status: "DONE" }))} disabled={busy}
              aria-label={`Mark ${item.title} completed`}>Completed</button>
            <button type="button" onClick={() => edit(item)} disabled={busy} aria-label={`Edit ${item.title}`}>Edit</button>
            <button type="button" onClick={() => void act(() => api.updateAppointment(item.id, { status: "CANCELLED" }))} disabled={busy}
              aria-label={`Cancel ${item.title}`}>Cancel</button>
          </span>
        ) : item.status === "CANCELLED" ? (
          <span className="appointments-actions">
            <button type="button" onClick={() => void act(() => api.updateAppointment(item.id, { status: "UPCOMING" }))} disabled={busy}
              aria-label={`Restore ${item.title}`}>Restore</button>
          </span>
        ) : null}
      </li>
    );
  }

  const dayHeading = (day: string) => {
    const relative = appointmentRelativeDay(day, today);
    return <h3>{relative ? <span className="appointments-relative">{relative}</span> : null}{relative ? " " : ""}{shortDay(day)}</h3>;
  };

  const dayCount = (day: string) => {
    const count = days.get(day)?.length ?? 0;
    return `${appointmentCalendarDayLabel(day, settings, "long")}: ${count} appointment${count === 1 ? "" : "s"}`;
  };

  const chip = (item: Appointment, day: string) => {
    const when = appointmentWhen(item, byDeadline);
    return (
      <button type="button" key={item.id} className={`appointments-chip is-${item.status.toLowerCase()}`} style={kindStyle(item.kind)}
        onClick={() => { setSelected(day); setOpenId(item.id); }} title={`${appointmentClock(when, settings)} ${item.title}`}
        aria-label={`${item.title}, ${shortDay(day)} ${appointmentClock(when, settings)}`}>
        <b>{appointmentClock(when, settings)}</b> {item.title}
      </button>
    );
  };

  function renderCalendar() {
    const period = view === "week" ? weekDays(focus) : monthDays(focus.slice(0, 7));
    const first = period[0]!, last = period[period.length - 1]!;
    const title = view === "week"
      ? `${appointmentCalendarDayLabel(first, settings)} – ${appointmentCalendarDayLabel(last, settings)}`
      : appointmentMonthLabel(`${focus.slice(0, 7)}-01`, settings);
    const unit = view === "week" ? "week" : "month";
    const move = (by: number) => setCursor(view === "week" ? shiftDay(focus, 7 * by) : `${shiftMonth(focus.slice(0, 7), by)}-01`);
    const agenda = days.get(chosen) ?? [];
    return (
      <>
        <div className="appointments-period">
          <button type="button" className="appointments-icon-button" aria-label={`Previous ${unit}`} onClick={() => move(-1)}><ChevronLeft aria-hidden="true" /></button>
          <button type="button" onClick={() => { setCursor(null); setSelected(null); }}>Today</button>
          <button type="button" className="appointments-icon-button" aria-label={`Next ${unit}`} onClick={() => move(1)}><ChevronRight aria-hidden="true" /></button>
          <h2>{title}</h2>
        </div>
        {view === "week" ? (
          <div className="appointments-week">
            {period.map((day) => (
              <div key={day} role="group" aria-label={shortDay(day)}
                className={`appointments-week-day${day === today ? " is-today" : ""}${day === chosen ? " is-selected" : ""}`}>
                <button type="button" className="appointments-date" aria-pressed={day === chosen} aria-label={dayCount(day)} onClick={() => setSelected(day)}>
                  <small>{dayLabel(day, { weekday: "short" }, "en-GB")}</small><strong>{Number(day.slice(8))}</strong>
                </button>
                <span className="appointments-chips">{(days.get(day) ?? []).map((item) => chip(item, day))}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="appointments-month">
            {WEEKDAYS.map((name) => <span key={name} className="appointments-weekday" aria-hidden="true">{name}</span>)}
            {period.map((day) => {
              const items = days.get(day) ?? [];
              return (
                <div key={day} role="group" aria-label={shortDay(day)}
                  className={`appointments-month-day${day === today ? " is-today" : ""}${day === chosen ? " is-selected" : ""}${day.startsWith(focus.slice(0, 7)) ? "" : " is-outside"}`}>
                  <button type="button" className="appointments-date" aria-pressed={day === chosen}
                    aria-label={dayCount(day)}
                    onClick={() => setSelected(day)}><strong>{Number(day.slice(8))}</strong></button>
                  <span className="appointments-chips">
                    {items.slice(0, 3).map((item) => chip(item, day))}
                    {items.length > 3 ? <span className="appointments-more">+{items.length - 3} more</span> : null}
                  </span>
                  <span className="appointments-dots" aria-hidden="true">{items.slice(0, 4).map((item) => <i key={item.id} style={kindStyle(item.kind)} />)}</span>
                </div>
              );
            })}
          </div>
        )}
        <section className="appointments-day appointments-agenda" aria-label={`Appointments on ${shortDay(chosen)}`}>
          {dayHeading(chosen)}
          {agenda.length ? <ul>{agenda.map(renderItem)}</ul> : <p className="appointments-muted">Nothing on this day.</p>}
        </section>
      </>
    );
  }

  return (
    <AgentFileMentions>
    <section className="appointments-pane" aria-label="Appointments" data-pane-id={pane?.id}>
      <header className="appointments-toolbar">
        <div className="appointments-tabs" role="group" aria-label="View">
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)} aria-label={label} title={label}>
              <Icon aria-hidden="true" /><span>{label}</span>
            </button>
          ))}
        </div>
        {view === "list" ? (
          <div className="appointments-tabs" role="group" aria-label="Show">
            <button type="button" aria-pressed={when === "upcoming"} onClick={() => setWhen("upcoming")}>Upcoming</button>
            <button type="button" aria-pressed={when === "past"} onClick={() => setWhen("past")}>Past</button>
          </div>
        ) : null}
        <button type="button" className="appointments-icon-button" aria-pressed={byDeadline} aria-label={t("Show by final deadline")} title={t("Show by final deadline")} onClick={() => setByDeadline((current) => !current)}>
          <Timer aria-hidden="true" />
        </button>
        <span className="appointments-zone"><span className="appointments-zone-prefix">Times in </span>{zone}</span>
        <button type="button" className="appointments-primary" onClick={() => setDraft(blank(zone))} disabled={busy} aria-label="Add appointment">
          <Plus aria-hidden="true" /><span>Add appointment</span>
        </button>
      </header>
      {draft ? (
        <form className="appointments-form" onSubmit={(event) => void save(event)} aria-label={draft.id ? "Edit appointment" : "Add appointment"}>
          <label className="is-wide">Title<input required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <label>Starts<input type="datetime-local" required value={draft.starts} onChange={(event) => setDraft({ ...draft, starts: event.target.value })} /></label>
          <label>Ends (optional)<input type="datetime-local" value={draft.ends} onChange={(event) => setDraft({ ...draft, ends: event.target.value })} /></label>
          <label>Kind
            <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as Appointment["kind"] })}>
              {APPOINTMENT_KINDS.map((kind) => <option key={kind} value={kind}>{APPOINTMENT_KIND_LABELS[kind]}</option>)}
            </select>
          </label>
          <label>Format
            <select value={draft.format} onChange={(event) => setDraft({ ...draft, format: event.target.value as Draft["format"] })}>
              {APPOINTMENT_FORMATS.map((format) => <option key={format} value={format}>{APPOINTMENT_FORMAT_LABELS[format].label}</option>)}
            </select>
          </label>
          <label>Timing
            <select value={draft.timing} onChange={(event) => setDraft({ ...draft, timing: event.target.value as Draft["timing"] })}>
              {APPOINTMENT_TIMINGS.map((timing) => <option key={timing} value={timing}>{timing === "FIXED" ? "Strict time" : "Flexible until a deadline"}</option>)}
            </select>
          </label>
          {draft.timing === "FLEXIBLE" ? <label>Deadline<input type="datetime-local" required value={draft.deadline} onChange={(event) => setDraft({ ...draft, deadline: event.target.value })} /></label> : null}
          <label>Place or link<input value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} /></label>
          <label className="is-wide">Notes<textarea rows={7} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
          <div className="appointments-form-actions is-wide">
            <button type="submit" className="appointments-primary" disabled={busy}>{draft.id ? "Save" : "Add"}</button>
            <button type="button" onClick={() => setDraft(null)} disabled={busy}>Close</button>
          </div>
        </form>
      ) : null}
      {failure || error ? <p className="appointments-error" role="alert">{failure ?? error}</p> : null}
      {opened ? <AppointmentDetail item={opened} settings={settings} zone={zone} hoursZone={list?.timeZone ?? zone} now={now} onBack={() => setOpenId(null)} onEdit={() => { setOpenId(null); edit(opened); }} /> : null}
      <div className="appointments-list">
        {!list ? <p className="appointments-muted">Loading appointments…</p> : view !== "list" ? renderCalendar() : list.appointments.length === 0 ? (
          <div className="appointments-empty">
            <CalendarClock aria-hidden="true" />
            <p>{when === "upcoming" ? "No upcoming appointments." : "No past appointments in your history period."}</p>
            {when === "upcoming" ? <span className="appointments-muted">Calls, interviews, webinars and deadlines show here, and Space reminds you before each.</span> : null}
          </div>
        ) : [...days].map(([day, items]) => (
          <section key={day} className="appointments-day" aria-label={shortDay(day)}>
            {dayHeading(day)}
            <ul>{items.map(renderItem)}</ul>
          </section>
        ))}
      </div>
    </section>
    </AgentFileMentions>
  );
}
