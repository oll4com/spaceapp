import { describe, expect, it } from "vitest";
import { appointmentOverdue, defaultUserSettings, type Appointment, type UserSettings } from "@space/contracts";
import type { AppointmentsRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { appointmentReminderPlan, appointmentReminderText, appointmentsFor, writeAppointment } from "../src/appointments.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { closeInterviewTask, recordInterviewTask } from "../src/job-apply/interview-tasks.js";
import { NOUS_SUBAGENT_EXCLUDED } from "../src/nous/subagents.js";

// Appointments (operator 2/11 15:22 BKK): the list, its routes and the reminders 1 day, 3 h and 1 h before, shifted out of quiet hours.
const bangkok = { ...defaultUserSettings, dateTime: { ...defaultUserSettings.dateTime, timeZone: "Asia/Bangkok" } } as UserSettings;
const bkk = (local: string) => new Date(`${local}+07:00`).getTime();
// Every section an upcoming appointment needs (operator 4/11, nous_msg:a6016259), as the operator's records write them.
const NOTES = ["ΤΙ ΕΙΝΑΙ: Turing, 3 τεστ αξιολόγησης (όχι συνέντευξη).", "ΩΡΑ: 15:05 Μπανγκόκ.", "ΕΙΣΟΔΟΣ: https://work.turing.com/dashboard\nΛογαριασμός: work@example.invalid.",
  "ΓΙΑΤΙ ΑΞΙΖΕΙ: το επόμενο βήμα της αίτησης.", "ΤΙ ΧΡΕΙΑΖΕΣΑΙ: 90 λεπτά ησυχίας.", "ΠΗΓΗ: task:1roMnBz-yIz6."].join("\n\n");
// Its format and timing (operator 6/11, nous_msg:ea6f0792); a FIXED time is kept whatever the hour. An online one's location is its link (operator 13/11).
const FIXED = { format: "TEST", timing: "FIXED", location: "https://work.turing.com/dashboard" } as const;

describe("appointment reminders", () => {
  it("goes 1 day, 3 h and 1 h before, and moves a reminder in quiet hours to 22:55 before them", () => {
    // 21:30 BKK: every reminder is outside 23:00-09:00.
    expect(appointmentReminderPlan("2026-11-09T21:30:00+07:00", [1440, 180, 60], bangkok)).toEqual([
      { at: bkk("2026-11-08T21:30:00"), leads: [1440] }, { at: bkk("2026-11-09T18:30:00"), leads: [180] }, { at: bkk("2026-11-09T20:30:00"), leads: [60] }]);
    // 11:01 BKK: 3 h before is 08:01, inside quiet hours, so it goes at 22:55 the evening before.
    expect(appointmentReminderPlan("2026-11-03T11:01:00+07:00", [1440, 180, 60], bangkok)).toEqual([
      { at: bkk("2026-11-02T11:01:00"), leads: [1440] }, { at: bkk("2026-11-02T22:55:00"), leads: [180] }, { at: bkk("2026-11-03T10:01:00"), leads: [60] }]);
    // 09:15 BKK: 3 h and 1 h both fall in the night: one reminder at 22:55, never dropped.
    expect(appointmentReminderPlan("2026-11-05T09:15:00+07:00", [1440, 180, 60], bangkok)).toEqual([
      { at: bkk("2026-11-04T09:15:00"), leads: [1440] }, { at: bkk("2026-11-04T22:55:00"), leads: [180, 60] }]);
  });

  it("speaks the agent language", () => {
    const item = { id: "appointment:1", ownerUserId: "u", title: "IP Fabric call", startsAt: "2026-11-09T14:30:00.000Z", endsAt: null, timeZone: "Asia/Bangkok",
      kind: "CALL" as const, location: "https://teams.microsoft.com/l/x", notes: null, sourceRef: null, status: "UPCOMING" as const, format: null, timing: null, deadlineAt: null, remindersSent: [], createdAt: "", updatedAt: "" };
    const greek = appointmentReminderText(item, { ...bangkok, agentLanguage: "el" } as UserSettings, Date.parse(item.startsAt) - 3 * 3_600_000);
    expect(greek.title).toBe("Υπενθύμιση: IP Fabric call σε 3 ώρες");
    expect(greek.body).toContain("Κλήση");
    expect(greek.body).toContain("https://teams.microsoft.com/l/x");
    expect(appointmentReminderText(item, bangkok, Date.parse(item.startsAt) - 3_600_000).title).toBe("Reminder: IP Fabric call in 60 min");
  });
});

describe("appointments routes", () => {
  const sessionSecret = "appointments-route-secret";
  const session = signSession({ id: "user:appts", email: "appts@space.local", role: "ADMIN" }, sessionSecret);
  const headers = { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! };

  it("adds, lists upcoming and past, updates, cancels, upserts by source and reminds once per step", async () => {
    const store = new InMemorySpaceStore();
    const app = await createApp({ store, config: getApiConfig({}), auth: { sessionSecret, devLogin: false, secureCookies: false } });
    try {
      expect((await app.inject({ method: "PATCH", url: "/api/user-settings", headers, payload: { dateTime: { timeZone: "Asia/Bangkok" }, agentLanguage: "el" } })).statusCode).toBe(200);
      const soon = new Date(Date.now() + 50 * 60_000).toISOString();
      const created = await app.inject({ method: "POST", url: "/api/appointments", headers,
        payload: { title: "Turing tests", startsAt: soon, kind: "DEADLINE", sourceRef: "task:1roMnBz-yIz6", notes: NOTES, ...FIXED } });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ title: "Turing tests", kind: "DEADLINE", status: "UPCOMING", timeZone: "Asia/Bangkok", remindersSent: [] });
      // The same source again updates the one appointment.
      const again = await app.inject({ method: "POST", url: "/api/appointments", headers, payload: { title: "Turing tests (2)", startsAt: soon, kind: "DEADLINE", sourceRef: "task:1roMnBz-yIz6" } });
      expect(again.json().id).toBe(created.json().id);
      const past = await app.inject({ method: "POST", url: "/api/appointments", headers, payload: { title: "Old call", startsAt: new Date(Date.now() - 86_400_000).toISOString(), notes: NOTES, ...FIXED } });
      expect(past.json().kind).toBe("OTHER");
      expect((await app.inject({ method: "POST", url: "/api/appointments", headers, payload: { title: "No time" } })).statusCode).toBe(422);

      const upcoming = (await app.inject({ method: "GET", url: "/api/appointments", headers })).json();
      // A passed one nobody completed stays upcoming (overdue) until done or cancelled (operator 7/11, nous_msg:cc777543e99e44e8bcba66db).
      expect(upcoming).toMatchObject({ timeZone: "Asia/Bangkok", pane: null, appointments: [{ title: "Old call" }, { title: "Turing tests (2)" }] });
      expect(upcoming.appointments).toHaveLength(2);
      expect((await app.inject({ method: "GET", url: "/api/appointments?when=past", headers })).json().appointments).toEqual([]);
      await app.inject({ method: "PATCH", url: `/api/appointments/${encodeURIComponent(past.json().id)}`, headers, payload: { status: "DONE" } });
      expect((await app.inject({ method: "GET", url: "/api/appointments?when=past", headers })).json().appointments.map((a: { title: string }) => a.title)).toEqual(["Old call"]);

      // 50 minutes ahead: the 1 day and 3 h steps are due too; one reminder (the latest due), all three marked sent.
      const service = appointmentsFor(store)!;
      expect(await service.remind()).toBe(1);
      expect(await service.remind()).toBe(0);
      const notes = (await app.inject({ method: "GET", url: "/api/notifications", headers })).json();
      const reminder = (notes.notifications ?? notes.items ?? notes).find((note: { kind: string }) => note.kind === "APPOINTMENT_REMINDER");
      expect(reminder).toMatchObject({ source: "NOUS", severity: "ATTENTION", payload: { appointmentId: created.json().id, joinUrl: "https://work.turing.com/dashboard" } });
      expect(reminder.title).toMatch(/^Υπενθύμιση: Turing tests \(2\) σε \d+ λεπτά$/);
      expect((await service.repository.get(created.json().ownerUserId, created.json().id))!.remindersSent.sort((a, b) => a - b)).toEqual([60, 180, 1440]);

      // A new time is reminded again; cancelling ends it.
      const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const moved = await app.inject({ method: "PATCH", url: `/api/appointments/${encodeURIComponent(created.json().id)}`, headers, payload: { startsAt: later } });
      expect(moved.json()).toMatchObject({ kind: "DEADLINE", remindersSent: [] });
      const cancelled = await app.inject({ method: "PATCH", url: `/api/appointments/${encodeURIComponent(created.json().id)}`, headers, payload: { status: "CANCELLED" } });
      expect(cancelled.json().status).toBe("CANCELLED");
      expect((await app.inject({ method: "GET", url: "/api/appointments", headers })).json().appointments).toEqual([]);
      expect((await app.inject({ method: "PATCH", url: "/api/appointments/appointment:none", headers, payload: { title: "x" } })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("never writes an empty appointment from interview mail: the task asks an agent, later mail moves its time, done when the thread closes", async () => {
    expect(NOUS_SUBAGENT_EXCLUDED.has("space_appointment_add")).toBe(true);
    expect(NOUS_SUBAGENT_EXCLUDED.has("space_appointments")).toBe(false);
    const store = new InMemorySpaceStore();
    const app = await createApp({ store, config: getApiConfig({}), auth: { sessionSecret, devLogin: false, secureCookies: false } });
    try {
      const owner = (await store.upsertUser({ id: "user:appts", email: "appts@space.local", role: "ADMIN" })).id;
      await store.updateUserSettings(owner, { dateTime: { timeZone: "Asia/Bangkok" } });
      const service = appointmentsFor(store)!;
      const mail = { account: "me@gmail.com", threadId: "19a0wim", subject: "Quick chat with WIM Engineering", from: "McArthur <hr@wim.test>",
        text: "Your interview is scheduled for 12:00 PM GMT+7 on Wednesday, November 4, 2099.", sentAt: "2026-11-02T03:00:00.000Z", application: null };
      const task = await recordInterviewTask(store, owner, mail);
      // Operator 4/11 (nous_msg:a6016259): before, this wrote "Interview: Quick chat with WIM Engineering" with no notes.
      expect((await service.list(owner, "all")).appointments).toEqual([]);
      expect(task.objective).toContain("space_appointment_add, sourceRef this task's id, kind INTERVIEW, its format and timing");
      // The agent records it with every section; the subject-line title never replaces its own.
      await service.add(owner, { title: "WIM Engineering quick chat (McArthur)", startsAt: "2099-11-04T05:00:00.000Z", kind: "INTERVIEW", sourceRef: task.id, notes: NOTES, ...FIXED });
      await recordInterviewTask(store, owner, { ...mail, text: "Rescheduled: your interview is now at 1:00 PM GMT+7 on Wednesday, November 4, 2099." });
      expect((await service.list(owner, "all")).appointments).toEqual([expect.objectContaining({ title: "WIM Engineering quick chat (McArthur)",
        startsAt: "2099-11-04T06:00:00.000Z", notes: NOTES, sourceRef: task.id, status: "UPCOMING" })]);
      await closeInterviewTask(store, owner, mail.threadId);
      expect((await service.list(owner, "all")).appointments[0]!.status).toBe("DONE");
    } finally {
      await app.close();
    }
  });

  it("keeps a FLEXIBLE appointment past its slot and a FIXED one past its start listed until done or cancelled (operator 7/11, nous_msg:cc777543e99e44e8bcba66db)", async () => {
    const store = new InMemorySpaceStore();
    const app = await createApp({ store, config: getApiConfig({}), auth: { sessionSecret, devLogin: false, secureCookies: false } });
    try {
      const service = appointmentsFor(store)!;
      const owner = "user:appts";
      const hour = 3_600_000;
      const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
      // Its chosen slot, 12:00-13:00 Bangkok yesterday (within the 11:00-18:00 rule), is over; its deadline is in 6 days.
      const yesterday = new Date(Date.now() + 7 * hour - 24 * hour).toISOString().slice(0, 10);
      await service.repository.create(owner, { title: "FutureGrid", startsAt: new Date(bkk(`${yesterday}T12:00:00`)).toISOString(), endsAt: new Date(bkk(`${yesterday}T13:00:00`)).toISOString(),
        notes: NOTES, format: "RECORDED_VIDEO", timing: "FLEXIBLE", deadlineAt: iso(6 * 24 * hour), timeZone: "Asia/Bangkok", location: "https://futuregrid.test/r" });
      await service.repository.create(owner, { title: "Missed call", startsAt: iso(-2 * hour), notes: NOTES, ...FIXED, timeZone: "Asia/Bangkok" });
      const listed = (await app.inject({ method: "GET", url: "/api/appointments", headers })).json().appointments as Appointment[];
      expect(listed.map((a) => a.title)).toEqual(["FutureGrid", "Missed call"]);
      expect(listed.map((a) => appointmentOverdue(a))).toEqual([false, true]);
      expect((await app.inject({ method: "GET", url: "/api/appointments?when=past", headers })).json().appointments).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("adds a past appointment already DONE (5/11: a timeline from mail was refused 3 times)", async () => {
    const store = new InMemorySpaceStore();
    const app = await createApp({ store, config: getApiConfig({}), auth: { sessionSecret, devLogin: false, secureCookies: false } });
    try {
      const owner = (await store.upsertUser({ id: "user:appts", email: "appts@space.local", role: "ADMIN" })).id;
      const done = await writeAppointment(appointmentsFor(store)!, owner, { title: "Agoda recruiter screening", startsAt: "2026-08-20T10:00:00.000Z", kind: "INTERVIEW", notes: NOTES, ...FIXED, status: "DONE" });
      expect(done).toMatchObject({ title: "Agoda recruiter screening", status: "DONE" });
    } finally {
      await app.close();
    }
  });

  it("refuses an upcoming appointment without every section, naming each missing one; done, cancelled and older rows stay readable", async () => {
    const store = new InMemorySpaceStore();
    const app = await createApp({ store, config: getApiConfig({}), auth: { sessionSecret, devLogin: false, secureCookies: false } });
    try {
      const at = new Date(Date.now() + 86_400_000).toISOString();
      const bare = await app.inject({ method: "POST", url: "/api/appointments", headers, payload: { title: "Webinar", startsAt: at, kind: "WEBINAR", notes: "Optional webinar.", ...FIXED } });
      expect(bare.statusCode).toBe(409);
      expect(bare.json().error.message).toContain("its notes miss: WHAT IT IS (company and role, or the event, and its type); HOW TO JOIN (the link or exact place); "
        + "WHY IT MATTERS; WHAT YOU NEED (what to prepare or bring); SOURCE (the mail thread or task).");
      const noAccount = NOTES.replace("\nΛογαριασμός: work@example.invalid.", "");
      expect((await app.inject({ method: "POST", url: "/api/appointments", headers, payload: { title: "Webinar", startsAt: at, notes: noAccount, ...FIXED } })).json().error.message)
        .toContain("its notes miss: the account HOW TO JOIN signs in with (or \"no sign-in\").");
      // English headings and "no sign-in" are as good.
      const english = "What it is: Future Health webinar, not a test.\nHow to join: https://hack2skill.com, no sign-in.\nWhy it matters: a clinician contact.\nWhat you need: audio.\nSource: gmail thread 1a1a19a38e59d852.";
      const created = await app.inject({ method: "POST", url: "/api/appointments", headers, payload: { title: "Webinar", startsAt: at, notes: english, sourceRef: "gmail:me:1a1a", ...FIXED } });
      expect(created.statusCode).toBe(201);
      const id = encodeURIComponent(created.json().id);
      // An update is checked as it would be stored: dropping the notes, or a re-add by source without them for a new source, is refused.
      expect((await app.inject({ method: "PATCH", url: `/api/appointments/${id}`, headers, payload: { notes: null } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: "/api/appointments", headers, payload: { title: "Again", startsAt: at, sourceRef: "gmail:me:1a1a" } })).statusCode).toBe(201);
      expect((await app.inject({ method: "POST", url: "/api/appointments", headers, payload: { title: "New", startsAt: at, sourceRef: "gmail:me:other", ...FIXED } })).statusCode).toBe(409);
      // A row written before the rule: closing it needs nothing, editing or restoring it needs its sections.
      const owner = created.json().ownerUserId as string;
      const raw = Object.getPrototypeOf(appointmentsFor(store)!.repository) as AppointmentsRepository;
      const legacy = await raw.create(owner, { title: "Interview: Old subject line", startsAt: at, kind: "INTERVIEW", timeZone: "Asia/Bangkok" });
      const path = `/api/appointments/${encodeURIComponent(legacy.id)}`;
      expect((await app.inject({ method: "PATCH", url: path, headers, payload: { title: "Renamed" } })).statusCode).toBe(409);
      expect((await app.inject({ method: "PATCH", url: path, headers, payload: { status: "CANCELLED" } })).json().status).toBe("CANCELLED");
      expect((await app.inject({ method: "PATCH", url: path, headers, payload: { status: "UPCOMING" } })).statusCode).toBe(409);
      expect((await app.inject({ method: "PATCH", url: path, headers, payload: { status: "DONE" } })).json().status).toBe("DONE");
      expect((await app.inject({ method: "GET", url: "/api/appointments?when=all", headers })).json().appointments.map((item: { title: string }) => item.title)).toContain("Interview: Old subject line");
    } finally {
      await app.close();
    }
  });

  it("needs format and timing, a FLEXIBLE one's deadline, and a time we choose within 11:00-18:00 Bangkok (operator 6/11, nous_msg:ea6f0792)", async () => {
    const store = new InMemorySpaceStore();
    const app = await createApp({ store, config: getApiConfig({}), auth: { sessionSecret, devLogin: false, secureCookies: false } });
    try {
      expect((await app.inject({ method: "PATCH", url: "/api/user-settings", headers, payload: { dateTime: { timeZone: "Asia/Bangkok" } } })).statusCode).toBe(200);
      const add = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/appointments", headers, payload: { title: "Recorded interview", notes: NOTES, ...payload } });
      const refusal = async (payload: Record<string, unknown>) => { const answer = await add(payload); expect(answer.statusCode).toBe(409); return answer.json().error.message as string; };
      const ten = "2099-11-07T10:00:00+07:00";
      expect(await refusal({ startsAt: ten })).toContain("it needs: format (AI_INTERVIEW | RECORDED_VIDEO | LIVE_HUMAN_VIDEO | PHONE | IN_PERSON | WEBINAR | TEST | OTHER); timing (FIXED or FLEXIBLE).");
      const flexible = { format: "RECORDED_VIDEO", timing: "FLEXIBLE", location: "https://app.hireflix.com/x" };
      expect(await refusal({ startsAt: "2099-11-07T11:00:00+07:00", ...flexible })).toContain("it needs: deadlineAt");
      // We choose a FLEXIBLE one's time: 10:00 Bangkok is refused with the rule, and 19:00 too unless a time zone forces it.
      const early = await refusal({ startsAt: ten, ...flexible, deadlineAt: "2099-11-07T13:42:00Z" });
      expect(early).toContain("it needs: a time within 11:00-18:00 Asia/Bangkok");
      expect(early).toContain("must be within 11:00-18:00 in the operator's zone, to 21:00 only with a TIME ZONE REASON");
      const evening = { startsAt: "2099-11-07T19:00:00+07:00", endsAt: "2099-11-07T19:30:00+07:00", ...flexible, deadlineAt: "2099-11-07T23:00:00+07:00" };
      expect(await refusal(evening)).toContain("a time within 11:00-18:00 Asia/Bangkok");
      expect((await add({ ...evening, notes: `${NOTES}\nΛΟΓΟΣ ΖΩΝΗΣ ΩΡΑΣ: ο συνεντευκτής είναι στη Νέα Υόρκη.` })).statusCode).toBe(201);
      expect(await refusal({ ...evening, startsAt: "2099-11-07T20:45:00+07:00", endsAt: "2099-11-07T21:15:00+07:00", notes: `${NOTES}\nTIME ZONE REASON: New York.` })).toContain("a time within 11:00-21:00");
      // A FIXED time the other side set is kept, outside the hours too; the Flosum-like one is FLEXIBLE until its deadline.
      expect((await add({ startsAt: ten, ...FIXED })).json()).toMatchObject({ format: "TEST", timing: "FIXED", deadlineAt: null });
      expect((await add({ startsAt: "2099-11-07T11:00:00+07:00", ...flexible, deadlineAt: "2099-11-07T13:42:00Z" })).json())
        .toMatchObject({ format: "RECORDED_VIDEO", timing: "FLEXIBLE", deadlineAt: "2099-11-07T13:42:00.000Z" });

      // Operator 13/11 16:00 BKK: an online one's location is its real join link, never "link in the mail"; a phone number or a place stays text.
      const text = await refusal({ startsAt: ten, ...FIXED, format: "WEBINAR", location: "Link «Join My Webinar» στο mail" });
      expect(text).toContain("it needs: location that starts with the real join link as an http(s) URL (WEBINAR is joined online");
      expect(text).toContain("for a button that exists only in the mail, the Gmail thread URL");
      expect(await refusal({ startsAt: ten, ...FIXED, format: "AI_INTERVIEW", location: null })).toContain("location that starts with the real join link");
      expect((await add({ startsAt: ten, ...FIXED, format: "PHONE", location: "+30 210 000 0000" })).statusCode).toBe(201);
      const meet = await add({ startsAt: ten, ...FIXED, format: "LIVE_HUMAN_VIDEO", location: "https://meet.google.com/abc-defg-hij" });
      expect(meet.statusCode).toBe(201);
      const patch = (payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/api/appointments/${encodeURIComponent(meet.json().id)}`, headers, payload });
      expect((await patch({ location: "Google Meet (link in the calendar invite)" })).statusCode).toBe(409);
      expect((await patch({ status: "DONE", location: "Google Meet" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
