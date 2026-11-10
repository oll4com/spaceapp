import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultNotificationSettings, type Appointment, type AppointmentList, type Pane } from "@space/contracts";
import { AppointmentsPane } from "../src/features/appointments/AppointmentsPane.js";
import { APPOINTMENT_KIND_COLORS, appointmentCountdown, appointmentShortDay, zonedInputToIso } from "../src/features/appointments/appointments-view.js";
import { NotificationSettingsCard, parseLeadTimes } from "../src/features/notifications/NotificationSettingsCard.js";
import { NousAppointments, searchAppointments } from "../src/features/nous/NousAppointments.js";
import { applyServerDateTimeSettings, DATE_TIME_SETTINGS_STORAGE_KEY } from "../src/features/date-time-settings/date-time-settings.js";
import { NOUS_FOCUS_EVENT } from "../src/features/nous-focus/nous-focus-events.js";
import { announceAgentLanguage, announceUiLanguage } from "../src/features/ui-language/ui-language.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

// Appointments (operator 2/11 15:22 BKK): the pane (upcoming by day in his zone, past, add, cancel), Nous's fullscreen card and the
// reminder settings in Settings → Notifications.
const at = (iso: string, fields: Partial<Appointment> = {}): Appointment => ({ id: `appointment:${iso}`, ownerUserId: "user:operator", title: "IP Fabric Teams call", startsAt: iso, endsAt: null,
  timeZone: "Asia/Bangkok", kind: "CALL", location: "https://teams.microsoft.com/l/meetup-join/abc", notes: null, sourceRef: "task:5qjhOhB2wnvV", status: "UPCOMING",
  format: "LIVE_HUMAN_VIDEO", timing: "FIXED", deadlineAt: null, remindersSent: [], createdAt: "2026-11-02T08:00:00.000Z", updatedAt: "2026-11-02T08:00:00.000Z", ...fields });
const upcoming: AppointmentList = { timeZone: "Asia/Bangkok", pane: { roomId: "room:main0001", paneId: "pane:appt0001" }, appointments: [
  at("2026-11-02T15:05:00.000Z", { id: "appointment:turing", title: "Turing tests", kind: "DEADLINE", format: "TEST", timing: "FLEXIBLE", deadlineAt: "2026-11-02T15:05:00.000Z", location: null, sourceRef: "task:1roMnBz-yIz6", notes: "Complete the assessment before the deadline." }),
  at("2026-11-09T14:30:00.000Z", { endsAt: "2026-11-09T15:00:00.000Z", location: "https://teams.microsoft.com/meet/346?p=abc (Meeting ID 346 917, passcode 9JN2)", notes: "Bring your questions about the role.\nAllow a few minutes to check the meeting link and microphone." })
] };
const past: AppointmentList = { ...upcoming, appointments: [at("2026-10-30T03:00:00.000Z", { id: "appointment:old", title: "Old call", status: "DONE" })] };
// The calendar reads every one: 23:30 and 00:30 Bangkok are 16:30 and 17:30 UTC of the same UTC day, but two local days.
const all: AppointmentList = { ...upcoming, appointments: [...past.appointments, ...upcoming.appointments,
  at("2026-11-05T16:30:00.000Z", { id: "appointment:late", title: "Late call", kind: "INTERVIEW" }),
  at("2026-11-05T17:30:00.000Z", { id: "appointment:early", title: "Early call", kind: "WEBINAR" }),
  ...["01", "02", "03", "04"].map((hour) => at(`2026-11-12T${hour}:00:00.000Z`, { id: `appointment:busy${hour}`, title: `Busy ${hour}`, kind: "OTHER" }))] };

function serve() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/auth/csrf") return Response.json({ csrfToken: "csrf:a", headerName: "x-space-csrf-token" });
    if (url === "/api/appointments?when=upcoming") return Response.json(upcoming);
    if (url === "/api/appointments?when=past") return Response.json(past);
    if (url === "/api/appointments?when=all") return Response.json(all);
    if (url === "/api/appointments" && method === "POST") return Response.json(at("2026-11-04T05:00:00.000Z"), { status: 201 });
    if (url.startsWith("/api/appointments/") && method === "PATCH") return Response.json(at("2026-11-09T14:30:00.000Z", { status: "CANCELLED" }));
    if (url === "/api/user-settings") return Response.json({ notifications: undefined });
    return Response.json({});
  }));
  return calls;
}

beforeEach(() => { localStorage.setItem(DATE_TIME_SETTINGS_STORAGE_KEY, JSON.stringify({ timeZone: "Asia/Bangkok", timeFormat: "24h", dateFormat: "DD/MM/YYYY" })); installSpaceRuntime(liveRuntime); vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-02T08:30:00.000Z") }); });
afterEach(() => { cleanup(); window.localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reads times in the operator's zone and counts down to them", () => {
  expect(zonedInputToIso("2026-11-09T21:30", "Asia/Bangkok")).toBe("2026-11-09T14:30:00.000Z");
  expect(zonedInputToIso("2026-03-28T05:00", "Europe/Athens")).toBe("2026-03-28T03:00:00.000Z");
  expect(zonedInputToIso("2026-03-29T05:00", "Europe/Athens")).toBe("2026-03-29T02:00:00.000Z");
  expect(appointmentCountdown("2026-11-02T15:05:00.000Z", Date.parse("2026-11-02T08:30:00.000Z"))).toBe("in 6 h 35 min");
  expect(appointmentCountdown("2026-11-09T14:30:00.000Z", Date.parse("2026-11-02T08:30:00.000Z"))).toBe("in 7 d 6 h");
});

it("lists upcoming appointments by day with their link and source, shows past ones, adds one in his zone and cancels one", async () => {
  const calls = serve();
  render(<AppointmentsPane />);
  const monday = await screen.findByRole("region", { name: "Mon, 09/11/2026" });
  expect(within(monday).getByText("21:30–22:00")).toBeTruthy();
  expect(within(monday).getByText("IP Fabric Teams call")).toBeTruthy();
  // Stable 2/11: a Teams link with its meeting ID and passcode after it stays a link.
  expect(within(monday).getByRole("link", { name: "Join on teams.microsoft.com" }).getAttribute("href")).toBe("https://teams.microsoft.com/meet/346?p=abc");
  expect(within(monday).getByText(/\(Meeting ID 346 917, passcode 9JN2\)/)).toBeTruthy();
  expect(within(monday).getByText("From task:5qjhOhB2wnvV")).toBeTruthy();
  const today = screen.getByRole("region", { name: "Mon, 02/11/2026" });
  expect(within(today).getByText("22:05")).toBeTruthy();
  expect(within(today).getByText("in 6 h 35 min")).toBeTruthy();
  expect(screen.getByText("Asia/Bangkok").textContent).toBe("Times in Asia/Bangkok");

  fireEvent.click(screen.getByRole("button", { name: "Add appointment" }));
  const form = screen.getByRole("form", { name: "Add appointment" });
  fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "WIM Engineering quick chat" } });
  fireEvent.change(within(form).getByLabelText("Starts"), { target: { value: "2026-11-04T12:00" } });
  // The notes start with the sections the server requires (nous_msg:a6016259).
  const notesBox = within(form).getByLabelText("Notes") as HTMLTextAreaElement;
  expect(notesBox.value).toBe("WHAT IT IS: \nTIME: \nHOW TO JOIN: \nWHY IT MATTERS: \nWHAT YOU NEED: \nSOURCE: ");
  const filled = "WHAT IT IS: WIM quick chat\nHOW TO JOIN: Teams, no sign-in\nWHY IT MATTERS: stage 1\nWHAT YOU NEED: CV\nSOURCE: mail";
  fireEvent.change(notesBox, { target: { value: filled } });
  fireEvent.click(within(form).getByRole("button", { name: "Add" }));
  await waitFor(() => expect(calls.find((call) => call.method === "POST")?.body).toEqual({ title: "WIM Engineering quick chat", startsAt: "2026-11-04T05:00:00.000Z",
    endsAt: null, kind: "CALL", location: null, notes: filled, format: "LIVE_HUMAN_VIDEO", timing: "FIXED", deadlineAt: null }));

  fireEvent.click(screen.getByRole("button", { name: "Cancel IP Fabric Teams call" }));
  await waitFor(() => expect(calls.find((call) => call.method === "PATCH")).toMatchObject({ url: "/api/appointments/appointment%3A2026-11-09T14%3A30%3A00.000Z",
    body: { status: "CANCELLED" } }));

  // Operator 4/11: Completed marks it DONE through the same route (the server closes what it links to).
  fireEvent.click(screen.getByRole("button", { name: "Mark IP Fabric Teams call completed" }));
  await waitFor(() => expect(calls.filter((call) => call.method === "PATCH").at(-1)).toMatchObject({ url: "/api/appointments/appointment%3A2026-11-09T14%3A30%3A00.000Z",
    body: { status: "DONE" } }));

  fireEvent.click(screen.getByRole("button", { name: "Past" }));
  expect(await screen.findByText("Old call")).toBeTruthy();
  expect(screen.getByText("Completed").className).toBe("appointments-completed");
});

it("colours each kind, marks the next one and clamps long notes", async () => {
  serve();
  render(<AppointmentsPane />);
  const turing = (await screen.findByText("Turing tests")).closest("li")!;
  const call = screen.getByText("IP Fabric Teams call").closest("li")!;
  expect(turing.style.getPropertyValue("--appt-kind")).toBe(APPOINTMENT_KIND_COLORS.DEADLINE);
  expect(call.style.getPropertyValue("--appt-kind")).toBe(APPOINTMENT_KIND_COLORS.CALL);
  expect(new Set(Object.values(APPOINTMENT_KIND_COLORS)).size).toBe(5);
  expect(within(turing).getByText("Next up")).toBeTruthy();
  expect(within(call).queryByText("Next up")).toBeNull();
  expect(within(turing).getByText("Deadline")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Today Mon, 02/11/2026" })).toBeTruthy();
  expect(within(turing).getByText("Complete the assessment before the deadline.")).toBeTruthy();
  expect(within(turing).queryByRole("button", { name: "More" })).toBeNull();
  const more = within(call).getByRole("button", { name: "More" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(more);
  expect(within(call).getByRole("button", { name: "Less" }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(within(call).getByRole("button", { name: "Less" }));
  expect(within(call).getByRole("button", { name: "More" }).getAttribute("aria-expanded")).toBe("false");
});

it("shows a month in his zone, opens a day from a chip, moves between months and remembers the view for the pane", async () => {
  serve();
  const pane = { id: "pane:appt0001" } as Pane;
  const view = render(<AppointmentsPane pane={pane} />);
  await screen.findByText("Turing tests");
  fireEvent.click(screen.getByRole("button", { name: "Month" }));
  expect(await screen.findByRole("heading", { name: "11/2026" })).toBeTruthy();
  expect(screen.getAllByRole("group").filter((cell) => cell.classList.contains("appointments-month-day"))).toHaveLength(42);
  // 23:30 Bangkok stays on Thursday 5; 00:30 Bangkok, the same UTC day, is Friday 6.
  expect(within(screen.getByRole("group", { name: "Thu, 05/11/2026" })).getByRole("button", { name: "Late call, Thu, 05/11/2026 23:30" })).toBeTruthy();
  expect(within(screen.getByRole("group", { name: "Fri, 06/11/2026" })).getByRole("button", { name: "Early call, Fri, 06/11/2026 00:30" })).toBeTruthy();
  expect(within(screen.getByRole("group", { name: "Thu, 05/11/2026" })).queryByText("Early call")).toBeNull();
  expect(screen.getByRole("group", { name: "Mon, 02/11/2026" }).classList.contains("is-today")).toBe(true);
  expect(screen.getByRole("group", { name: "Mon, 26/10/2026" }).classList.contains("is-outside")).toBe(true);
  expect(within(screen.getByRole("group", { name: "Thu, 12/11/2026" })).getByText("+1 more")).toBeTruthy();
  // Today's appointments are open under the month until another day is chosen.
  expect(within(screen.getByRole("region", { name: "Appointments on Mon, 02/11/2026" })).getByText("Turing tests")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Late call, Thu, 05/11/2026 23:30" }));
  // A chip opens the appointment's whole record (nous_msg:a6016259); Back shows its day.
  fireEvent.click(within(screen.getByRole("article", { name: "Late call: details" })).getByRole("button", { name: "Back to appointments" }));
  expect(screen.queryByRole("article")).toBeNull();
  const day = screen.getByRole("region", { name: "Appointments on Thu, 05/11/2026" });
  expect(within(day).getByText("Late call")).toBeTruthy();
  expect(within(day).getByRole("button", { name: "Edit Late call" })).toBeTruthy();
  expect(within(day).getByRole("button", { name: "Cancel Late call" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next month" }));
  expect(screen.getByRole("heading", { name: "12/2026" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Today" }));
  expect(screen.getByRole("heading", { name: "11/2026" })).toBeTruthy();
  expect(window.localStorage.getItem("space.appointments.view:pane:appt0001")).toBe("month");
  view.unmount();
  render(<AppointmentsPane pane={pane} />);
  expect(await screen.findByRole("heading", { name: "11/2026" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Month" }).getAttribute("aria-pressed")).toBe("true");
});

it("shows a Monday-first week with each day's appointments by time and opens a day", async () => {
  serve();
  render(<AppointmentsPane />);
  await screen.findByText("Turing tests");
  fireEvent.click(screen.getByRole("button", { name: "Week" }));
  expect(await screen.findByRole("heading", { name: "02/11/2026 – 08/11/2026" })).toBeTruthy();
  const days = screen.getAllByRole("group").filter((cell) => cell.classList.contains("appointments-week-day"));
  expect(days.map((cell) => cell.getAttribute("aria-label"))).toEqual(["Mon, 02/11/2026", "Tue, 03/11/2026", "Wed, 04/11/2026", "Thu, 05/11/2026", "Fri, 06/11/2026", "Sat, 07/11/2026", "Sun, 08/11/2026"]);
  expect(within(days[0]!).getByRole("button", { name: "Turing tests, Mon, 02/11/2026 22:05" })).toBeTruthy();
  fireEvent.click(within(days[4]!).getByRole("button", { name: "Friday, 06/11/2026: 1 appointment" }));
  expect(within(screen.getByRole("region", { name: "Appointments on Fri, 06/11/2026" })).getByText("Early call")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next week" }));
  expect(screen.getByRole("heading", { name: "09/11/2026 – 15/11/2026" })).toBeTruthy();
  expect(within(screen.getByRole("group", { name: "Mon, 09/11/2026" })).getByRole("button", { name: "IP Fabric Teams call, Mon, 09/11/2026 21:30" })).toBeTruthy();
});

it("shows every upcoming appointment in Nous's fullscreen card and opens the Appointments pane on a click", async () => {
  serve();
  const focus = vi.fn();
  window.addEventListener(NOUS_FOCUS_EVENT, focus);
  render(<NousAppointments />);
  const card = screen.getByRole("region", { name: "Appointments" });
  const items = await within(card).findAllByRole("listitem");
  expect(items.map((item) => item.textContent)).toEqual([
    // Operator 6/11 (nous_msg:ea6f0792): its format, strict or flexible time, and a time outside 11:00-18:00 Bangkok (21:30) as text.
    "22:05Turing testsDeadline · in 6 h 35 min📝 Test ⏳ Flexible until Mon 2/11 22:05",
    "21:30IP Fabric Teams callCall · in 7 d 6 h👤 Live with a person ⏰ Strict time ⚠️ Outside 11:00–18:00"]);
  // Grouped by day (nous_msg:ea247fe8): the day heads the group once, today named as such.
  expect(within(card).getByRole("group", { name: "Mon, 02/11/2026" }).querySelector("h4")?.textContent).toBe("Today Mon, 02/11/2026");
  expect(within(within(card).getByRole("group", { name: "Mon, 09/11/2026" })).getAllByRole("listitem")).toHaveLength(1);
  expect(within(card).getByText("2", { selector: ".nous-board-count" })).toBeTruthy();
  fireEvent.click(within(card).getByRole("button", { name: "Appointments" }));
  expect((focus.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ roomId: "room:main0001", paneId: "pane:appt0001", immediate: true });
  window.removeEventListener(NOUS_FOCUS_EVENT, focus);
});

it("finds appointments by keywords, case- and accent-free, every word in any field, and Escape clears the search (operator 7/11, nous_msg:a36ca9d4)", async () => {
  const greek = at("2026-11-10T04:00:00.000Z", { id: "appointment:greek", title: "Συνέντευξη με τον Κώστα", kind: "INTERVIEW", format: "AI_INTERVIEW", notes: "SOURCE: Acme Ltd" });
  const items = [...upcoming.appointments, greek];
  const ids = (query: string, language: "en" | "el" = "en") => searchAppointments(items, query, language).map((item) => item.id);
  expect(ids("")).toHaveLength(3);
  expect(ids("ΣΥΝΕΝΤΕΥΞΗ κωστα")).toEqual(["appointment:greek"]);
  expect(ids("acme ai interview")).toEqual(["appointment:greek"]);
  expect(ids("teams microphone")).toEqual(["appointment:2026-11-09T14:30:00.000Z"]);
  expect(ids("deadline test")).toEqual(["appointment:turing"]);
  expect(ids("turing microphone")).toEqual([]);
  // Kind and format names also match in the interface language.
  expect(ids("συνεντευξη", "el")).toEqual(["appointment:greek"]);
  serve();
  render(<NousAppointments />);
  const card = screen.getByRole("region", { name: "Appointments" });
  await within(card).findAllByRole("listitem");
  const box = within(card).getByRole("searchbox", { name: "Search appointments" });
  fireEvent.change(box, { target: { value: "TURING" } });
  expect(within(card).getAllByRole("listitem").map((item) => item.textContent?.slice(0, 17))).toEqual(["22:05Turing tests"]);
  expect(within(card).getByText("1", { selector: ".nous-board-count" })).toBeTruthy();
  const leave = vi.fn();
  window.addEventListener("keydown", leave);
  fireEvent.keyDown(box, { key: "Escape" });
  window.removeEventListener("keydown", leave);
  expect(leave).not.toHaveBeenCalled();
  expect((box as HTMLInputElement).value).toBe("");
  expect(within(card).getAllByRole("listitem")).toHaveLength(2);
});

it("expands a row of Nous's card in place and marks it Completed there without opening the pane (operator 6/11)", async () => {
  const calls = serve();
  const focus = vi.fn();
  window.addEventListener(NOUS_FOCUS_EVENT, focus);
  render(<NousAppointments />);
  const row = await screen.findByRole("button", { name: "IP Fabric Teams call, Mon, 09/11/2026 21:30" });
  expect(row.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(row);
  expect(row.getAttribute("aria-expanded")).toBe("true");
  const detail = document.getElementById(row.getAttribute("aria-controls")!)!;
  expect(detail.textContent).toContain("Call · 21:30–22:00 (Asia/Bangkok)");
  expect(detail.textContent).toContain("Allow a few minutes to check the meeting link and microphone.");
  expect(within(detail).getByRole("link", { name: "https://teams.microsoft.com/meet/346?p=abc" }).getAttribute("href")).toBe("https://teams.microsoft.com/meet/346?p=abc");
  fireEvent.click(within(detail).getByRole("button", { name: "Mark IP Fabric Teams call completed" }));
  await waitFor(() => expect(calls.find((call) => call.method === "PATCH")).toMatchObject({ url: "/api/appointments/appointment%3A2026-11-09T14%3A30%3A00.000Z", body: { status: "DONE" } }));
  expect(focus).not.toHaveBeenCalled();
  window.removeEventListener(NOUS_FOCUS_EVENT, focus);
});

it("switches Nous's card to a week and a month calendar whose appointments open in place, and remembers the view (operator 6/11, nous_msg:ea247fe8)", async () => {
  const calls = serve();
  const first = render(<NousAppointments />);
  const card = () => screen.getByRole("region", { name: "Appointments" });
  await within(card()).findAllByRole("listitem");
  const views = within(card()).getByRole("group", { name: "Appointments view" });
  expect(within(views).getAllByRole("button").map((button) => [button.getAttribute("aria-label"), button.getAttribute("aria-pressed"), Boolean(button.querySelector("svg"))]))
    .toEqual([["List", "true", true], ["Week", "false", true], ["Month", "false", true], ["Show by final deadline", "false", true]]);

  // Week: Monday first in his zone; 00:30 Bangkok on Friday is Thursday 17:30 UTC; done ones show too (the "all" list).
  fireEvent.click(within(views).getByRole("button", { name: "Week" }));
  expect(await within(card()).findByRole("heading", { name: "2 Nov – 8 Nov 2026" })).toBeTruthy();
  await waitFor(() => expect(calls.some((call) => call.url === "/api/appointments?when=all")).toBe(true));
  const friday = await within(card()).findByRole("group", { name: "Fri, 06/11/2026" });
  const early = await within(friday).findByRole("button", { name: "Early call, Fri, 06/11/2026 00:30" });
  expect(within(card()).getByRole("group", { name: "Thu, 05/11/2026" }).textContent).toContain("23:30");
  fireEvent.click(early);
  const agenda = within(card()).getByRole("group", { name: "Appointments on Fri, 06/11/2026" });
  const row = within(agenda).getByRole("button", { name: "Early call, Fri, 06/11/2026 00:30" });
  expect(row.getAttribute("aria-expanded")).toBe("true");
  const detail = document.getElementById(row.getAttribute("aria-controls")!)!;
  expect(detail.textContent).toContain("Webinar · 00:30 (Asia/Bangkok)");
  fireEvent.click(within(detail).getByRole("button", { name: "Cancel Early call" }));
  await waitFor(() => expect(calls.find((call) => call.method === "PATCH")).toMatchObject({ url: "/api/appointments/appointment%3Aearly", body: { status: "CANCELLED" } }));
  fireEvent.click(within(card()).getByRole("button", { name: "Next week" }));
  expect(within(card()).getByRole("heading", { name: "9 Nov – 15 Nov 2026" })).toBeTruthy();
  expect(within(within(card()).getByRole("group", { name: "Thu, 12/11/2026" })).getAllByRole("button", { name: /^Busy/ })).toHaveLength(4);

  // Month: the weeks that hold November, a day's button names its count, a click lists that day; a done one has no actions.
  fireEvent.click(within(views).getByRole("button", { name: "Month" }));
  expect(within(card()).getByRole("heading", { name: "November 2026" })).toBeTruthy();
  const month = card().querySelector(".nous-appointments-month")!;
  // November 2026 starts on a Sunday: six weeks; December starts on a Tuesday: five.
  expect(month.querySelectorAll(".nous-appointments-month-day")).toHaveLength(42);
  fireEvent.click(within(card()).getByRole("button", { name: "Friday, 30/10/2026: 1 appointment" }));
  const old = within(within(card()).getByRole("group", { name: "Appointments on Fri, 30/10/2026" })).getByRole("button", { name: "Old call, Fri, 30/10/2026 10:00" });
  fireEvent.click(old);
  expect(within(document.getElementById(old.getAttribute("aria-controls")!)!).queryByRole("button", { name: "Mark Old call completed" })).toBeNull();
  expect(within(card()).getByRole("button", { name: "Thursday, 12/11/2026: 4 appointments" })).toBeTruthy();
  fireEvent.click(within(card()).getByRole("button", { name: "Next month" }));
  expect(within(card()).getByRole("heading", { name: "December 2026" })).toBeTruthy();
  expect(card().querySelectorAll(".nous-appointments-month-day")).toHaveLength(35);

  // The view survives a reload of the card.
  first.unmount();
  render(<NousAppointments />);
  expect(await within(card()).findByRole("heading", { name: "November 2026" })).toBeTruthy();
});

it("moves Nous's week and month with a horizontal wheel or swipe, one step per flick, and leaves vertical scroll alone (operator 6/11, nous_msg:e3776676)", async () => {
  serve();
  render(<NousAppointments />);
  const card = () => screen.getByRole("region", { name: "Appointments" });
  const heading = (name: string) => expect(card().querySelector(".nous-appointments-period h4")!.textContent).toBe(name);
  await within(card()).findAllByRole("listitem");
  const views = within(card()).getByRole("group", { name: "Appointments view" });
  fireEvent.click(within(views).getByRole("button", { name: "Week" }));
  await within(card()).findByRole("heading", { name: "2 Nov – 8 Nov 2026" });
  const grid = () => card().querySelector<HTMLElement>(".nous-appointments-week, .nous-appointments-month")!;

  // Mostly vertical: the page scrolls, the week stays. A flick's events add up to one step; its momentum moves nothing more.
  fireEvent.wheel(grid(), { deltaX: 40, deltaY: 120 });
  heading("2 Nov – 8 Nov 2026");
  fireEvent.wheel(grid(), { deltaX: 30 });
  fireEvent.wheel(grid(), { deltaX: 30 });
  heading("9 Nov – 15 Nov 2026");
  expect(grid().classList.contains("is-slide-next")).toBe(true);
  fireEvent.wheel(grid(), { deltaX: 200 });
  heading("9 Nov – 15 Nov 2026");
  // After a pause a new flick to the left goes back.
  vi.setSystemTime(Date.now() + 400);
  fireEvent.wheel(grid(), { deltaX: -80 });
  heading("2 Nov – 8 Nov 2026");
  expect(grid().classList.contains("is-slide-prev")).toBe(true);

  // A finger 80 px to the left is the next week; a short or slanted one is nothing.
  const swipe = (from: [number, number], to: [number, number]) => {
    fireEvent.pointerDown(grid(), { clientX: from[0], clientY: from[1] });
    fireEvent.pointerUp(grid(), { clientX: to[0], clientY: to[1] });
  };
  swipe([200, 50], [120, 60]);
  heading("9 Nov – 15 Nov 2026");
  swipe([200, 50], [170, 50]);
  swipe([200, 50], [120, 130]);
  heading("9 Nov – 15 Nov 2026");
  // Month: a swipe to the right is the month before; the arrows still work.
  fireEvent.click(within(views).getByRole("button", { name: "Month" }));
  heading("November 2026");
  swipe([100, 50], [200, 55]);
  heading("October 2026");
  fireEvent.click(within(card()).getByRole("button", { name: "Next month" }));
  heading("November 2026");
});

it("writes a chip's deadline as a short day in Bangkok, the interface language and the chosen date order (operator 6/11 11:02 BKK)", () => {
  const bangkok = { timeZone: "Asia/Bangkok", dateFormat: "DD/MM/YYYY", timeFormat: "24h" } as Parameters<typeof appointmentShortDay>[1];
  // 17:30 UTC Friday is already 00:30 Saturday in Bangkok; 16:59 UTC is still Friday.
  expect(appointmentShortDay("2026-11-06T17:30:00Z", bangkok, "en")).toBe("Sat 7/11");
  expect(appointmentShortDay("2026-11-06T16:59:00Z", bangkok, "en")).toBe("Fri 6/11");
  expect(appointmentShortDay("2026-11-06T17:30:00Z", bangkok, "el")).toBe("Σάβ 7/11");
  expect(appointmentShortDay("2026-11-06T17:30:00Z", { ...bangkok, dateFormat: "MM/DD/YYYY" }, "en")).toBe("Sat 11/7");
});

it("draws Nous's card and its badges in the Interface language, never the Agent language (operator 6/11, nous_msg:1affa0ad)", async () => {
  serve();
  // His settings: Interface language English, Agent language Greek.
  act(() => { announceUiLanguage("en"); announceAgentLanguage("el"); });
  try {
    render(<NousAppointments />);
    const card = screen.getByRole("region", { name: "Appointments" });
    const items = await within(card).findAllByRole("listitem");
    expect(items[1]!.textContent).toBe("21:30IP Fabric Teams callCall · in 7 d 6 h👤 Live with a person ⏰ Strict time ⚠️ Outside 11:00–18:00");
    expect(card.textContent).not.toMatch(/[\u0370-\u03ff]/);
    // The same card follows the Interface language when it changes, words and badges alike.
    act(() => announceUiLanguage("el"));
    const greek = await screen.findByRole("region", { name: "Ραντεβού" });
    expect(within(greek).getAllByRole("listitem")[1]!.textContent).toBe("21:30IP Fabric Teams callΚλήση · σε 7 ημ 6 ώ👤 Άνθρωπος live ⏰ Αυστηρή ώρα ⚠️ εκτός 11:00–18:00");
    expect(within(greek).getByRole("button", { name: "Εβδομάδα" })).toBeTruthy();
  } finally {
    act(() => { announceUiLanguage("en"); announceAgentLanguage("en"); });
  }
});

it("turns appointment reminders off and on and saves the lead times from Settings → Notifications", async () => {
  expect(parseLeadTimes("1d, 3h 60")).toEqual([1440, 180, 60]);
  expect(parseLeadTimes("2h, 2h, 30m")).toEqual([120, 30]);
  expect(parseLeadTimes("")).toEqual([]);
  expect(parseLeadTimes("31d")).toBeNull();
  expect(parseLeadTimes("soon")).toBeNull();
  const calls = serve();
  render(<NotificationSettingsCard suppressNotifications={false} onSuppressNotificationsChange={() => undefined} />);
  const toggle = await screen.findByRole("switch", { name: /Appointment reminders/ });
  await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
  expect(screen.getByText(/Before every appointment: 1d, 3h, 1h\./)).toBeTruthy();
  const leads = screen.getByLabelText("Remind me before") as HTMLInputElement;
  fireEvent.change(leads, { target: { value: "2d, 3h, 30m" } });
  fireEvent.keyDown(leads, { key: "Enter" });
  const saved = () => calls.filter((call) => call.url === "/api/user-settings" && call.method === "PATCH").map((call) => (call.body as { notifications: typeof defaultNotificationSettings }).notifications.appointmentReminders);
  await waitFor(() => expect(saved()).toEqual([{ enabled: true, leadMinutes: [2880, 180, 30] }]));
  fireEvent.change(leads, { target: { value: "later" } });
  fireEvent.keyDown(leads, { key: "Enter" });
  expect(screen.getByText("Write lead times like 1d, 3h, 30m (up to 30 days each).")).toBeTruthy();
  fireEvent.click(toggle);
  await waitFor(() => expect(saved().at(-1)).toEqual({ enabled: false, leadMinutes: [2880, 180, 30] }));
  expect(screen.queryByLabelText("Remind me before")).toBeNull();
});

it("uses date/time settings on both surfaces and regroups calendars immediately when they change", async () => {
  const calls = serve();
  applyServerDateTimeSettings({ timeZone: "America/New_York", timeFormat: "12h", dateFormat: "MM/DD/YYYY" });
  const pane = render(<AppointmentsPane />);
  const dock = render(<NousAppointments />);
  const list = within(pane.container);
  const nous = within(dock.container);
  expect(await list.findByText("09:30 AM–10:00 AM")).toBeTruthy();
  expect(await nous.findByRole("button", { name: "IP Fabric Teams call, Mon, 11/09/2026 09:30 AM" })).toBeTruthy();
  expect(list.getByRole("region", { name: "Mon, 11/09/2026" })).toBeTruthy();
  expect(list.getByText("America/New_York")).toBeTruthy();
  expect(nous.getByText("Call · in 7 d 6 h")).toBeTruthy();
  fireEvent.click(list.getByRole("button", { name: "Edit IP Fabric Teams call" }));
  expect((list.getByLabelText("Starts") as HTMLInputElement).value).toBe("2026-11-09T09:30");
  act(() => applyServerDateTimeSettings({ timeZone: "Asia/Bangkok", timeFormat: "24h", dateFormat: "YYYY-MM-DD" }));
  expect((list.getByLabelText("Starts") as HTMLInputElement).value).toBe("2026-11-09T21:30");
  fireEvent.click(list.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls.find(call => call.method === "PATCH")?.body).toMatchObject({
    startsAt: "2026-11-09T14:30:00.000Z", endsAt: "2026-11-09T15:00:00.000Z"
  }));
  act(() => applyServerDateTimeSettings({ timeZone: "America/New_York", timeFormat: "12h", dateFormat: "MM/DD/YYYY" }));
  fireEvent.click(list.getByRole("button", { name: "Week" }));
  expect(await list.findByRole("heading", { name: "11/02/2026 – 11/08/2026" })).toBeTruthy();
  const thursday = await list.findByRole("group", { name: "Thu, 11/05/2026" });
  expect(await within(thursday).findByRole("button", { name: "Early call, Thu, 11/05/2026 12:30 PM" })).toBeTruthy();
  expect(within(thursday).getByRole("button", { name: "Late call, Thu, 11/05/2026 11:30 AM" })).toBeTruthy();
  act(() => applyServerDateTimeSettings({ timeZone: "Asia/Bangkok", timeFormat: "24h", dateFormat: "YYYY-MM-DD" }));
  expect(nous.getByRole("button", { name: "IP Fabric Teams call, Mon, 2026-11-09 21:30" })).toBeTruthy();
  expect(list.getByRole("heading", { name: "2026-11-02 – 2026-11-08" })).toBeTruthy();
  expect(within(list.getByRole("group", { name: "Fri, 2026-11-06" })).getByRole("button", { name: "Early call, Fri, 2026-11-06 00:30" })).toBeTruthy();
  expect(within(list.getByRole("group", { name: "Thu, 2026-11-05" })).queryByText("Early call")).toBeNull();
  fireEvent.click(list.getByRole("button", { name: "Month" }));
  expect(list.getByRole("heading", { name: "2026-11" })).toBeTruthy();
  act(() => applyServerDateTimeSettings({ timeZone: "America/New_York", timeFormat: "12h", dateFormat: "MM/DD/YYYY" }));
  expect(list.getByRole("heading", { name: "11/2026" })).toBeTruthy();
  fireEvent.click(list.getByRole("button", { name: "Early call, Thu, 11/05/2026 12:30 PM" }));
  expect(within(list.getByRole("region", { name: "Appointments on Thu, 11/05/2026" })).getByText("12:30 PM")).toBeTruthy();
  // The device-zone option must never be passed to Intl as an IANA zone; date-only keys must not shift backwards.
  act(() => applyServerDateTimeSettings({ timeZone: "system", timeFormat: "24h", dateFormat: "DD/MM/YY" }));
  expect(list.getByRole("heading", { name: "11/26" })).toBeTruthy();
  expect(list.getByRole("group", { name: "Thu, 05/11/26" })).toBeTruthy();
  expect(list.getByText(Intl.DateTimeFormat().resolvedOptions().timeZone)).toBeTruthy();
});

it("opens an appointment's whole record from its row: every section, its links, the account and the mail it came from", async () => {
  // Operator 4/11 14:39 BKK (nous_msg:a60162597d984866b79b9a2f): the card showed one line; the record holds all he needs.
  const notes = ["ΤΙ ΕΙΝΑΙ: Προαιρετικό webinar του Future Health Challenge. ΔΕΝ είναι τεστ ούτε συνέντευξη.", "ΩΡΑ: Τετ 4/11 17:00 Μπανγκόκ (14:00 GST Ντουμπάι), μπες 5 λεπτά νωρίτερα.",
    "ΕΙΣΟΔΟΣ: https://hack2skill.com/event/futurehealthchallenge/dashboard/interactions\nΛογαριασμός: lab@example.invalid.", "ΓΙΑΤΙ ΑΞΙΖΕΙ: επαφή με γιατρό.",
    "ΤΙ ΧΡΕΙΑΖΕΣΑΙ: Υπολογιστή με ήχο. Προετοιμασία: artifact:E-frcK9DZ_Fv.", "ΠΗΓΗ: mail πρόσκλησης, thread 1a1a19a38e59d852."].join("\n\n");
  upcoming.appointments.push(at("2026-11-04T10:00:00.000Z", { id: "appointment:fh", title: "Future Health workshop", kind: "WEBINAR", timeZone: "Asia/Dubai",
    location: "https://hack2skill.com/event/futurehealthchallenge/dashboard/interactions", notes, sourceRef: "gmail:spaceappdv@gmail.com:1a1a19a38e59d852" }));
  try {
    serve();
    render(<AppointmentsPane />);
    fireEvent.click(await screen.findByRole("button", { name: "Future Health workshop: open details" }));
    const record = screen.getByRole("article", { name: "Future Health workshop: details" });
    expect(within(record).getByText(/17:00–?\s*\(Asia\/Bangkok\) · 14:00 Asia\/Dubai/)).toBeTruthy();
    expect([...record.querySelectorAll("dt")].map((item) => item.textContent)).toEqual(["ΤΙ ΕΙΝΑΙ", "ΩΡΑ", "ΕΙΣΟΔΟΣ", "ΓΙΑΤΙ ΑΞΙΖΕΙ", "ΤΙ ΧΡΕΙΑΖΕΣΑΙ", "ΠΗΓΗ"]);
    expect(within(record).getByText(/Λογαριασμός: lab@example.invalid/)).toBeTruthy();
    const links = within(record).getAllByRole("link", { name: "https://hack2skill.com/event/futurehealthchallenge/dashboard/interactions" });
    expect(links.length).toBeGreaterThan(1);
    expect(links.every((link) => link.getAttribute("target") === "_blank")).toBe(true);
    expect(within(record).getByRole("link", { name: "Open hack2skill.com" })).toBeTruthy();
    // The prep file opens in Agent Files.
    expect(within(record).getByRole("link", { name: "artifact:E-frcK9DZ_Fv" }).getAttribute("href")).toBe("/api/artifacts/artifact%3AE-frcK9DZ_Fv/download");
    expect(within(record).getByRole("link", { name: "Open the mail thread" }).getAttribute("href")).toBe("https://mail.google.com/mail/u/spaceappdv%40gmail.com/#all/1a1a19a38e59d852");
    fireEvent.click(within(record).getByRole("button", { name: "Edit Future Health workshop" }));
    expect(screen.queryByRole("article")).toBeNull();
    expect((within(screen.getByRole("form", { name: "Edit appointment" })).getByRole("textbox", { name: "Notes" }) as HTMLTextAreaElement).value).toBe(notes);
  } finally {
    upcoming.appointments.pop();
  }
});

it("keeps a FLEXIBLE appointment past its slot and a FIXED one past its start listed, the latter Expired (operator 7/11, nous_msg:cc777543e99e44e8bcba66db)", async () => {
  const list: AppointmentList = { ...upcoming, appointments: [
    at("2026-11-02T03:00:00.000Z", { id: "appointment:missed", title: "Missed call" }),
    at("2026-11-02T05:00:00.000Z", { id: "appointment:futuregrid", title: "FutureGrid", kind: "DEADLINE", format: "TEST", timing: "FLEXIBLE", endsAt: "2026-11-02T06:00:00.000Z", deadlineAt: "2026-11-13T10:00:00.000Z", location: null })] };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("/api/appointments") ? Response.json(list) : Response.json({})));
  render(<NousAppointments />);
  const card = screen.getByRole("region", { name: "Appointments" });
  const items = await within(card).findAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(items[0]!.textContent).toContain("Missed call");
  expect(items[0]!.querySelector(".nous-appointments-overdue")?.textContent).toBe("Expired");
  expect(items[1]!.textContent).toContain("FutureGrid");
  expect(items[1]!.querySelector(".nous-appointments-overdue")).toBeNull();
  expect(within(card).getByText("2", { selector: ".nous-board-count" })).toBeTruthy();
});

it("regroups and displays flexible appointments by their exact final deadline when toggled (nous_msg:cb2f63e4)", async () => {
  const flexible = at("2026-11-01T07:00:00.000Z", {
    id: "appointment:crossover",
    title: "Crossover interview",
    kind: "INTERVIEW",
    format: "AI_INTERVIEW",
    timing: "FLEXIBLE",
    startsAt: "2026-11-01T07:00:00.000Z",
    deadlineAt: "2026-11-13T02:32:00.000Z" // In Bangkok (UTC+7): Fri, 13/11/2026 09:32
  });
  const list: AppointmentList = { ...upcoming, appointments: [flexible] };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("/api/appointments") ? Response.json(list) : Response.json({})));

  const { unmount } = render(<NousAppointments />);
  const card = screen.getByRole("region", { name: "Appointments" });
  await within(card).findAllByRole("listitem");

  // Default: byDeadline is false; displays startsAt (14:00 Bangkok on Sun, 01/11/2026)
  expect(within(card).getByRole("group", { name: "Sun, 01/11/2026" })).toBeTruthy();
  expect(within(card).getByText("14:00")).toBeTruthy();
  expect(within(card).getByText(/ago/)).toBeTruthy();

  // Toggle "Show by final deadline"
  const toggle = within(card).getByRole("button", { name: "Show by final deadline" });
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-pressed")).toBe("true");

  // Regrouped: displays deadlineAt (09:32 Bangkok on Fri, 13/11/2026)
  expect(within(card).queryByRole("group", { name: "Sun, 01/11/2026" })).toBeNull();
  expect(within(card).getByRole("group", { name: "Fri, 13/11/2026" })).toBeTruthy();
  expect(within(card).getByText("09:32")).toBeTruthy();
  expect(within(card).getByText(/in 10 d/)).toBeTruthy();

  unmount();

  // In AppointmentsPane: shares state and also groups by deadlineAt
  render(<AppointmentsPane />);
  expect(await screen.findByRole("region", { name: "Fri, 13/11/2026" })).toBeTruthy();
  expect(screen.getByText("09:32")).toBeTruthy();
  expect(screen.getByText(/in 10 d/)).toBeTruthy();
  const paneToggle = screen.getByRole("button", { name: "Show by final deadline" });
  expect(paneToggle.getAttribute("aria-pressed")).toBe("true");

  // Toggle back to startsAt
  fireEvent.click(paneToggle);
  expect(paneToggle.getAttribute("aria-pressed")).toBe("false");
  expect(await screen.findByRole("region", { name: "Sun, 01/11/2026" })).toBeTruthy();
  expect(screen.getByText("14:00")).toBeTruthy();
});
