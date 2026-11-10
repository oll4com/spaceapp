import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Appointment, TaskItem } from "@space/contracts";
import type { JobApplicationRecord, JobApplyEventRecord } from "@space/db";
import { buildJobReport, platformOf } from "../src/job-apply/report.js";
import { hoursOf, parseCryptoTable, readCryptoReport, reasonsOf, startedOf, verdictOf } from "../src/nous/reports.js";

// Job applications and Crypto (operator 3/11 22:33 BKK, nous_msg:e734994004dd): only what the records say; replies per company named
// as a whole word by the sender's domain, name or subject; stages derived from distinct test/interview records.
const app = (id: string, company: string, status = "VERIFIED", extra: Partial<JobApplicationRecord> = {}): JobApplicationRecord => ({
  id, ownerUserId: "user:operator", paneId: null, company, role: "Engineer", ats: "greenhouse", url: `https://job-boards.greenhouse.io/${id}`, status,
  evidenceArtifactIds: [], externalConfirmation: null, notes: null, appliedAt: status === "VERIFIED" || status === "SUBMITTED" ? "2026-10-20T03:00:00.000Z" : null,
  queuePosition: null, notBefore: null, createdAt: "2026-10-20T02:00:00.000Z", updatedAt: "2026-10-20T03:00:00.000Z", ...extra });
let n = 0;
const mail = (category: string, subject: string, message: string, payload: Record<string, unknown> = {}, applicationId: string | null = null): JobApplyEventRecord => ({
  id: `jobevt:e${(n += 1)}`, ownerUserId: "user:operator", paneId: null, applicationId, runId: null, type: "MAIL", message, artifactId: null, createdAt: `2026-10-2${n % 9}T05:00:00.000Z`,
  payload: { category, account: "me@x.com", messageId: `m${n}`, subject, receivedAt: `2026-10-2${n % 9}T04:00:00.000Z`, ...payload } });
const task = (id: string, kind: "Test" | "Interview", subject: string, from: string, thread: string, status: TaskItem["status"] = "OPEN", deadline = "not stated"): TaskItem => ({
  id, title: `${kind}: ${subject}, deadline not stated`, status, source: "AGENT", roomId: null, paneId: null, paneTitle: null, occurrenceCount: 1, characterCount: 10,
  createdAt: "2026-10-25T00:00:00.000Z", lastUsedAt: "2026-10-25T00:00:00.000Z", schedule: null,
  objective: [`${kind}: ${subject}`, `Deadline: ${deadline}`, "Take it.", `From: ${from}`, `Mail: "${subject}" sent Tue 27 Oct 10:00 GMT+7`, `Gmail thread: ${thread} (me@x.com)`].join("\n") });

describe("job report", () => {
  const applications = [app("jobapp:oura01", "Oura", "FAILED"), app("jobapp:snyk01", "Snyk"), app("jobapp:snyk02", "Snyk", "SUBMITTED"), app("jobapp:mongo1", "Mongodb"),
    app("jobapp:scale1", "Scale AI"), app("jobapp:scale2", "Scaleai"), app("jobapp:junk01", "Software Engineer", "SUBMITTED"), app("jobapp:sword1", "Sword"),
    app("jobapp:queued", "Queued Co", "QUEUED"), app("jobapp:wk0001", "Upstream", "VERIFIED", { ats: "other", url: "https://apply.workable.com/upstream/j/1" })];
  const events = [
    // The triage stored these under Oura ("y-OUR A-pplication"); the sender's domain and the subject say otherwise.
    mail("REJECTION", "Important information about your application to MongoDB", "Rejection email from no-reply@mongodb.com: Important information about your application to MongoDB", {}, "jobapp:oura01"),
    mail("REJECTION", "Thank you for your interest with Scale AI", "Rejection email from no-reply@scale.com: Thank you for your interest with Scale AI", {}, "jobapp:oura01"),
    mail("REJECTION", "Your job application to Senior AI Software Engineer at Sword", "Rejection email from no-reply@us.greenhouse-mail.io: Your job application to Senior AI Software Engineer at Sword"),
    mail("REJECTION", "Regarding your application to WPP", "Rejection email from no-reply@es.wpp.com: Regarding your application to WPP", {}, "jobapp:oura01"),
    // The same Gmail message recorded twice counts once; summaries name no message.
    { ...mail("REJECTION", "dup", "x"), payload: { category: "REJECTION", messageId: "m1", subject: "dup" } },
    { ...mail("REJECTION", "", "Archived 1 email under Job Applications/Rejections"), payload: { category: "REJECTION", count: 1 } },
    mail("ACTION_NEEDED", "Thanks for applying to Upstream", "Action needed: Thanks for applying to Upstream from Workable", { from: "noreply@workablemail.com", threadId: "t-up" }),
    mail("ACTION_NEEDED", "Interview with Snyk | Luke", "Action needed: Interview with Snyk | Luke from Luke Baker", { from: "luke@gmail.com", threadId: "t-snyk1" })
  ];
  const tasks = [task("task:s1", "Interview", "Interview with Snyk | Luke", "Luke Baker <luke@gmail.com>", "t-snyk1", "OPEN", "2026-11-05T12:00:00.000Z (Thu 5 Nov 19:00 GMT+7)"),
    task("task:s0", "Test", "Snyk coding test", "Snyk <talent@snyk.io>", "t-snyk0", "DONE"),
    task("task:s0r", "Test", "Reminder: Snyk coding test", "Snyk <talent@snyk.io>", "t-snyk0b", "DONE"),
    task("task:h1", "Test", "Your participant badge", "HackerRank <a@hackerrank.com>", "t-hr"),
    { ...task("task:other", "Test", "x", "y", "t-x"), title: "Pay the rent" }];
  const appointments: Appointment[] = [{ id: "appt:1", ownerUserId: "user:operator", title: "Interview with Snyk", startsAt: "2026-11-05T12:00:00.000Z", endsAt: null, timeZone: "Asia/Bangkok",
    kind: "INTERVIEW", location: null, notes: null, sourceRef: "manual", status: "UPCOMING", remindersSent: [], createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" } as Appointment];
  const report = buildJobReport({ applications, events, tasks, appointments, timeZone: "Asia/Bangkok", now: new Date("2026-11-03T00:00:00.000Z") });
  const company = (name: string) => report.companies.find((entry) => entry.name === name)!;

  it("attributes a mail to the company it names, never by the triage's loose match", () => {
    expect(company("Mongodb").rejections.map((entry) => entry.subject)).toEqual(["Important information about your application to MongoDB"]);
    // "Scale AI" and "Scaleai" are one company; the subject names it with a space.
    expect(company("Scale AI").rejections).toHaveLength(1);
    expect(company("Scale AI").applicationIds).toEqual(["jobapp:scale1", "jobapp:scale2"]);
    // A board import's "Software Engineer" company never takes a subject's job title.
    expect(company("Sword").rejections).toHaveLength(1);
    expect(company("Software Engineer").rejections).toHaveLength(0);
    // Oura was never sent, and WPP was never applied to: their mail names no company of ours.
    expect(report.companies.some((entry) => entry.name === "Oura")).toBe(false);
    // HackerRank's badge mail made a test task, but we sent HackerRank nothing: it names no company of ours either.
    expect(report.unmatched.map((entry) => entry.subject)).toEqual(["Your participant badge", "Regarding your application to WPP"]);
  });

  it("derives stages from distinct test and interview records and counts the funnel per company", () => {
    // The reminder is the same test; the manual appointment at the task's minute is the same interview.
    expect(company("Snyk").stages.map((stage) => [stage.kind, stage.open])).toEqual([["TEST", false], ["INTERVIEW", true]]);
    expect(company("Snyk").outcome).toBe("IN_PROCESS");
    expect(company("Upstream").stages).toHaveLength(0);
    expect(company("Upstream").otherMails.map((entry) => entry.subject)).toEqual(["Thanks for applying to Upstream"]);
    expect(report.funnel).toEqual({ rows: 10, applied: 8, confirmed: 6, companies: 6, rejected: 3, invited: 1, passed: [1, 0, 0, 0], offers: 0, noReply: 2, pending: 2 });
    expect(report.notSent).toEqual({ FAILED: 1, QUEUED: 1 });
    // HackerRank's badge mail names no company we sent an application to: listed, open, never a stage of ours.
    expect(report.pending.map((entry) => [entry.company, entry.subject])).toEqual([["Snyk", "Interview with Snyk | Luke"], [null, "Your participant badge"]]);
    expect(report.platforms.find((row) => row.platform === "Workable")).toEqual({ platform: "Workable", applied: 1, confirmed: 1, companies: 1, rejected: 0, invited: 0 });
    expect(report.weeks.find((row) => row.week === "2026-10-19")).toMatchObject({ applied: 8, confirmed: 6 });
  });

  it("reads a name a board stored without spaces in the words or the domain of a mail", () => {
    // Stable 3/11: "DV Trading", auros.global and "Eight Sleep" mails were listed under no company, the companies read "No reply".
    const joined = buildJobReport({ applications: [app("jobapp:dv0001", "Dvtrading"), app("jobapp:auros1", "Aurosglobal"), app("jobapp:eight1", "Eightsleep"), app("jobapp:next01", "Nextstep")],
      events: [mail("REJECTION", "Thank you from DV Trading", "Rejection email from no-reply@us.greenhouse-mail.io: Thank you from DV Trading"),
        mail("REJECTION", "Important information about your application to AUROS", "Rejection email from no-reply@auros.global: Important information about your application to AUROS")],
      tasks: [task("task:e1", "Test", "Thanks for applying to Eight Sleep!", "Eight Sleep <no-reply@ashbyhq.com>", "t-e1")], appointments: [], timeZone: "Asia/Bangkok", now: new Date("2026-11-03T00:00:00.000Z") });
    const named = (name: string) => joined.companies.find((entry) => entry.name === name)!;
    expect([named("Dvtrading").outcome, named("Aurosglobal").outcome, named("Eightsleep").outcome]).toEqual(["REJECTED", "REJECTED", "IN_PROCESS"]);
    expect(joined.unmatched).toEqual([]);
    expect(joined.funnel).toMatchObject({ rejected: 2, invited: 1, noReply: 1 });
  });

  it("finds a company in a subject by its first word run, punctuation around it too, and the longest name wins (indexed lookup, 4/11)", () => {
    const report = buildJobReport({ applications: [app("jobapp:acme01", "Acme"), app("jobapp:acme02", "Acme Labs"), app("jobapp:orei01", "O'Reilly Media"), app("jobapp:other1", "Other Co")],
      events: [mail("REJECTION", "Your application to (Acme Labs), thanks", "Rejection email from no-reply@us.greenhouse-mail.io: Your application to (Acme Labs), thanks"),
        mail("REJECTION", "O'Reilly Media: update", "Rejection email from no-reply@us.greenhouse-mail.io: O'Reilly Media: update"),
        mail("REJECTION", "Acmelabs news", "Rejection email from no-reply@us.greenhouse-mail.io: Acmelabs news")],
      tasks: [], appointments: [], timeZone: "Asia/Bangkok", now: new Date("2026-11-03T00:00:00.000Z") });
    const named = (name: string) => report.companies.find((entry) => entry.name === name)!;
    expect([named("Acme Labs").outcome, named("O'Reilly Media").outcome, named("Acme").outcome, named("Other Co").outcome]).toEqual(["REJECTED", "REJECTED", "NO_REPLY", "NO_REPLY"]);
    // "Acmelabs" holds neither name as a word (a joined key needs two words of the text): no company.
    expect(named("Acme Labs").rejections).toHaveLength(1);
    expect(report.unmatched.map((entry) => entry.subject)).toEqual(["Acmelabs news"]);
  });

  it("counts one step mailed several times once, and a title's 'Remote' names no company", () => {
    // Stable 3/11: Snyk's invitation, calendar invite and appointment read "passed stage 2"; FINN's assessment "- Remote at Ewa Services" invited Remote.
    const steps = buildJobReport({ applications: [app("jobapp:snyk01", "Snyk"), app("jobapp:remot1", "Remote"), app("jobapp:finn01", "FINN")], events: [],
      tasks: [task("task:a", "Interview", "You're invited to an interview at Snyk!", "Luke <luke@snyk.io>", "t-a"), task("task:b", "Interview", "Invitation: Interview with Snyk", "Luke <luke@snyk.io>", "t-b"),
        task("task:f", "Test", "FINN Frontend Engineer - React Assessment - Remote at Ewa Services", "Ewa Services <support@hackerrankforwork.com>", "t-f")],
      appointments: [{ id: "appt:s", ownerUserId: "user:operator", title: "Snyk: recruiter call", startsAt: "2026-10-27T05:00:00.000Z", endsAt: null, timeZone: "Asia/Bangkok", kind: "INTERVIEW",
        location: null, notes: null, sourceRef: "manual", status: "UPCOMING", remindersSent: [], createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z" } as Appointment],
      timeZone: "Asia/Bangkok", now: new Date("2026-11-03T00:00:00.000Z") });
    expect(steps.companies.map((entry) => [entry.name, entry.stages.length])).toEqual([["FINN", 1], ["Remote", 0], ["Snyk", 1]]);
    expect(steps.funnel).toMatchObject({ invited: 2, passed: [0, 0, 0, 0] });
    // The merged step keeps the appointment's time though the invitation that opened it had none.
    expect(steps.pending.find((entry) => entry.company === "Snyk")?.deadline).toBe("2026-10-27T05:00:00.000Z");
  });

  it("counts a test appointment as a stage and the same subject again after 14 days as another (Agoda, stable 5/11)", () => {
    const appt = (id: string, title: string, kind: Appointment["kind"], startsAt: string): Appointment => ({ id, ownerUserId: "user:operator", title, startsAt, endsAt: null,
      timeZone: "Asia/Bangkok", kind, location: null, notes: null, sourceRef: "manual", status: "DONE", remindersSent: [], createdAt: startsAt, updatedAt: startsAt });
    const hackerrank = "Agoda Software Engineer - HackerRank Test";
    const report = buildJobReport({ applications: [app("jobapp:agoda1", "Agoda"), app("jobapp:hackr1", "HackerRank")], events: [],
      tasks: [{ ...task("task:h1", "Test", hackerrank, "Agoda <noreply@hackerrankforwork.com>", "t-h1", "DONE"), createdAt: "2026-10-18T03:00:00.000Z" },
        { ...task("task:h2", "Test", hackerrank, "Agoda <noreply@hackerrankforwork.com>", "t-h2", "DONE"), createdAt: "2026-11-02T03:00:00.000Z" }],
      appointments: [appt("appointment:7bce0d7350fd438b", "Agoda: recruiter screen", "INTERVIEW", "2026-08-20T07:00:00.000Z"),
        appt("appointment:ed72d611f740460d", "Agoda: SHL assessment", "DEADLINE", "2026-08-31T07:00:00.000Z"),
        appt("appointment:29ea2718f25f42fb", "Agoda · Back End Lead Software Engineer: HackerRank Coding Interview (Andrei Chalkov)", "INTERVIEW", "2026-09-04T09:30:00.000Z"),
        appt("appointment:agodavisa0000001", "Agoda: send visa documents", "DEADLINE", "2026-09-10T07:00:00.000Z")],
      timeZone: "Asia/Bangkok", now: new Date("2026-11-05T00:00:00.000Z") });
    // The coding interview names HackerRank too, which the operator also applied to: the tool, not the employer.
    expect(report.companies.map((entry) => [entry.name, entry.stages.map((stage) => [stage.kind, stage.at.slice(0, 10)])])).toEqual([["Agoda", [["INTERVIEW", "2026-08-20"],
      ["TEST", "2026-08-31"], ["INTERVIEW", "2026-09-04"], ["TEST", "2026-10-18"], ["TEST", "2026-11-02"]]], ["HackerRank", []]]);
  });

  it("names the platform from the ATS or the posting's address", () => {
    expect(platformOf("ashby", "https://jobs.ashbyhq.com/x")).toBe("Ashby");
    expect(platformOf("other", "https://work.turing.com/jobs/1")).toBe("Turing");
    expect(platformOf("other", "https://careers.example.com/1")).toBe("Company site");
    expect(platformOf("other", "https://space.local/imported/1")).toBe("Earlier tracker");
  });
});

describe("crypto report", () => {
  const registry = ["# Registry", "", "| # | category | method / tool | source | test mode | where | started | h logged | success | €/month | capital € | risk | status | owner | evidence |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    "| B01 | arb | Cross-exchange | web | paper | public-host /opt/crypto/bob/B01 | 2026-10-29 12:30Z | 60.4 (stopped 1/11) | 55 % | 0 | 0 | M | COMPLETED_ECONOMIC: FAILS (55 % and a negative mean) | Bob | bob/B01/report.md |",
    "| D28 | yield | Stablecoin lending | aave | paper | public-host | 29/10 | 179 pool events | 97 % | 1.8 | 1000 | L | WORKS | Dana | dana/D28.md |",
    "| F12 | testnet | Monad tasks | docs | testnet | public-host | 29/10 | 0 runtime; eligibility/source review only | n/a | 0 | 0 | M | SKIP (operator action required) | Finn | finn/F12 |"].join("\n");
  const table = ["# Draft of the final table", "", "- **189 rows** checked.", "", "| State | Count |", "|---|---:|", "| PASS | 1 |", "",
    "| ID | Μέθοδος | Κατηγορία | Ποσοστό επιτυχίας / δείγμα | Κέρδος ανά μήνα / βάση πηγής | Κεφάλαιο | Κίνδυνος | Πηγή / τεκμήριο | PASS/FAIL ≥70% / εκκρεμότητα |",
    "|---|---|---|---|---|---|---|---|---|",
    "| B01 | Cross-exchange arb | Arbitrage | 16/64 = 25 % (CI 10.2-49.5) | -0.2 €/mo | 0 | M | [registry](/var/lib/spaceapp-user/agent-workspace/active/x/methods.md:5) | FAIL βάσει καταγεγραμμένης αξιολόγησης |",
    "| D28 | Stablecoin lending | Staking / yield | 75/77 = 97.4 % (CI 91.0-99.3) | 1.8 per 1,000 | 1000 | L | [registry](/var/lib/spaceapp-user/agent-workspace/active/x/methods.md:6)<br>aave.com | **PASS ≥70%** στην παραλλαγή USD |",
    "| D28-n2 | Stablecoin lending retest | Staking / yield | pending | – | 1000 | L | [rows](/var/lib/spaceapp-user/agent-workspace/active/x/methods.md:6) | εκκρεμεί έως 03/11 23:12 BKK |",
    "| F12 | Monad tasks | node/testnet | 48 h logged | 0 | 0 | M | [registry](/var/lib/spaceapp-user/agent-workspace/active/x/methods.md:7) [code](/var/lib/spaceapp-user/agent-workspace/nous/crypto/binance-code.txt:1) | SKIP / χωρίς οικονομική τεκμηρίωση ≥70% |",
    "| X1 | Research | Other | – | – | – | – | none | ΕΡΕΥΝΑ / δεν υπάρχει οικονομικό δείγμα |", ""].join("\n");

  it("reads every row with its registry cells, days run, second checks and reasons", () => {
    const read: string[] = [];
    const report = parseCryptoTable(table, (path) => { read.push(path); return path.endsWith("methods.md") ? registry.split("\n") : null; });
    expect(report.title).toBe("Draft of the final table");
    expect(report.notes).toEqual(["189 rows checked."]);
    expect(report.rows.map((row) => [row.id, row.verdict])).toEqual([["B01", "FAIL"], ["D28", "PASS"], ["D28-n2", "PENDING"], ["F12", "SKIP"], ["X1", "RESEARCH"]]);
    const [b01, d28, retest, f12] = report.rows;
    // The source column is found by its first word, not "βάση πηγής" in the monthly column.
    expect(b01!.monthly).toBe("-0.2 €/mo");
    expect(b01!.registry).toMatchObject({ where: "public-host /opt/crypto/bob/B01", "test mode": "paper", started: "2026-10-29 12:30Z", owner: "Bob" });
    expect(b01!.hours).toBe(60.4);
    expect(b01!.reasons).toEqual(["Success rate below 70%", "Net result negative after costs"]);
    expect(d28!.hours).toBeNull();
    expect(d28!.retests).toEqual(["D28-n2"]);
    expect(retest!.retestOf).toBe("D28");
    expect(d28!.sourceText).toBe("aave.com");
    expect(f12!.reasons).toEqual(["Needs capital or the operator", "Reviewed only, never run"]);
    expect(f12!.hours).toBe(0);
    // A file named like a code is never read.
    expect(read.some((path) => path.includes("binance"))).toBe(false);
    expect(report.verdicts).toMatchObject({ PASS: 1, FAIL: 1, SKIP: 1, PENDING: 1, RESEARCH: 1, INSUFFICIENT: 0 });
    expect(report.categories[0]).toEqual({ category: "Staking / yield", total: 2, verdicts: { PASS: 1, PENDING: 1 } });
  });

  it("reads final-table.md once it exists, else the draft, and nothing for another account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-crypto-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "final-table-draft.md"), table);
    expect((await readCryptoReport(dir)).source).toMatchObject({ final: false, title: "Draft of the final table" });
    writeFileSync(join(dir, "final-table.md"), table.replace("# Draft of the final table", "# Final table"));
    expect((await readCryptoReport(dir)).source).toMatchObject({ final: true, title: "Final table" });
    expect(await readCryptoReport(null)).toMatchObject({ source: null, rows: [] });
  });

  it("reads verdicts, hours and reasons as written", () => {
    expect(["PASS ≥70%", "ΑΝΕΠΑΡΚΗ για PASS", "εκκρεμεί έως 04/11", "Insufficient data", "?"].map(verdictOf)).toEqual(["PASS", "INSUFFICIENT", "PENDING", "INSUFFICIENT", "OTHER"]);
    expect(["~4", "48.000 h nominal clock", "219 / 219 / 208 weekly rounds", "(in L02)", "60.2 live paper"].map(hoursOf)).toEqual([4, 48, null, null, 60.2]);
    // The registry's "started" as a day (the Score's crypto project counts its days from the first): a day/month not after now, else last year's.
    const now = Date.parse("2026-11-04T03:00:00Z");
    expect(["2026-10-29 12:30Z", "14/10", "29/10 19:30 BKK", "25/12", "-", undefined, "31/13"].map((text) => startedOf(text, now))).toEqual(["2026-10-29T00:00:00.000Z",
      "2026-10-14T00:00:00.000Z", "2026-10-29T00:00:00.000Z", "2025-12-25T00:00:00.000Z", null, null, null]);
    expect(reasonsOf("COMPLETED_ECONOMIC: FAILS")).toEqual(["Not grouped (see the row)"]);
    // How a test ran and what it counted are no reason (stable 3/11: 19 of 26 "Needs capital" and 8 of 17 "Program closed" rows).
    expect(reasonsOf("SKIP (no live contests) zero-capital (read) 0.3")).toEqual(["Program closed or nothing open"]);
    expect(reasonsOf("FAIL 0/4 closed trades; mean -2.98% after costs")).toEqual(["Net result negative after costs"]);
    expect(reasonsOf("SKIP (closed, no date for the next)")).toEqual(["Program closed or nothing open"]);
    expect(reasonsOf("FAILS (every route needs capital) zero-capital (read)")).toEqual(["Needs capital or the operator"]);
    expect(reasonsOf("hardware unavailable; zero operator money.")).toEqual(["Not grouped (see the row)"]);
  });
});
