// The public mock's Copilots room: Mail, Job and Marketing Copilot panes, a finished Research Council run and their
// tasks, with invented people and addresses only (example.com / example.org). MockServices answers the panes' API
// calls from here; nothing reaches a real mailbox, job board, social account or model.
import {
  defaultJobApplyPaneMetadata, defaultMailCopilotPaneMetadata, defaultMarketingCopilotPaneMetadata,
  type CouncilModelsResponse, type CouncilRun, type JobApplication, type MailCopilotEvent, type MailCopilotRunView,
  type MailHabitSender, type MailThread, type MarketingPost, type Pane, type Room, type TaskItem
} from "@space/contracts";
import { DEMO_LOCAL_REPLY, SpaceApiError } from "../runtime/SpaceRuntime.js";
import { DEMO_FIXED_AT } from "./demo-fixture.js";

/** The optional modules the public mock has on: the public release's modules, without Freelance Copilot (1.1.6). */
export const PUBLIC_MOCK_MODULES = ["games", "job-copilot", "mail-copilot", "marketing-copilot", "channels", "telegram", "waitlist", "desktop-updates"] as const;
export const COPILOTS_ROOM_ID = "room:demo-copilots";
export const MAIL_PANE_ID = "pane:demo-mail-copilot";
export const JOB_PANE_ID = "pane:demo-job-copilot";
export const MARKETING_PANE_ID = "pane:demo-marketing-copilot";
const at = DEMO_FIXED_AT;
const owner = "user:demo-user";
const mailbox = "avery@example.com";

export function copilotsRoom(template: Room): Room {
  return { ...structuredClone(template), id: COPILOTS_ROOM_ID, name: "Copilots (coming next)", description: "Mail, Job and Marketing Copilot with invented demo data. Coming next: the public release does not include the copilot agents yet.",
    order: 3, paneLayoutColumns: 2, paneLayoutHeight: 1, traceId: "demo-fixture-copilots" };
}

export function copilotPanes(template: Pane): Pane[] {
  const pane = (id: string, title: string, mode: Pane["mode"], order: number, extra: Partial<Pane>): Pane => ({
    ...structuredClone(template), id, roomId: COPILOTS_ROOM_ID, title, mode, order, terminalRuntimeId: "cli:claude",
    cwd: null, isMinimized: false, isClosed: false, isMaximized: false, ...extra
  });
  return [
    pane(MAIL_PANE_ID, "Mail Copilot", "MAIL_COPILOT", 0, { mailCopilotMetadata: defaultMailCopilotPaneMetadata() }),
    pane(JOB_PANE_ID, "Job Copilot", "JOB_APPLY", 1, { jobApplyMetadata: defaultJobApplyPaneMetadata() }),
    pane(MARKETING_PANE_ID, "Marketing Copilot", "MARKETING_COPILOT", 2, { columnSpan: 2, marketingCopilotMetadata: defaultMarketingCopilotPaneMetadata() })
  ];
}

export function copilotTasks(): TaskItem[] {
  const task = (id: string, title: string, objective: string, paneId: string, paneTitle: string, status: TaskItem["status"]): TaskItem => ({
    id, title, objective, status, source: "MANUAL", roomId: COPILOTS_ROOM_ID, paneId, paneTitle, occurrenceCount: 1,
    characterCount: Array.from(objective).length, createdAt: at, lastUsedAt: at, schedule: null
  });
  return [
    task("task:demo-inbox", "Clear the inbox", "Triage the new mail and draft the replies that need me.", MAIL_PANE_ID, "Mail Copilot", "OPEN"),
    task("task:demo-applications", "Apply to three roles", "Work through the queued postings and stop at every question.", JOB_PANE_ID, "Job Copilot", "RUNNING"),
    task("task:demo-launch-post", "Launch post", "Draft the launch post for review before it goes out.", MARKETING_PANE_ID, "Marketing Copilot", "OPEN")
  ];
}

// --- Mail Copilot ---------------------------------------------------------------------------------------------
const threads = [
  { threadId: "demo-thread-1", from: { name: "Jamie Rivera", address: "jamie@example.org" }, subject: "Workshop dates for November", snippet: "Could we move the workshop to the second week?", unread: true },
  { threadId: "demo-thread-2", from: { name: "Billing", address: "billing@example.com" }, subject: "Invoice 2026-114 is ready", snippet: "Your invoice for October is attached.", unread: true },
  { threadId: "demo-thread-3", from: { name: "Morgan Lee", address: "morgan@example.org" }, subject: "Re: Design review notes", snippet: "Thanks, the second option reads better.", unread: false },
  { threadId: "demo-thread-4", from: { name: "Newsletter", address: "news@example.com" }, subject: "This week in self-hosting", snippet: "Five tools worth a look this week.", unread: false }
] as const;

function mailThread(threadId: string): MailThread {
  const row = threads.find(item => item.threadId === threadId) ?? threads[0];
  return { account: mailbox, threadId: row.threadId, subject: row.subject, messages: [{
    account: mailbox, messageId: `${row.threadId}-m1`, threadId: row.threadId, from: { ...row.from }, to: [{ name: "Avery Example", address: mailbox }],
    cc: [], replyTo: [], subject: row.subject, receivedAt: at, rfcMessageId: null, references: null, labelIds: row.unread ? ["INBOX", "UNREAD"] : ["INBOX"],
    unread: row.unread, starred: false, text: `${row.snippet}\n\nThis conversation is invented demo data.`, html: null, blockedImages: false, attachments: []
  }] } as MailThread;
}

const reviewDraft = {
  account: mailbox, to: ["jamie@example.org"], cc: [], bcc: [], subject: "Re: Workshop dates for November", threadId: "demo-thread-1",
  text: "Hi Jamie,\n\nThe second week works for me. Tuesday or Wednesday morning would be best.\n\nBest,\nAvery"
};

function mailEvent(id: string, type: MailCopilotEvent["type"], message: string, threadId: string | null = null): MailCopilotEvent {
  return { id, ownerUserId: owner, paneId: MAIL_PANE_ID, runId: "mailrun:demo-run-1", accountEmail: mailbox, threadId, messageId: null,
    type, status: null, message, payload: {}, createdAt: at };
}

const habits: MailHabitSender[] = [{
  account: mailbox, sender: "news@example.com", summary: "news@example.com: archived 9 of 9 (100%)", lastAt: at,
  level: { level: "sender", key: "news@example.com", decisions: 9, actions: [{ action: "ARCHIVE", labels: [], observed: 9, inferred: 0, share: 1, lastAt: at }] }
}];

// --- Job Copilot -----------------------------------------------------------------------------------------------
function application(id: string, company: string, role: string, ats: JobApplication["ats"], status: JobApplication["status"], notes: string | null = null): JobApplication {
  return { id, ownerUserId: owner, paneId: JOB_PANE_ID, company, role, ats, url: `https://jobs.example.com/${id.slice(7)}`, status,
    evidenceArtifactIds: [], externalConfirmation: status === "VERIFIED" ? "confirmation code DEMO-42" : null, notes,
    appliedAt: status === "VERIFIED" ? at : null, queuePosition: null, createdAt: at, updatedAt: at };
}
const applications = [
  application("jobapp:demo-001", "Example Labs", "Platform Engineer", "greenhouse", "VERIFIED"),
  application("jobapp:demo-002", "Sample Systems", "Backend Engineer", "ashby", "NEEDS_USER", "Asks for the earliest start date"),
  application("jobapp:demo-003", "Demo Works", "Full-stack Developer", "lever", "QUEUED"),
  application("jobapp:demo-004", "Placeholder Inc.", "Site Reliability Engineer", "greenhouse", "QUEUED")
];
const jobProfile = {
  ownerUserId: owner, campaignStartedAt: null,
  candidate: { fullName: "Avery Example", email: mailbox, phone: null, address: null, location: "Remote", country: null, linkedinUrl: null, githubUrl: null,
    websiteUrl: null, headline: "Platform engineer", summary: null, workAuthorization: null, needsSponsorship: false, willingToRelocate: null,
    salaryExpectation: null, noticePeriod: null, yearsOfExperience: 6, skills: ["TypeScript", "PostgreSQL", "Kubernetes"], languages: ["English"],
    experience: [], education: [], extra: {} },
  qaBank: [], cvArtifactId: "artifact:demo-cv-avery", coverLetterArtifactId: null, cvTextChars: 3800, mailbox: null, mailboxVerifiedAt: null,
  google: null, googleAccounts: [], googleAvailable: false, updatedAt: at
};
function jobEvent(id: string, type: string, message: string, applicationId: string | null) {
  return { id, ownerUserId: owner, paneId: JOB_PANE_ID, applicationId, runId: "jobrun:demo-run-1", type, message, payload: {}, artifactId: null, createdAt: at };
}

// --- Marketing Copilot -----------------------------------------------------------------------------------------
function post(id: string, channel: MarketingPost["channel"], status: MarketingPost["status"], body: string, title: string | null = null, publishedUrl: string | null = null): MarketingPost {
  return { id, ownerUserId: owner, paneId: MARKETING_PANE_ID, campaignId: null, channel, kind: "POST", target: null, title, body, assets: [], status,
    scheduledAt: null, reviewNote: null, ruleId: null, publishedUrl, publishedAt: publishedUrl ? at : null, evidence: {}, metrics: {}, createdAt: at, updatedAt: at };
}

// --- Research Council ------------------------------------------------------------------------------------------
const councilCatalog: CouncilModelsResponse = {
  coordinatorDefault: "claude/claude-opus-5-5", webSearch: true,
  models: [
    { id: "claude/claude-opus-5-5", displayName: "Claude Opus 5.5", providerId: "claude", available: true, note: null },
    { id: "codex/gpt-6-astra", displayName: "GPT-6 Astra", providerId: "codex", available: true, note: null },
    { id: "antigravity/gemini-3.8-flash-medium", displayName: "Gemini 3.8 Flash (Medium)", providerId: "antigravity", available: true, note: null }
  ]
};
const councilRun: CouncilRun = {
  id: "council_run:demo-run-1", ownerUserId: owner, question: "Which three changes would make our onboarding emails clearer?",
  coordinatorModelId: "claude/claude-opus-5-5", status: "COMPLETED", stage: "DONE", estimate: { calls: 9, minutes: 4 }, qa: [], changeRequests: [],
  plan: { understanding: "Improve a short onboarding email sequence for a developer tool.", personalContext: "", reviewRounds: 1, agreementTarget: 0.67,
    members: [{ modelId: "codex/gpt-6-astra", reason: "research" }, { modelId: "claude/claude-opus-5-5", reason: "writing" }, { modelId: "antigravity/gemini-3.8-flash-medium", reason: "second view" }],
    criteria: [{ id: "clarity", label: "Clear for a first-time user" }, { id: "effort", label: "Small change" }], searchQueries: ["onboarding email best practices"] },
  evidence: [{ title: "Onboarding email examples (demo)", url: "https://example.com/onboarding-examples", finding: "Short emails with one action each are read more often." }],
  answers: [], rounds: [],
  final: {
    text: "1. Put one action in each email.\n2. Show the first result within the first email.\n3. Replace the feature list with a three-step checklist.\n\nThis answer is invented demo data.",
    top: [
      { positionId: "P1", title: "One action per email", mean: 8.7, agree: 3, reviewers: 3 },
      { positionId: "P2", title: "Show the first result in email one", mean: 8.0, agree: 3, reviewers: 3 },
      { positionId: "P3", title: "A three-step checklist instead of a feature list", mean: 7.3, agree: 2, reviewers: 3 }
    ]
  },
  events: [{ at, text: "The plan was approved." }, { at, text: "Three members answered." }, { at, text: "The agreed Top 3 is ready." }],
  clipboardPlan: null, error: null, createdAt: at, updatedAt: at
};

/** Answers for the Copilots room and the Council dock; `handled: false` lets the rest of the mock answer. */
export class MockCopilots {
  private pending: MailCopilotRunView["pending"] = [{
    id: "mailrev:demo-review-1", kind: "REVIEW", eventId: "mailevt:demo-evt-3", accountEmail: mailbox, threadId: "demo-thread-1",
    message: "Reply to Jamie about the workshop dates", payload: { draft: reviewDraft, summary: "Accept the second week and offer two mornings.",
      reasoning: "You usually answer scheduling mail the same day and offer two options." }, createdAt: at
  }];
  private posts: MarketingPost[] = [
    post("mktpost:demo-post-1", "LINKEDIN", "IN_REVIEW", "We run our coding agents side by side in one self-hosted workspace. Here is what changed in our first week."),
    post("mktpost:demo-post-2", "X", "PUBLISHED", "Three small things that made our onboarding emails clearer.", null, "https://example.com/posts/demo-1")
  ];

  invoke(method: string, args: unknown[]): { handled: boolean; value?: unknown } {
    const value = this.answer(method, args);
    return value === undefined ? { handled: false } : { handled: true, value: structuredClone(value) };
  }

  private answer(method: string, args: unknown[]): unknown {
    switch (method) {
      // Operator-only surfaces of the maker's instance are not part of the public release: answer like a server without them.
      case "roomShares": case "nous": case "nousMessages": case "nousOverview": case "nousDecisions": case "nousPaneBoard":
        throw new SpaceApiError("Not available in the public release.", { status: 404, code: "NOT_FOUND" });
      // The demo shows a finished run; asking, steering or deleting needs real models.
      case "createCouncilRun": case "councilRunAction": case "deleteCouncilRun":
        throw new SpaceApiError(DEMO_LOCAL_REPLY, { status: 409, code: "DEMO_LOCAL_ONLY" });
      case "browserHandoff": return { handoff: null };
      case "connectors": return { providers: [], accounts: [{ accountId: `connector:${"d".repeat(32)}`, provider: "GOOGLE", email: mailbox,
        capabilities: ["MAIL_READ", "MAIL_COMPOSE", "MAIL_ORGANIZE"], connectedAt: at }] };
      case "mailCopilotSettings": return { metadata: defaultMailCopilotPaneMetadata() };
      case "updateMailCopilotSettings": return { metadata: args[1] };
      case "updateMailCopilotView": return { view: null };
      case "mailAccounts": return { accounts: [{ email: mailbox, access: "full", inPane: true, unread: 2, error: null }] };
      case "mailLabels": return { labels: [{ id: "INBOX", name: "Inbox", type: "system", unread: 2 }, { id: "Label_clients", name: "Clients", type: "user", unread: 0 }] };
      case "mailThreads": return { threads: threads.map(row => ({ account: mailbox, threadId: row.threadId, messageId: `${row.threadId}-m1`, from: { ...row.from },
        subject: row.subject, snippet: row.snippet, receivedAt: at, unread: row.unread, starred: false, hasAttachment: false, messageCount: 1,
        labelIds: row.unread ? ["INBOX", "UNREAD"] : ["INBOX"] })), nextPageToken: null, errors: [] };
      case "mailThread": return { thread: mailThread(String(args[2])) };
      case "mailCopilotRun": return this.mailRun();
      case "startMailCopilotRun": return { ...this.mailRun(), kickoffSent: false };
      case "pauseMailCopilotRun": case "stopMailCopilotRun": return this.mailRun();
      case "decideMailReview": {
        const id = (args[1] as { reviewId?: string } | undefined)?.reviewId;
        this.pending = this.pending.filter(item => item.id !== id);
        return { decision: (args[1] as { decision?: string } | undefined)?.decision ?? "approve", sent: null };
      }
      case "mailCopilotEvents": return { events: [
        mailEvent("mailevt:demo-evt-3", "REVIEW_REQUESTED", "Drafted a reply to Jamie Rivera for your review", "demo-thread-1"),
        mailEvent("mailevt:demo-evt-2", "ARCHIVED", "Archived “This week in self-hosting” (your habit for news@example.com)", "demo-thread-4"),
        mailEvent("mailevt:demo-evt-1", "RUN_STARTED", "Run started: 2 new conversations")
      ] };
      case "mailHabits": return { habits };
      case "mailRules": return { rules: [] };
      case "mailMemory": return { memories: [] };
      case "mailActions": return { actions: [] };
      case "mailFixRequests": return { requests: [] };
      case "jobApplyProfile": return { profile: jobProfile };
      case "jobApplications": return { applications };
      case "jobApplySettings": return { metadata: defaultJobApplyPaneMetadata() };
      case "updateJobApplySettings": return { metadata: args[1] };
      case "jobApplyStats": return { stats: { campaignStartedAt: null, firstDay: "2026-10-01", today: { applied: 1, verified: 1, failed: 0 },
        totals: { applied: 1, verified: 1, failed: 0, needsUser: 1 }, days: [{ day: "2026-10-01", applied: 1, verified: 1, failed: 0 }],
        earlier: { imported: { sent: 0, failed: 0 }, archived: { sent: 0, failed: 0 } } } };
      case "jobApplyRun": return { run: null, status: "IDLE", queue: applications.filter(row => row.status === "QUEUED"), current: null, pending: [] };
      case "jobApplyEvents": return { events: [
        jobEvent("jobevt:demo-evt-2", "QUESTION", "Sample Systems asks for the earliest start date", "jobapp:demo-002"),
        jobEvent("jobevt:demo-evt-1", "VERIFIED", "Verified Example Labs · Platform Engineer (confirmation code DEMO-42)", "jobapp:demo-001")
      ] };
      case "jobApplyFields": return { fields: [] };
      case "jobApplyMemory": return { memories: [], total: 0 };
      case "marketingCopilotSettings": return { metadata: defaultMarketingCopilotPaneMetadata() };
      case "updateMarketingCopilotSettings": return { metadata: args[1] };
      case "marketingCopilotRun": case "marketingCopilotRunAction": return { run: null, status: "IDLE", pending: [], backlog: 0 };
      case "marketingPosts": return { posts: this.posts };
      case "decideMarketingPost": {
        const [, id, input] = args as [string, string, { decision?: string; body?: string }];
        this.posts = this.posts.map(row => row.id !== id ? row : { ...row, status: input?.decision === "reject" ? "REJECTED" : "APPROVED", body: input?.body ?? row.body });
        return { post: this.posts.find(row => row.id === id) ?? null };
      }
      case "marketingCampaigns": return { campaigns: [] };
      case "marketingEvents": return { events: [] };
      case "marketingMemory": return { memories: [] };
      case "marketingBookmarks": return { bookmarks: [] };
      case "marketingAnalytics": return { metrics: [], topPosts: this.posts.filter(row => row.status === "PUBLISHED"), published: 1 };
      case "councilModels": return councilCatalog;
      case "councilRuns": return { runs: [{ id: councilRun.id, question: councilRun.question, status: councilRun.status, stage: councilRun.stage, createdAt: at, updatedAt: at }] };
      case "councilRun": return { run: councilRun };
      default: return undefined;
    }
  }

  private mailRun(): MailCopilotRunView {
    return { run: { id: "mailrun:demo-run-1", ownerUserId: owner, paneId: MAIL_PANE_ID, status: "RUNNING",
      counters: { taken: 3, replied: 0, drafted: 1, archived: 1, labeled: 0, skipped: 0, needsUser: 0, fixed: 0 }, currentEventId: null,
      kickoffSentAt: at, startedAt: at, pausedAt: null, stoppedAt: null, lastActivityAt: at, createdAt: at, updatedAt: at },
      status: "RUNNING", pending: this.pending, backlog: 1 };
  }
}
