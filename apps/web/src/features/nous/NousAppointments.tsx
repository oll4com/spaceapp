import { Fragment, useRef, useState, type CSSProperties, type HTMLAttributes } from "react";
import { appointmentOverdue, appointmentSections, type Appointment, type UiLanguage } from "@space/contracts";
import { api } from "../../api.js";
import { LinkedText } from "../appointments/AppointmentDetail.js";
import {
  APPOINTMENT_KIND_COLORS, APPOINTMENT_KIND_ICONS, APPOINTMENT_KIND_LABELS, appointmentCalendarDayLabel, appointmentClock, appointmentCountdown,
  appointmentDay, appointmentDayLabel, appointmentLink, appointmentRelativeDay, appointmentsByDay, appointmentWhen, useAppointments
} from "../appointments/appointments-view.js";
import { APPOINTMENT_FORMAT_LABELS, AppointmentBadges } from "../appointments/AppointmentBadges.js";
import { DockSearch } from "../dock-kit/DockKit.js";
import { dayLabel, monthDays, shiftDay, shiftMonth, weekDays } from "../task-dock/calendar-days.js";
import { CalendarDays, ChevronLeft, ChevronRight, Columns3, ExternalLink, List, Timer, type LucideIcon } from "../ui-theme/app-icons.js";
import { requestNousFocus } from "../nous-focus/nous-focus-events.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import { useNousUiState } from "./nous-ui-state.js";

/**
 * The fullscreen Nous view's Appointments card (operator 2/11 15:22 BKK), at the top of the right column above Live: every upcoming one with
 * its time in the operator's zone and a countdown, scrolling inside the card. A click on the heading opens the Appointments pane (a new one in
 * the room on screen when none is open). A row expands in place (operator 6/11, nous_msg:a62c7d82f1134b9ba383a76b): the whole notes, the join
 * link, the kind, the time in the operator's zone, and Completed/Cancel through the pane's own PATCH, without opening the pane.
 * List, Week and Month views with icons (operator 6/11 11:03 BKK, nous_msg:ea247fe8c70044c2b468edc8): the list by day, a Monday-first week
 * and a month calendar; a day opens its appointments below, each expanding to the same details.
 * Every word is chrome in the Interface language (operator 6/11 11:58 BKK, nous_msg:1affa0ad), never the Agent language.
 * A horizontal wheel or swipe on the week or month moves it back or on like the arrows (operator 6/11 12:44 BKK, nous_msg:e3776676).
 */
type View = "list" | "week" | "month";
const VIEWS: Array<{ id: View; label: string; icon: LucideIcon }> = [
  { id: "list", label: "List", icon: List }, { id: "week", label: "Week", icon: Columns3 }, { id: "month", label: "Month", icon: CalendarDays }
];
const isView = (value: unknown): value is View => value === "list" || value === "week" || value === "month";
const WEEK_CHIPS = 4;
// -1 back, 1 on, 0 when the move is short or mostly vertical (the page and the list below keep their vertical scroll).
const horizontalStep = (dx: number, dy: number) => (Math.abs(dx) >= 50 && Math.abs(dx) > 2 * Math.abs(dy) ? Math.sign(dx) : 0);
const kindStyle = (kind: Appointment["kind"]) => ({ "--appt-kind": APPOINTMENT_KIND_COLORS[kind] }) as CSSProperties;
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ");

/** Keyword search (operator 7/11 11:57 BKK, nous_msg:a36ca9d47a2f4a349f5fc378): every word, case- and accent-free, somewhere in the title, the
 * place or link, the notes (company, contacts, links), the source, or the kind and format names in English or the interface language. */
export function searchAppointments(items: Appointment[], query: string, language: UiLanguage): Appointment[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((item) => {
    const labels = [APPOINTMENT_KIND_LABELS[item.kind], ...(item.format ? [APPOINTMENT_FORMAT_LABELS[item.format].label] : [])];
    const text = fold([item.title, item.location, item.notes, item.sourceRef, ...labels, ...labels.map((label) => uiText(language, label))].join(" "));
    return words.every((word) => text.includes(word));
  });
}

export function NousAppointments() {
  const [view, setView] = useNousUiState<View>("appointments.view", "list", isView);
  const [byDeadline, setByDeadline] = useNousUiState<boolean>("appointments.byDeadline", false, (v): v is boolean => typeof v === "boolean");
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const locale = language === "el" ? "el-GR" : "en-GB";
  const kind = (item: Appointment) => t(APPOINTMENT_KIND_LABELS[item.kind]);
  const upcoming = useAppointments("upcoming");
  // The calendars also show what is done or cancelled; until that list arrives they show the upcoming ones.
  const every = useAppointments("all", view !== "list");
  const { list, error, now, settings, zone } = upcoming;
  const [failure, setFailure] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  // The day the week or month shows and the day opened under it; today until the operator moves.
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The last move's direction slides the new period in; a flick (its momentum included, until 250 ms without a wheel event) is one step.
  const [slide, setSlide] = useState(0);
  const flick = useRef({ sum: 0, at: -Infinity, done: false });
  const press = useRef<{ x: number; y: number } | null>(null);
  const today = appointmentDay(new Date(now).toISOString(), zone);
  const focus = cursor ?? today;
  const chosen = selected ?? today;
  const hoursZone = list?.timeZone ?? zone;
  const shortDay = (day: string) => appointmentCalendarDayLabel(day, settings, "short");

  async function mark(id: string, status: "DONE" | "CANCELLED") {
    setBusy(true);
    setFailure(null);
    try {
      await api.updateAppointment(id, { status });
      await Promise.all([upcoming.reload(), view === "list" ? null : every.reload()]);
    } catch (cause) {
      setFailure(cause instanceof Error && cause.message ? cause.message : t("That did not work."));
    } finally {
      setBusy(false);
    }
  }

  async function open() {
    setFailure(null);
    try {
      let pane = list?.pane ?? null;
      if (!pane) {
        const roomId = window.sessionStorage.getItem("space.selectedRoomId");
        if (!roomId) throw new Error(t("Open a room first."));
        const created = (await api.createRoomPanes(roomId, { panes: [{ mode: "APPOINTMENTS" }] })).data.at(-1);
        if (!created) throw new Error(t("The Appointments pane did not open."));
        pane = { roomId, paneId: created.id };
      }
      requestNousFocus({ ...pane, immediate: true });
    } catch (cause) {
      setFailure(cause instanceof Error && cause.message ? cause.message : t("The Appointments pane did not open."));
    }
  }

  const items = searchAppointments(list?.appointments ?? [], query, language);
  const count = items.filter((item) => item.status === "UPCOMING").length;

  const detail = (item: Appointment, link = appointmentLink(item)) => (
    <div id={`nous-appointment-${item.id}`} className="nous-appointments-detail">
      <p>
        {kind(item)}
        {" · "}{appointmentClock(item.startsAt, settings)}{item.endsAt ? `–${appointmentClock(item.endsAt, settings)}` : ""} ({zone})
      </p>
      {link ? <a className="appointments-join" href={link.href} target="_blank" rel="noreferrer noopener"><ExternalLink aria-hidden="true" />{t("Open {host}", { host: link.host })}</a> : null}
      {item.location ? <p><LinkedText text={item.location} /></p> : null}
      <dl>
        {appointmentSections(item.notes).map((section, index) => (
          <Fragment key={index}>
            {section.heading ? <dt>{section.heading}</dt> : null}
            <dd><LinkedText text={section.text} /></dd>
          </Fragment>
        ))}
      </dl>
      {item.status === "UPCOMING" ? (
        <div className="nous-appointments-actions">
          <button type="button" disabled={busy} onClick={() => void mark(item.id, "DONE")} aria-label={t("Mark {title} completed", { title: item.title })}>{t("Completed")}</button>
          <button type="button" disabled={busy} onClick={() => void mark(item.id, "CANCELLED")} aria-label={t("Cancel {title}", { title: item.title })}>{t("Cancel")}</button>
        </div>
      ) : null}
    </div>
  );

  const row = (item: Appointment) => {
    const Icon = APPOINTMENT_KIND_ICONS[item.kind];
    const expanded = openId === item.id;
    const when = appointmentWhen(item, byDeadline);
    return (
      <li key={item.id} className={`nous-appointments-item is-${item.status.toLowerCase()}${expanded ? " is-open" : ""}`} style={kindStyle(item.kind)}>
        <button type="button" onClick={() => setOpenId(expanded ? null : item.id)} aria-expanded={expanded} aria-controls={`nous-appointment-${item.id}`}
          aria-label={`${item.title}, ${appointmentDayLabel(when, settings)} ${appointmentClock(when, settings)}`}
          aria-describedby={`nous-appointment-meta-${item.id} nous-appointment-badges-${item.id}`}>
          <span className="nous-appointments-line">
            <span className="nous-appointments-when">{appointmentClock(when, settings)}</span>
            <span className="nous-appointments-title">{item.title}</span>
          </span>
          <span className="nous-appointments-meta" id={`nous-appointment-meta-${item.id}`}>
            <Icon aria-hidden="true" />{kind(item)} · {appointmentOverdue(item, now) ? <span className="nous-appointments-overdue">{t("Expired")}</span>
              : item.status === "UPCOMING" ? appointmentCountdown(when, now, language)
              : t(item.status === "DONE" ? "Completed" : "Cancelled")}
          </span>
          <span className="nous-appointments-badges" id={`nous-appointment-badges-${item.id}`}>
            <AppointmentBadges item={item} settings={settings} hoursZone={hoursZone} />
          </span>
        </button>
        {expanded ? detail(item) : null}
      </li>
    );
  };

  const dayHeading = (day: string) => {
    const relative = appointmentRelativeDay(day, today);
    return <h4>{relative ? <span className="nous-appointments-relative">{t(relative)}</span> : null}{relative ? " " : ""}{shortDay(day)}</h4>;
  };

  function select(day: string) {
    setSelected(day);
    setOpenId(null);
  }

  function renderList() {
    if (items.length === 0) return <p className="nous-muted">{t(query.trim() ? "No appointment matches." : "No upcoming appointments.")}</p>;
    return (
      <div className="nous-appointments-scroll">
        {[...appointmentsByDay(items, zone, byDeadline)].map(([day, dayItems]) => (
          <div key={day} role="group" aria-label={shortDay(day)} className="nous-appointments-day">
            {dayHeading(day)}
            <ul className="nous-appointments-list">{dayItems.map(row)}</ul>
          </div>
        ))}
      </div>
    );
  }

  function renderCalendar() {
    const days = appointmentsByDay(every.list ? searchAppointments(every.list.appointments, query, language) : items, zone, byDeadline);
    const month = focus.slice(0, 7);
    let period = view === "week" ? weekDays(focus) : monthDays(month);
    // A month shows only the weeks that hold its days (five, or six when it starts late in the week).
    if (view === "month") period = period.slice(0, Math.ceil((period.map((day) => day.startsWith(month)).lastIndexOf(true) + 1) / 7) * 7);
    const first = period[0]!, last = period[period.length - 1]!;
    const title = view === "week"
      ? `${dayLabel(first, { day: "numeric", month: "short" }, locale)} – ${dayLabel(last, { day: "numeric", month: "short", year: "numeric" }, locale)}`
      : dayLabel(`${month}-01`, { month: "long", year: "numeric" }, locale);
    const move = (by: number) => { setSlide(by); setCursor(view === "week" ? shiftDay(focus, 7 * by) : `${shiftMonth(month, by)}-01`); };
    const slid = slide > 0 ? " is-slide-next" : slide < 0 ? " is-slide-prev" : "";
    const gestures: HTMLAttributes<HTMLDivElement> = {
      onWheel: (event) => {
        const state = flick.current;
        if (event.timeStamp - state.at > 250) Object.assign(state, { sum: 0, done: false });
        state.at = event.timeStamp;
        if (state.done || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
        state.sum += event.deltaX;
        const by = horizontalStep(state.sum, 0);
        if (by) { state.done = true; move(by); }
      },
      onPointerDown: (event) => { press.current = { x: event.clientX, y: event.clientY }; },
      onPointerUp: (event) => {
        const from = press.current;
        press.current = null;
        const by = from ? horizontalStep(from.x - event.clientX, from.y - event.clientY) : 0;
        if (by) move(by);
      },
      onPointerCancel: () => { press.current = null; }
    };
    const dayCount = (day: string) => {
      const total = days.get(day)?.length ?? 0;
      return t(total === 1 ? "{day}: 1 appointment" : "{day}: {count} appointments", { day: appointmentCalendarDayLabel(day, settings, "long"), count: total });
    };
    const dayClass = (day: string) => `${day === today ? " is-today" : ""}${day === chosen ? " is-selected" : ""}`;
    const agenda = days.get(chosen) ?? [];
    return (
      <>
        <div className="nous-appointments-period">
          <button type="button" className="nous-appointments-icon" aria-label={t(view === "week" ? "Previous week" : "Previous month")} onClick={() => move(-1)}><ChevronLeft aria-hidden="true" /></button>
          <button type="button" className="nous-appointments-today" onClick={() => { setSlide(0); setCursor(null); setSelected(null); setOpenId(null); }}>{t("Today")}</button>
          <button type="button" className="nous-appointments-icon" aria-label={t(view === "week" ? "Next week" : "Next month")} onClick={() => move(1)}><ChevronRight aria-hidden="true" /></button>
          <h4 aria-live="polite">{title}</h4>
        </div>
        {view === "week" ? (
          <div key={first} {...gestures} className={`nous-appointments-week${slid}`}>
            {period.map((day) => {
              const dayItems = days.get(day) ?? [];
              return (
                <div key={day} role="group" aria-label={shortDay(day)} className={`nous-appointments-week-day${dayClass(day)}`}>
                  <button type="button" className="nous-appointments-date" aria-pressed={day === chosen} aria-label={dayCount(day)} onClick={() => select(day)}>
                    <small>{dayLabel(day, { weekday: "short" }, locale)}</small><strong>{Number(day.slice(8))}</strong>
                  </button>
                  {dayItems.slice(0, WEEK_CHIPS).map((item) => {
                    const when = appointmentWhen(item, byDeadline);
                    return (
                      <button type="button" key={item.id} className={`nous-appointments-chip is-${item.status.toLowerCase()}`} style={kindStyle(item.kind)}
                        onClick={() => { setSelected(day); setOpenId(item.id); }} title={`${appointmentClock(when, settings)} ${item.title}`}
                        aria-label={`${item.title}, ${shortDay(day)} ${appointmentClock(when, settings)}`}>
                        {appointmentClock(when, settings)}
                      </button>
                    );
                  })}
                  {dayItems.length > WEEK_CHIPS ? <span className="nous-appointments-more">+{dayItems.length - WEEK_CHIPS}</span> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div key={first} {...gestures} className={`nous-appointments-month${slid}`}>
            {period.slice(0, 7).map((day) => <span key={day} className="nous-appointments-weekday" aria-hidden="true">{dayLabel(day, { weekday: "narrow" }, locale)}</span>)}
            {period.map((day) => {
              const dayItems = days.get(day) ?? [];
              return (
                <button key={day} type="button" aria-pressed={day === chosen} aria-label={dayCount(day)} onClick={() => select(day)}
                  className={`nous-appointments-month-day${dayClass(day)}${day.startsWith(month) ? "" : " is-outside"}${dayItems.length ? " has-items" : ""}`}>
                  <span>{Number(day.slice(8))}</span>
                  <span className="nous-appointments-dots" aria-hidden="true">{dayItems.slice(0, 3).map((item) => <i key={item.id} className={`is-${item.status.toLowerCase()}`} style={kindStyle(item.kind)} />)}</span>
                </button>
              );
            })}
          </div>
        )}
        <div role="group" aria-label={t("Appointments on {day}", { day: shortDay(chosen) })} className="nous-appointments-day nous-appointments-agenda">
          {dayHeading(chosen)}
          {agenda.length ? <ul className="nous-appointments-list">{agenda.map(row)}</ul> : <p className="nous-muted">{t("Nothing on this day.")}</p>}
        </div>
      </>
    );
  }

  return (
    <section className={`nous-appointments is-${view}`} aria-label={t("Appointments")}>
      <header className="nous-appointments-head">
        <h3>
          <button type="button" className="nous-appointments-open" onClick={() => void open()} title={t("Open the Appointments pane")}>{t("Appointments")}</button>
          {count ? <span className="nous-board-count">{count}</span> : null}
        </h3>
        <div className="nous-appointments-views" role="group" aria-label={t("Appointments view")}>
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" aria-pressed={view === id} aria-label={t(label)} title={t(`${label} view`)}
              onClick={() => { setView(id); setOpenId(null); setSlide(0); }}>
              <Icon aria-hidden="true" />
            </button>
          ))}
          <button type="button" aria-pressed={byDeadline} aria-label={t("Show by final deadline")} title={t("Show by final deadline")}
            onClick={() => setByDeadline((current) => !current)}>
            <Timer aria-hidden="true" />
          </button>
        </div>
      </header>
      {/* A filled search takes Escape first, so the first press clears it instead of leaving fullscreen. */}
      <div className="nous-appointments-search" onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }}>
        <DockSearch value={query} onChange={setQuery} label={t("Search appointments")} name="appointments-search" />
      </div>
      {failure || error ? <p className="nous-muted" role="alert">{failure ?? error}</p> : null}
      {!list ? <p className="nous-muted">{t("Loading appointments…")}</p> : view === "list" ? renderList() : renderCalendar()}
    </section>
  );
}
