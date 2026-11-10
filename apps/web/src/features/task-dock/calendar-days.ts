// Calendar day keys (YYYY-MM-DD, already in the shown zone) for the Task dock's month and the Appointments pane's week and month.
// Monday first, like Google Calendar outside the US and the Memory calendar.

export function shiftDay(day: string, by: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + by)).toISOString().slice(0, 10);
}
export function shiftMonth(month: string, by: number): string {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, monthNumber - 1 + by, 1)).toISOString().slice(0, 7);
}
const mondayLead = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
/** The 6 weeks the month view shows, Monday first. */
export function monthDays(month: string): string[] {
  const lead = mondayLead(`${month}-01`);
  return Array.from({ length: 42 }, (_, index) => shiftDay(`${month}-01`, index - lead));
}
/** The Monday-first week holding `day`. */
export function weekDays(day: string): string[] {
  const lead = mondayLead(day);
  return Array.from({ length: 7 }, (_, index) => shiftDay(day, index - lead));
}
/** A calendar day (YYYY-MM-DD) as words; the key is already in the shown zone, so it is read as UTC. */
export function dayLabel(day: string, options: Intl.DateTimeFormatOptions, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
}
