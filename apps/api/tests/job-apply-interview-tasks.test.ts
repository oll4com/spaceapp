import { describe, expect, it } from "vitest";
import type { Appointment, JobApplyEventInput, NotificationRaiseInput, SpaceNotification } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import { createNotificationService } from "../src/notifications/service.js";
import {
  closeInterviewTask, completeAppointment, parseDeadline, recordInterviewTask, remindInterviews, renderInterviewReminder, setInterviewDeadline, siblingDeadline, taskDeadline, type InterviewRequest, type PassMail
} from "../src/job-apply/interview-tasks.js";
import { classifyApplicationMail } from "../src/job-apply/mail-triage.js";

// Operator 2026-10-27 13:41 Bangkok: tests and interviews become reminder tasks with their deadline, reminded every day.
const owner = "user:operator";
const bangkokStore = () => {
  const store = new InMemorySpaceStore();
  store.updateUserSettings(owner, { dateTime: { timeZone: "Asia/Bangkok" } });
  return store;
};
const hackerRank = "Hi Nikolaos,\nYou have been invited to attend the challenge.\nStart Login Date/Time: 27 Oct 2026 09:31 AM IST (Asia - Kolkata)\nEnd Login Date/Time: 3 Nov 2026 09:31 AM IST (Asia - Kolkata)\nGood luck!";
const request = (overrides: Partial<InterviewRequest> = {}): InterviewRequest => ({
  account: "ntheogr@gmail.com", threadId: "1a17b854ae8ffb10", subject: "[Due 7 days] Your HackerRank Agoda's Technical Assessment (Back End) - Software Engineering Invitation",
  from: "HackerRank <support@hackerrankforwork.com>", text: hackerRank, sentAt: "2026-10-27T04:01:00.000Z", application: null, ...overrides
});

describe("deadline parser", () => {
  it.each([
    ["HackerRank's End Login Date/Time in IST (Agoda)", hackerRank, "2026-10-27T04:01:00.000Z", "2026-11-03T04:01:00.000Z"],
    ["start and end on one line", "Start Login Date/Time: 27 Oct 2026 09:31 AM IST End Login Date/Time: 3 Nov 2026 09:31 AM IST", "2026-10-27T04:01:00.000Z", "2026-11-03T04:01:00.000Z"],
    ["the recruiter's 'within: 7 days' (FINN via Ewa, 2026-10-26)", "Look for an email from HackerRank Chakra, please complete it within: 7 days", "2026-10-26T07:01:00.000Z", "2026-11-02T07:01:00.000Z"],
    ["within the next 7 days", "Please take the test within the next 7 days.", "2026-10-26T07:01:00.000Z", "2026-11-02T07:01:00.000Z"],
    ["within 7 days of the mail (FINN via Ewa)", "Please complete the HackerRank Chakra React test within 7 days.", "2026-10-26T07:01:00.000Z", "2026-11-02T07:01:00.000Z"],
    ["a subject's [Due 7 days]", "[Due 7 days] Your HackerRank Technical Assessment", "2026-10-26T07:01:00.000Z", "2026-11-02T07:01:00.000Z"],
    ["month name first with at and PDT (CodeSignal)", "Please complete it by October 20, 2026 at 11:59 PM PDT.", "2026-10-13T08:00:00.000Z", "2026-10-21T06:59:00.000Z"],
    ["an interview's time before its date", "Your interview is scheduled for 11:00 AM GMT+7 on Tuesday, November 3, 2026.", "2026-10-27T04:00:00.000Z", "2026-11-03T04:00:00.000Z"],
    ["a Calendly range with a long zone name", "Event: 30 Minute Interview\nDate & Time: 10:00am - 10:30am, Tuesday, November 3, 2026 (Indochina Time)", "2026-10-27T04:00:00.000Z", "2026-11-03T03:00:00.000Z"],
    ["an ISO time with its offset", "Deadline: 2026-11-03T09:31+05:30", "2026-10-27T04:00:00.000Z", "2026-11-03T04:01:00.000Z"],
    ["no deadline stated (Axis Global)", "Please answer the written screening questions below and reply to this email.", "2026-10-20T04:00:00.000Z", null],
    ["a time without its zone is not a deadline", "Please complete it by 3 Nov 2026 09:31 AM.", "2026-10-27T04:00:00.000Z", null],
    ["the employer's promise is not a deadline", "We'll get back to you within 5 days.", "2026-10-27T04:00:00.000Z", null],
    ["a date before the mail is a quoted header", "On 20 Oct 2026 09:00 UTC, the deadline was set.", "2026-10-27T04:00:00.000Z", null],
    // 31/10 (Criteria's "complete within 48 hours" for Lendable, mail 30/10 17:53 UTC): hours count from the mail.
    ["within 48 hours of the mail (Criteria)", "Please complete the assessment within 48 hours.", "2026-10-30T17:53:00.000Z", "2026-11-01T17:53:00.000Z"],
    ["48 hrs written short", "You have 48 hrs to complete the test.", "2026-10-30T17:53:00.000Z", "2026-11-01T17:53:00.000Z"],
    ["a 48-hour window", "You have a 48-hour window to complete it.", "2026-10-30T17:53:00.000Z", "2026-11-01T17:53:00.000Z"],
    ["business days are not counted", "Please complete the test within 5 business days.", "2026-10-27T04:00:00.000Z", null],
    // 5/11 (Flosum's Hireflix video interview, sent 13:42 UTC): the link's validity counts from the mail.
    ["a link valid for 48 hours (Flosum via Hireflix)", "The next step is a short video interview. Please note the link is valid for 48 hours.", "2026-11-05T13:42:00.000Z", "2026-11-07T13:42:00.000Z"],
    ["a link that expires after 2 days", "Your interview link expires after 2 days.", "2026-11-05T13:42:00.000Z", "2026-11-07T13:42:00.000Z"],
    ["48h to record", "You have 48h to record your answers.", "2026-11-05T13:42:00.000Z", "2026-11-07T13:42:00.000Z"],
    ["a recruiter's resend states no deadline (Flosum)", "Thank you for letting me know, and no need to apologize. I've just resent the Hireflix video interview invitation to your email.", "2026-11-05T13:39:59.000Z", null]
  ] as const)("%s", (_name, text, sentAt, expected) => {
    expect(parseDeadline(text, sentAt)).toBe(expected);
  });

  it("does not count a relative deadline without the mail's time", () => {
    expect(parseDeadline("Please complete the test within 7 days.", null)).toBeNull();
  });
});

describe("test and interview tasks", () => {
  it("keeps one task per Gmail thread with the deadline in the operator's zone, updated by a later mail", async () => {
    const store = bangkokStore();
    const first = await recordInterviewTask(store, owner, request());
    expect(first).toMatchObject({ status: "OPEN", source: "AGENT", paneId: null });
    expect(first.title).toBe("Test: [Due 7 days] Your HackerRank Agoda's Technical Assessment (Back End) - Software Engineering Invitation, due Tue 3 Nov 11:01 GMT+7");
    expect(taskDeadline(first)).toBe("2026-11-03T04:01:00.000Z");
    expect(first.objective).toContain("Gmail thread: 1a17b854ae8ffb10 (ntheogr@gmail.com)");
    // A second mail of the thread with no deadline keeps the one already known; another thread is another task.
    const second = await recordInterviewTask(store, owner, request({ text: "Reminder: you have been invited to attend the challenge." }));
    expect(second.id).toBe(first.id);
    expect(taskDeadline(second)).toBe("2026-11-03T04:01:00.000Z");
    const tracked = await recordInterviewTask(store, owner, request({ threadId: "1a15e9a301e6df08", subject: "Next step", text: "Please answer the screening questions below.",
      application: { id: "jobapp:axis", company: "Axis Global", role: "Software Engineer" } }));
    expect(tracked.title).toBe("Test: Axis Global: Next step, deadline not stated");
    expect(taskDeadline(tracked)).toBeNull();
    expect(tracked.objective).toContain("space_job_mail_deadline");
    expect((await store.listTaskItems(owner, { page: 1, pageSize: 25 })).items).toHaveLength(2);

    // The copilot records the deadline it read; a rejection or a "completed" mail closes the task, and a new ask reopens it.
    const recorded = await setInterviewDeadline(store, owner, "1a15e9a301e6df08", "2026-11-05T17:00:00+07:00");
    expect(recorded?.title).toBe("Test: Axis Global: Next step, due Thu 5 Nov 17:00 GMT+7");
    expect(taskDeadline(recorded!)).toBe("2026-11-05T10:00:00.000Z");
    expect(await setInterviewDeadline(store, owner, "unknown-thread", "2026-11-05T17:00:00+07:00")).toBeNull();
    expect((await closeInterviewTask(store, owner, "1a17b854ae8ffb10"))?.status).toBe("DONE");
    expect((await recordInterviewTask(store, owner, request()))).toMatchObject({ id: first.id, status: "OPEN" });
  });

  // Seen on stable 2026-10-27: "Test: agoda Title not recorded" (an imported tracker row) and FINN's React test named after its DevOps application.
  it("names the task after the mail's subject, not a tracked application's role", async () => {
    const store = bangkokStore();
    const agoda = await recordInterviewTask(store, owner, request({ application: { id: "jobapp:P3b2mYUiLAOp", company: "agoda", role: "Title not recorded" } }));
    expect(agoda.title).toBe("Test: [Due 7 days] Your HackerRank Agoda's Technical Assessment (Back End) - Software Engineering Invitation, due Tue 3 Nov 11:01 GMT+7");
    const finn = await recordInterviewTask(store, owner, request({ threadId: "1a17703e474931dc", subject: "FINN Frontend Engineer - React Assessment - Remote at Ewa Services",
      text: "Ewa Services has invited you to take the test.", application: { id: "jobapp:jp1oD_ojikBF", company: "FINN", role: "Senior Platform Engineer (DevOps)" } }));
    expect(finn.title).toBe("Test: FINN Frontend Engineer - React Assessment - Remote at Ewa Services, deadline not stated");
    expect(`${agoda.objective}\n${finn.objective}`).not.toMatch(/Title not recorded|DevOps|Application:/);
  });

  // FINN 2026-10-26: HackerRank's invite states no deadline; the recruiter's mail of the same minute says "within: 7 days".
  it("takes the deadline from the same company's other mail of the pass when the invitation states none", async () => {
    const store = bangkokStore();
    const finn = { id: "jobapp:finn", company: "FINN", role: "Lead Frontend Engineer" };
    const invite = request({ threadId: "1a17703e474931dc", subject: "FINN Frontend Engineer - React Assessment - Remote at Ewa Services", from: "Ewa Services Hiring Team <support@hackerrankforwork.com>",
      text: "You have been invited to take the test. Interview Duration: 65 minutes", sentAt: "2026-10-26T07:01:10.000Z", application: finn });
    const recruiter: PassMail = { threadId: "1a177036652c1ee9", company: "FINN", sentAt: "2026-10-26T07:01:00.000Z", from: "sohail.k@ewa-services.com",
      subject: "Your FINN interview journey starts here, 15", text: "Look for an email from HackerRank Chakra, please complete it within: 7 days" };
    const sibling = siblingDeadline(invite, [recruiter]);
    expect(sibling).toEqual({ dueAt: "2026-11-02T07:01:00.000Z", from: "sohail.k@ewa-services.com", threadId: "1a177036652c1ee9" });
    // Another company, another hour, or the invite's own thread do not count.
    expect(siblingDeadline(invite, [{ ...recruiter, company: "Agoda" }])).toBeNull();
    expect(siblingDeadline(invite, [{ ...recruiter, sentAt: "2026-10-26T09:30:00.000Z" }])).toBeNull();
    expect(siblingDeadline(invite, [{ ...recruiter, threadId: invite.threadId }])).toBeNull();
    const task = await recordInterviewTask(store, owner, invite, sibling);
    expect(task.title).toBe("Test: FINN Frontend Engineer - React Assessment - Remote at Ewa Services, due Mon 2 Nov 14:01 GMT+7");
    expect(task.objective).toContain("Deadline stated in: sohail.k@ewa-services.com (thread 1a177036652c1ee9); this mail states none.");
    // The deadline belongs to the invite's thread only: the recruiter's thread has no task of its own.
    expect((await store.listTaskItems(owner, { q: "1a177036652c1ee9 (", page: 1, pageSize: 5 })).items).toHaveLength(0);
    const corrected = await setInterviewDeadline(store, owner, invite.threadId, "2026-11-02T18:00:00+07:00");
    expect(corrected?.objective).not.toContain("Deadline stated in:");
  });

  it("takes Flosum's deadline from the Hireflix invite of the pass, in the operator's zone", async () => {
    const store = bangkokStore();
    const flosum = { id: "jobapp:flosum", company: "Flosum", role: "Senior Node.js Developer" };
    const resend = request({ threadId: "1a19f9ebbd072df4", subject: "Re: Senior Node.js Developer (Romania) - Flosum", from: "Nicole Suico <nicole@flosum.com>",
      text: "I've just resent the Hireflix video interview invitation to your email.", sentAt: "2026-11-05T13:39:59.000Z", application: flosum });
    const hireflix: PassMail = { threadId: "1a1abf22d07df18f", company: "Flosum", sentAt: "2026-11-05T13:42:00.000Z", from: "Flosum via Hireflix <users@hireflix.com>",
      subject: "Nikolaos, great news! You're moving forward to the next step", text: "The next step is a short video interview. Please note the link is valid for 48 hours." };
    const task = await recordInterviewTask(store, owner, resend, siblingDeadline(resend, [hireflix]));
    expect(taskDeadline(task)).toBe("2026-11-07T13:42:00.000Z");
    expect(task.title).toBe("Interview: Re: Senior Node.js Developer (Romania) - Flosum, Sat 7 Nov 20:42 GMT+7");
  });

  it("files a 'completed' receipt as a confirmation, never an invitation that mentions completing", () => {
    const now = Date.parse("2026-10-27T05:00:00.000Z");
    const mail = (text: string) => classifyApplicationMail({ from: "HackerRank <support@hackerrankforwork.com>", subject: "HackerRank", text, receivedAt: "2026-10-27T04:00:00.000Z" }, now);
    expect(mail("Thank you for completing the Agoda Back End assessment. The hiring team will review it.")).toBe("CONFIRMATION");
    expect(mail("You have been invited to attend the challenge. Once you have completed the test, your results go to Agoda.")).toBe("ACTION_NEEDED");
  });
});

describe("daily test and interview reminder", () => {
  const nowMs = Date.parse("2026-10-27T03:05:00.000Z"); // 10:05 in Bangkok
  const task = (id: string, title: string, deadline: string, status: "OPEN" | "DONE" = "OPEN") => ({
    id, title, status, source: "AGENT" as const, roomId: null, paneId: null, paneTitle: null, occurrenceCount: 1, characterCount: 10, createdAt: "2026-10-26T00:00:00.000Z",
    lastUsedAt: "2026-10-26T00:00:00.000Z", schedule: null, objective: `${title}\nDeadline: ${deadline}\nTodo\nGmail thread: ${id} (me@gmail.com)`
  });

  it("lists open ones soonest first, marks due in <24 h, says a passed deadline once and leaves done tasks out", () => {
    const hours = (count: number) => new Date(nowMs + count * 3_600_000).toISOString();
    const reminder = renderInterviewReminder([
      task("a", "Test: A", hours(30)), task("b", "Interview: B", hours(5)), task("c", "Test: C", "not stated"), task("d", "Test: D", hours(2), "DONE"),
      task("e", "Test: E", hours(-2)), task("f", "Test: F", hours(-72)), { ...task("g", "Someone else's task", hours(1)), objective: "No thread here" }
    ], nowMs);
    expect(reminder).toEqual({ title: "Tests and interviews: 3 open", taskIds: ["b", "a", "c", "e"],
      body: "- Interview: B (due in <24 h)\n- Test: A\n- Test: C\n- Test: E (deadline passed)" });
    expect(renderInterviewReminder([task("f", "Test: F", hours(-72))], nowMs)).toBeNull();
  });

  it("raises one ATTENTION reminder a day at 10:00 in the operator's zone, also across a restart", async () => {
    const store = bangkokStore();
    await recordInterviewTask(store, owner, request());
    const raised: NotificationRaiseInput[] = [];
    const notifications = {
      async raise(input: NotificationRaiseInput) { raised.push(input); },
      async list() { return raised.map((input) => ({ ...input, id: "n" }) as unknown as SpaceNotification); }
    };
    const at = (iso: string) => new Date(iso);
    const sent = new Set<string>();
    expect(await remindInterviews({ store, notifications, sent }, owner, at("2026-10-27T02:59:00.000Z"))).toBe(false); // 09:59 Bangkok
    expect(await remindInterviews({ store, notifications, sent }, owner, at("2026-10-27T03:05:00.000Z"))).toBe(true);
    expect(await remindInterviews({ store, notifications, sent }, owner, at("2026-10-27T03:20:00.000Z"))).toBe(false);
    expect(await remindInterviews({ store, notifications, sent: new Set() }, owner, at("2026-10-27T09:00:00.000Z"))).toBe(false);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ source: "JOB_COPILOT", kind: "INTERVIEW_REMINDER", severity: "ATTENTION", dedupeKey: "job-apply:interviews:2026-10-27",
      title: "Tests and interviews: 1 open", roomId: null, paneId: null });
    expect(raised[0]!.body).toContain("due Tue 3 Nov 11:01 GMT+7");
    expect(await remindInterviews({ store, notifications, sent }, owner, at("2026-10-28T03:01:00.000Z"))).toBe(true);
    expect(raised.at(-1)!.dedupeKey).toBe("job-apply:interviews:2026-10-28");
  });
});

describe("an appointment marked completed", () => {
  // Operator 4/11 (nous_msg:dc24e81ea2c9, after the Axis Global interview): Completed updates the systems the appointment came from.
  it("closes its interview task and the cards about it, refreshes today's list and writes the step on the thread's application", async () => {
    const store = bangkokStore();
    const axis = await recordInterviewTask(store, owner, request({ subject: "Axis Global interview", text: "Your interview is scheduled for 3:00 PM GMT+7 on Wednesday, November 4, 2026.",
      sentAt: "2026-11-02T03:00:00.000Z" }));
    const other = await recordInterviewTask(store, owner, request({ threadId: "19other", subject: "Other assessment", text: "Please complete the assessment by 10 November 2026 11:59 PM GMT+7." }));
    const plain = await store.upsertTaskItem({ ownerUserId: owner, title: "Call the bank", objective: "Call the bank", status: "OPEN", source: "AGENT" });
    const notifications = createNotificationService({ repository: new InMemorySpaceNotificationsRepository(() => "2026-11-04T05:00:00.000Z"), eventBus: new SpaceEventBus(),
      now: () => "2026-11-04T05:00:00.000Z", userSettings: async () => ({ dateTime: { timeZone: "UTC" }, notifications: { quietHours: { enabled: false, start: "23:00", end: "09:00" } } }) as never,
      recordRoomEvent: async () => { throw new Error("roomless"); } });
    const card = (source: SpaceNotification["source"], kind: string, dedupeKey: string, extra: Partial<NotificationRaiseInput> = {}) => notifications.raise({ ownerUserId: owner, roomId: null,
      paneId: null, source, kind, severity: "ATTENTION", title: kind, body: "", link: {}, dedupeKey, payload: {}, telegram: null, ...extra });
    await card("JOB_COPILOT", "INTERVIEW_REMINDER", "job-apply:interviews:2026-11-04", { title: "Tests and interviews: 2 open", payload: { taskIds: [axis.id, other.id] } });
    await card("NOUS", "APPOINTMENT_REMINDER", "appointment:axis:1", { payload: { appointmentId: "appointment:axis" } });
    await card("MAIL_COPILOT", "NEEDS_YOU", "mail:thread", { link: { target: `thread:ntheogr@gmail.com:${request().threadId}` } });
    await card("NOUS", "APPOINTMENT_REMINDER", "appointment:other:1", { payload: { appointmentId: "appointment:other" } });
    const logged: JobApplyEventInput[] = [];
    const deps = { store, notifications, now: () => new Date("2026-11-04T05:00:00.000Z"), jobApply: {
      listEvents: async () => [{ applicationId: "jobapp:otherApp01", payload: { threadId: "19other" } }, { applicationId: "jobapp:wI9JU9mjj2V-", payload: { category: "ACTION_NEEDED", threadId: request().threadId } }],
      logEvent: async (_owner: string, input: JobApplyEventInput) => { logged.push(input); } } };
    const appointment = (id: string, sourceRef: string): Appointment => ({ id, ownerUserId: owner, title: "Interview: Axis Global interview", startsAt: "2026-11-04T08:00:00.000Z", endsAt: null,
      timeZone: "Asia/Bangkok", kind: "INTERVIEW", location: null, notes: null, sourceRef, status: "DONE", format: null, timing: null, deadlineAt: null, remindersSent: [1440], createdAt: "", updatedAt: "" });

    expect(await completeAppointment(deps, owner, appointment("appointment:axis", axis.id))).toEqual({ taskId: axis.id, applicationId: "jobapp:wI9JU9mjj2V-", closed: 2 });
    expect((await store.getTaskItem(owner, axis.id))!.status).toBe("DONE");
    expect((await store.getTaskItem(owner, other.id))!.status).toBe("OPEN");
    expect(logged).toEqual([expect.objectContaining({ applicationId: "jobapp:wI9JU9mjj2V-", type: "NOTE", message: "Completed: Interview: Axis Global interview",
      payload: expect.objectContaining({ category: "APPOINTMENT_DONE", appointmentId: "appointment:axis", threadId: request().threadId, taskId: axis.id }) })]);
    const waiting = await notifications.waiting(owner);
    expect(waiting.map((item) => item.dedupeKey).sort()).toEqual(["appointment:other:1", "job-apply:interviews:2026-11-04"]);
    expect(waiting.find((item) => item.kind === "INTERVIEW_REMINDER")).toMatchObject({ title: "Tests and interviews: 1 open", payload: { taskIds: [other.id] } });

    // A plain task's appointment changes no task and names no application.
    expect(await completeAppointment(deps, owner, appointment("appointment:plain", plain.id))).toEqual({ taskId: null, applicationId: null, closed: 0 });
    expect((await store.getTaskItem(owner, plain.id))!.status).toBe("OPEN");
  });
});
