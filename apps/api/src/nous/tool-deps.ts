import type { OwnerQuietState } from "../owner-clock.js";
import type { NousMessage, FreelanceEgressRoute } from "@space/contracts";
import type { MailCampaignsService } from "../mail-campaigns/service.js";
import type { SiteSigninsRepository } from "@space/db";
import type { ListPages } from "../site-signin-account.js";
import type { AppointmentsService } from "../appointments.js";
import type { NousReportedOutcome, NousRequestDone } from "./request-done.js";
import type { NousRequests } from "./requests.js";
import type { createPaceCapEmergency } from "./pace-cap-emergency.js";
import type { NousLessons } from "./lessons.js";
import type { NousSharedFiles } from "./shared-files.js";
import type { NousPrograms } from "./programs.js";
import type { OperatorUpdates } from "./operator-updates.js";
import type { NousCliUpdate } from "./cli-update.js";
import type { TransferService } from "../transfer-service.js";
import type { NousResetCredits } from "./reset-credits.js";
import type { InstanceLinks } from "../instance-link/routes.js";
import type { NousMutes } from "./mutes.js";
import type { ClipboardItem, ClipboardSource, CreateMemoryEntryInput, MemoryEntry, NousCopilot, NousDecision,
  Pane, Room, SpaceNotification, NotificationSource, TaskItem, TaskScheduleInput, UpdatePlanProgressRequest,
  UpsertClipboardItemInput, NousTurnReason, NousGoal, NousGoalUpdateArgs
} from "@space/contracts";
import type { NewNousDecision, NousLedgerRow, RailDecisionCount } from "@space/db";
import type { NousProviderRoom } from "./tokens.js";
import type { NousSelectedModel } from "./model-choice.js";
import type { ReleaseTrainActor, ReleaseTrainInput } from "../release-trains.js";
import type { RoomPaneObservation } from "../room-pane-control.js";
import type { RoomAgentToolContext, RoomAgentToolOutcome } from "../room-agent-tools.js";
import type { VaultProtection } from "../vault/protection.js";
import type { NousAllowances } from "./guardrails.js";
import type { NousFollowups } from "./followups.js";
import type { CloseoutSkip } from "./save-request.js";
import type { NousPaneNotices
} from "./pane-notices.js";
import type { NousPaneWatch } from "./pane-watch.js";
import type { NousOpsDeps } from "./ops-views.js";
import type { NousScorecard } from "./progress.js";
import type { CopilotControlAction } from "./copilot-control.js";
import type { NousHeld } from "./held-dispatch.js";
import type { NousAwayArgs, NousAwayTurn } from "./away.js";
import type { VaultModule } from "../vault/wiring.js";
import type { CouncilService } from "../council/service.js";
import type { DesignService } from "../design/service.js";
import type { VideoService } from "../video/service.js";
import type { MailThread, MailThreadsPage, NousMarketingReport, TokenUsageBreakdown, TokenUsagePeriod } from "@space/contracts";
import type { NousFiles } from "./files.js";
import type { NousWeb } from "./web.js";
import type { NousGit } from "./git.js";
import type { NousDb } from "./db.js";
import type { DeployQueueReport } from "@space/contracts";
import type { NousSubagents } from "./subagents.js";
import type { SharedMemory } from "./shared-memory.js";

export interface NousToolContext {
  owner: string; turnId: string; callId: string; traceId: string;
  /** Why the turn runs and the operator's message it answers (Away starts only from that message, plan clipboard:B7eTUHTJYg3X). */
  turn?: NousAwayTurn;
  modelChoice?: NousSelectedModel;
  /** space_answer_pane's own send: an answer closes the pane's open question, so the open-question guard lets it through. */
  answering?: boolean;
}
export interface NousToolOutcome {
  ok: boolean; display: string; result: string;
  /** Images the tool answers with (space_look): image blocks in the MCP answer, never stored (operator decision 2026-10-24). */
  images?: Array<{ data: string; mimeType: string }>;
  /** A gate held the call back for the operator: a refusal, not a mistake (Nous's scorecard). */
  refused?: boolean;
  /** Plan progress points this call recorded (increases only). */
  planPoints?: number;
  /** space_nous_outcome: how the operator's requests ended, with the request id, plan and answer-only flag Nous gave. */
  outcomes?: NousReportedOutcome[];
  /** R11-2 (5): facts the tool row keeps in its meta (a failed database read's PostgreSQL code and guessed name). */
  meta?: Record<string, unknown>;
}

export interface NousCopilotItem { copilot: NousCopilot; kind: string; id: string; paneId: string | null; title: string; detail: string; /** When the item last went up for a decision (a review requested again moves it). */ createdAt?: string }
export interface NousCopilotDeps {
  items(owner: string): Promise<NousCopilotItem[]>;
  answerQuestion(owner: string, input: { copilot: NousCopilot; questionId: string; paneId: string | null; answer: string; by?: "USER" | "NOUS" }): Promise<string>;
  /** A Freelance or Marketing Copilot pane's run and its newest events, as text. */
  state(owner: string, pane: Pane, offset?: number): Promise<string>;
  /** A brief to a Marketing or Freelance Copilot pane (they take work as briefs, not as CLI prompts). */
  brief(owner: string, pane: Pane, text: string): Promise<string>;
  /** R20-1: Nous's newest brief on the pane still waiting (PENDING) and under 15 minutes old, or null. */
  pendingNousBrief?(owner: string, pane: Pane): Promise<{ id: string; text: string; at: string } | null>;
  /** A copilot pane's CLI agent, pause and run, through the routes its Setup and rail call (copilot-control.ts). */
  control?(owner: string, pane: Pane, action: CopilotControlAction): Promise<string>;
}

export interface NousToolDeps {
  sharedMemory?: SharedMemory;
  /** CLI version upgrades through the guarded update-all path, never the operator's (operator 1/11 03:25 BKK, plan clipboard:-RDH4NlHBL8L). */
  cliUpdate?: NousCliUpdate;
  /** This host as a transfer source (Settings → Transfer, plan clipboard:HO2VBvn_aaPI step 4). */
  transfer?: TransferService;
  /** Codex weekly reset credits: list them, spend one on an account at its quota (operator 2/11 15:38 BKK). */
  resetCredits?: NousResetCredits;
  siteSignins?: SiteSigninsRepository;
  /** The operator's appointments (read when the tool runs: the module registers after Nous's wiring). */
  appointments?: () => AppointmentsService | undefined;
  /** The SpaceApps this one manages (Space Link, ADR-014; read when the tool runs: the sign-in routes register them). */
  instanceLinks?: () => InstanceLinks | undefined;
  /** A self-hosted install (plan clipboard:1NF6u6gcCwtj): NOUS_PUBLIC_HIDDEN are refused. */
  publicInstall?: boolean;
  /** `section`: one named section of the world whole (a turn's prompt names the sections it left out). */
  world(owner: string, reason?: NousTurnReason | "HELPER", modelChoice?: NousSelectedModel, section?: string): Promise<string>;
  /** The owner's live rooms (not archived, no recovery rooms). */
  rooms(owner: string): Promise<Room[]>;
  /** Creates the owner's first room (Space Control needs a room as the request's context, so it cannot). */
  createRoom?(owner: string, name: string, traceId: string): Promise<unknown>;
  /** Every pane of the room, closed ones too (the closed-pane paths of round 9 item 2, 45d and R10-7 need them). */
  listPanes(roomId: string): Promise<Pane[]>;
  inspectPane(pane: Pane): Promise<RoomPaneObservation>;
  roomTool(name: string, args: Record<string, unknown>, ctx: RoomAgentToolContext): Promise<RoomAgentToolOutcome>;
  plans: {
    list(owner: string, includeCompleted: boolean): Promise<ClipboardItem[]>;
    get(owner: string, id: string): Promise<ClipboardItem | null>;
    update(owner: string, id: string, input: UpdatePlanProgressRequest): Promise<ClipboardItem>;
  };
  clipboard: {
    list(owner: string, query: { source?: ClipboardSource; q?: string; includeCompleted: boolean }): Promise<ClipboardItem[]>;
    save(input: UpsertClipboardItemInput): Promise<ClipboardItem>;
    complete(owner: string, id: string, completed: boolean): Promise<ClipboardItem>;
    remove(owner: string, id: string): Promise<void>;
  };
  tasks: {
    list(owner: string): Promise<TaskItem[]>;
    add(owner: string, input: { title: string; objective: string; roomId: string | null; paneId: string | null; paneTitle: string | null; schedule: TaskScheduleInput | null }): Promise<TaskItem>;
    update(owner: string, id: string, input: { status?: "OPEN" | "DONE" | "ARCHIVED"; schedule?: TaskScheduleInput | null }): Promise<TaskItem>;
    /** Binds the task to another pane (or to none): its schedule types into that pane from now on. */
    rebind(owner: string, id: string, binding: { roomId: string | null; paneId: string | null; paneTitle: string | null }): Promise<TaskItem>;
  };
  /** A pane's live browser, for space_look (the masked screenshot the Vault fence allows); absent where no browser host runs. */
  browser?: { getActive(pane: Pane): Promise<unknown | null>; action(pane: Pane, input: { type: "masked_screenshot" }, traceId: string): Promise<{ text?: string | null; session?: { currentUrl?: string | null } | null }>;
    closePage?(pane: Pane, pageId: string, traceId: string): Promise<unknown>; listPages?: ListPages };
  /** space_look {url}: a public page in a one-shot fenced headless Chrome (url-look.ts); absent where no Chrome runs. */
  urlLook?: (url: string) => Promise<{ png: Buffer; url: string }>;
  /** A pane's newest stored page image (its last masked screenshot), for space_look while its live browser is down. */
  lastScreenshot?(paneId: string): Promise<{ id: string; createdAt: string } | null>;
  /** The Vault fence: no page image while a fill holds the page (operator decision 2026-10-24). */
  vaultProtection?: Pick<VaultProtection, "ownerOf" | "release">;
  /** Space Memory, the canonical memory every agent reads; null where it is not configured. */
  /** One page of Space Memory matches from `offset` (MEMORY_PAGE a page). */
  memory: { recall(query: string, offset: number): Promise<MemoryEntry[]>; save(input: CreateMemoryEntryInput, traceId: string): Promise<MemoryEntry> } | null;
  notifications: {
    list(owner: string): Promise<SpaceNotification[]>;
    /** `reason`: why Nous closed it, recorded on the card (`payload.resolvedReason`). */
    resolve(owner: string, id: string, reason?: string): Promise<boolean>;
    /** One of the owner's notifications by id, whatever its status. */
    get?(owner: string, id: string): Promise<SpaceNotification | null>;
    /** A card held for Nous shown to the operator now (NotificationService.releaseHeldForNous); null when it is not held. */
    releaseHeldForNous?(owner: string, id: string): Promise<SpaceNotification | null>;
    /** The source's copilot question cards that no longer wait (RESOLVED or ACKED), newest first. */
    closedQuestions?(owner: string, source: NotificationSource): Promise<SpaceNotification[]>;
    /** R41: a notification of another account (space_db_query reads every account's rows), never its text. */
    elsewhere?(owner: string, id: string): Promise<{ source: string; kind: string; status: string; createdAt: string } | null>;
  };
  releaseTrain(input: ReleaseTrainInput, by: ReleaseTrainActor): Promise<string>;
  /** R13-11: the live release trains (product, version, candidate and the candidate the operator approved). */
  liveTrains?(): Promise<Array<{ product: string; version: string; status: string; sourceSha: string | null; approvedSha?: string | null; captain: { paneId: string; name: string } }>>;
  /** R13-13: the account profile of a pane's live Claude session ("main" when it names none), or null without one. */
  claudeAccount?(paneId: string): Promise<string | null>;
  /** R10-17, R13-12: the mail of 30 days for a decision's recipients and the sites it names, per connected account. */
  mailContext?(owner: string, refs: NousDecision["refs"], named?: string[]): Promise<string[]>;
  setNote(owner: string, key: string, text: string | null): Promise<void>;
  /** The lesson memory (lessons.ts): every lesson recalled by relevance, merged by cause. */
  lessons?: NousLessons;
  /** The owner's dialogue with Nous, oldest first (space_conversation). */
  listConversation?(owner: string): Promise<NousMessage[]>;
  /** Every note of the owner (space_notes). */
  listNotes?(owner: string): Promise<Array<{ key: string; text: string; updatedAt: string }>>;
  /** What the operator lets Nous do on its own (settings mayPromote, mayApproveWarm). */
  allowances(owner: string): Promise<NousAllowances>;
  /** Nous is on with "May send to third parties" (operator 2/11 15:08 BKK): the approvals it covers, a Mail campaign's too, are Nous's. */
  coversApproval?(owner: string): Promise<boolean>;
  /** Rooms whose finished and waiting panes do not wake Nous for a while. */
  mutes?: NousMutes;
  /** Keys into a CLI pane's terminal (serialized with other typing), for space_clear_pane_draft. */
  pressKeys?(sessionId: string, keys: string, traceId: string): Promise<unknown>;
  /** Types an answer into a pane's prompt bound to its fingerprint, for prompts the operator's allowances let Nous answer. */
  answerPrompt(pane: Pane, input: { sessionId: string; answer: string; fingerprint?: string }, traceId: string): Promise<unknown>;
  ask(input: NewNousDecision, options?: { urgent?: boolean; checked?: string[]; sites?: string[]; phone?: boolean; replaces?: string }): Promise<NousDecision>;
  /** Cancels one of Nous's open decisions; false when it is not open any more. */
  /** "IN_CHAT": recorded as answered in the chat (an operator message came after the ask). */
  withdraw(owner: string, id: string, reason: string, answeredInChat?: boolean, replacedBy?: string): Promise<boolean | "IN_CHAT">;
  /** One of the owner's decisions, whatever its status (a withdraw of an answered decision says how it ended). */
  decision?(owner: string, id: string): Promise<NousDecision | null>;
  /** space_settle_decision (goal 84ba917a): writes the outcome and audits it only when the decision is APPROVED; answers the decision as it was. */
  settleDecision?(owner: string, id: string, settlement: { state: "DONE" | "VOID"; proof: string | null; reason: string }): Promise<NousDecision | null>;
  /** space_reply_now: an answer that reaches the operator's chat while the turn runs (service.replyNow). */
  replyNow?(owner: string, turnId: string, text: string): Promise<"SENT" | "NOT_RUNNING" | "AWAY" | "BESIDE">;
  copilots?: NousCopilotDeps;
  /** Texts held for a calm server (held-dispatch.ts). */
  held?: NousHeld;
  /** Nous's scorecard against its 2026-10-17 baseline (plan clipboard:L7RgHsveHbcR). */
  progress?(owner: string): Promise<NousScorecard>;
  /** Helpers that run independent tasks of the turn at once (space_subagents, plan clipboard:BeaSM1Sle5du). */
  subagents?: Pick<NousSubagents, "run" | "wait">;
  /** A CLI pane's last answer from its transcript (Claude Code, Codex), null for other CLIs. */
  lastAnswer?(pane: Pane): Promise<string | null>;
  /** Reminders back into Nous's inbox (plan clipboard:8s0ZNiO3q5ZT S3). */
  followups?: NousFollowups;
  /** One card per pane for what only the operator's hands can do (plan clipboard:8FfXWclYUfOH). */
  paneNotices?: NousPaneNotices;
  requestDone?: NousRequestDone;
  /** The Requests tab's own derivation (GET /api/nous/requests): space_open_requests' notDone. */
  requests?: Pick<NousRequests, "page">;
  /** Agent Files shared to the Nous app for a while (plan clipboard:RQSrp1EczBbV). */
  sharedFiles?: NousSharedFiles;
  /** Startup programs (plan clipboard:17yLAnH5ZpyF). */
  programs?: NousPrograms;
  /** The Marketing page's data (operator 5/11 10:42 BKK, plan clipboard:netzt-nNvtBL): space_marketing_stats. */
  marketing?: { report(owner: string): Promise<NousMarketingReport> };
  /** Nous › Updates (R73): space_operator_update's entries. */
  operatorUpdates?: OperatorUpdates;
  /** When Nous last checked each pane (plan clipboard:MAongwnxq9Ro). */
  paneWatch?: NousPaneWatch;
  /** A pane's newest report (status, source, time), for refusing OK_WORKING on a pane idle after its done report (operator 28/10). */
  paneLastReport?(owner: string, paneId: string): Promise<{ status: string; source: string; at: string; summary: string; body?: string | null } | null>;
  /** One report by id, of the given pane (else of the given plan); space_resolve_notification's proof that an operator ask is done (15/11). */
  findReport?(owner: string, reportId: string, where: { paneId: string | null; planId: string | null }): Promise<{ id: string; status: string; at: string; summary: string; body?: string | null } | null>;
  /** A browser handoff of the pane is still requested or held (browser-handoff.ts `handoffActive`). */
  handoffOpen?(paneId: string): Promise<boolean>;
  /** A tab of a code card's site is open near its pane (needs-you-browser-page.ts `createCodePageOpen`): a closed one ends the code ask (19/11). */
  codePageOpen?(owner: string, pane: { id: string; roomId: string }, target: string | undefined, text: string): Promise<boolean>;
  /** 2026-11-15 REVIEW: a pane's newest report of its own (AGENT, no TURN_END/TODO/HEARTBEAT), for refusing to close a pane whose work is open. */
  paneLastWorkReport?(owner: string, paneId: string): Promise<{ status: string; at: string; summary: string } | null>;
  /** Each pane's worktree with uncommitted or unmerged work (standing-orders.ts `panePendingWorktreePaths`): the note of a close that leaves one names it. */
  pendingWorktreePaths?(panes: Pane[]): Promise<Map<string, string>>;
  /** When the dashboard last saw the pane's state change: the tick's clock for a settled report (save-request.ts `reportSettled`), null when unread. */
  paneSince?(roomId: string, paneId: string): Promise<string | null>;
  /** Each provider pool's room now (tokens.ts nousProviderRooms): a quota-reset wait on a pool with room is refused (2026-11-06 REVIEW). */
  providerRooms?(owner: string): Promise<NousProviderRoom[]>;
  /** R21-appstudio-kick (c): "N briefs waiting since HH:MM UTC" while a brief-taking pane sits idle at its prompt (copilot-brief-watch.ts), else null. */
  briefsWaiting?(paneId: string): string | null;
  /** R35-1 (stuck-panes.ts): the STUCK line of a CLI pane frozen on a spinner or never taking a queued text, else null. */
  stuckPane?(paneId: string): string | null;
  /** The pane a CLI session ran in (pane_cli_sessions), for refs that name a session (operator 28/10 14:57 BKK). */
  cliSessionPane?(sessionId: string): Promise<string | null>;
  /** R10-2: the id of the pane that last left this room under this name in an operator's move (the pane.move audit), or null. */
  paneMovedFrom?(roomId: string, name: string): Promise<string | null>;
  /** Settings standingOrders.closeOperatorPanes: whether Nous may close the operator's own (OPERATOR_TEST) panes. */
  closeOperatorPanes?(owner: string): Promise<boolean>;
  /** Standing orders (standing-orders.ts): what Nous asked to save and closed, from its own calls here. */
  closeouts?: { saveRequested(owner: string, roomId: string, paneIds: string[]): Promise<void>; closed(owner: string, paneIds: string[]): Promise<void>;
    /** R43-1: a room's open panes with their save state and whether they may close now (standing-orders.ts `roomCloseouts`). */
    roomCloseouts?(owner: string, roomId: string): Promise<RoomCloseout[]>;
    /** Panes whose save is asked and not verified yet, with no new work since: each with why it is not asked again (standing-orders.ts `saveRepeats`). */
    saveRepeats?(owner: string, paneIds: readonly string[]): Promise<Map<string, string>>;
    /** Panes whose save is verified with no prompt since (standing-orders.ts `savedUnprompted`). */
    savedUnprompted?(owner: string, paneIds: readonly string[]): Promise<Set<string>> };
  /** A pane's progress reports as text, newest first, with the full newest final report (plan clipboard:ot6-jLKOWDNC). */
  paneReports?(owner: string, pane: Pane, limit: number): Promise<string>;
  /** CORE-016: whether a pane reported done or failed after a time (ms), so work sent to it may go to another pane. */
  paneDoneSince?(owner: string, paneId: string, since: number): Promise<boolean>;
  /** WAITING_QUOTA (operator 14/11): a room's panes whose last turn stopped on their provider's usage limit, and its reset if the CLI named one. */
  quotaWaits?(roomId: string): Promise<Array<{ paneId: string; label: string; since: string | null; resetsAt: string | null; handedOver?: boolean }>>;
  /** The pane board's lines as text (plan clipboard:Y9cgKVHFaHrr). */
  paneBoard?(owner: string): Promise<string>;
  /** Read-only ops views (plan clipboard:8s0ZNiO3q5ZT S5). */
  ops?: NousOpsDeps;
  /** Away mode (plan clipboard:B7eTUHTJYg3X): start, status and end, run for the operator's own chat turn only. */
  away?: { run(owner: string, args: NousAwayArgs, turn: NousAwayTurn): Promise<string> };
  /** The owner's Vault, reached by handle only (vault.ts). */
  vault?: VaultModule;
  /** The Research Council as the operator (plan clipboard:ajcJqa3IW6Eh step 2). */
  council?: Pick<CouncilService, "models" | "list" | "get" | "create" | "answer" | "approve" | "createClipboardPlan">;
  /** Text files of the agent workspace and the owner's Agent Files / Media artifacts, read only, and Nous's own folder (files.ts). */
  files?: NousFiles;
  /** A file of Nous's own folder as a new Agent File of a room (persistAgentFile, audited like space-publish-file). */
  agentFiles?: { add(owner: string, input: { roomId: string; sourceRoot: string; sourcePath: string; filename: string; folder: string; copiedFrom?: string | null }): Promise<{ id: string; byteSize: number }> };
  /** Public pages, web search and network checks, read only (web.ts). */
  web?: NousWeb;
  /** git read only on stable, dev and the Space worktrees (git.ts). */
  git?: NousGit;
  /** Space's own database, read only (db.ts). */
  db?: NousDb;
  /** The merge queues (stable's and dev's roots), as readDeployQueue reports them; null when one cannot be read. */
  queues?(): Promise<Array<{ name: string; report: DeployQueueReport | null }>>;
  /** Nous's own decisions, newest first (the repository's list). */
  decisions?(owner: string, limit?: number, statuses?: NousDecision["status"][]): Promise<NousDecision[]>;
  /** What Nous's turns ran on and cost (service.turnCosts; typed loosely: service.ts imports this module). */
  turnCosts?(owner: string, days: number): Promise<unknown>;
  /** The operator's goals (plan clipboard:DR51jZJEB0j1): the list as text and Nous's own update (goals.ts). */
  goals?: {
    list(owner: string, options?: { statuses?: NousGoal["status"][] }): Promise<NousGoal[]>;
    recordUpdate(owner: string, args: NousGoalUpdateArgs, turnId: string | null): Promise<{ goal: NousGoal; changed: string[] } | { problem: string }>;
  };
  /** Cached account quotas, budget and Nous's last-hour cost; no remote polling. */
  tokenState?(owner: string, reason?: NousTurnReason | "HELPER", modelChoice?: NousSelectedModel): Promise<string>;
  /** Space Gateway pace cap emergency (pace-cap-emergency.ts); `sends`: this instance tells the gateway (stable). */
  paceCapEmergency?: Pick<ReturnType<typeof createPaceCapEmergency>, "active" | "on" | "off"> & { sends: boolean };
  /** Token usage by process and provider (plan clipboard:qH5emwVaV6yO), from Space Gateway's request logs. */
  tokenUsage?(owner: string, period: TokenUsagePeriod): Promise<TokenUsageBreakdown>;
  /** Design requests with Nous as the requester (a Design pane opens in the room when none is open). */
  design?: Pick<DesignService, "createRequest" | "request">;
  mailCampaigns?: Pick<MailCampaignsService, "campaigns" | "results" | "preview" | "labResults" | "lists" | "senders" | "templates" | "runLab" | "submit" | "createCampaign" | "updateCampaign" | "updateSender" | "setSenderWarmup" | "setSenderBulk" | "mailTexts" | "decide" | "resume">;
  /** Video requests with Nous as the requester (a Video pane opens in the room when none is open). */
  video?: Pick<VideoService, "createRequest" | "request">;
  /** The operator's Live voice dialogue, read only. */
  liveHistory?: { read(owner: string, roomId?: string, limit?: number): Promise<{ items: Array<{ roomId: string; roomName?: string; role: string; text: string; createdAtMs: number }> }> };
  /** The owner's connected Gmail accounts, read only (the Mail Copilot service without a pane). */
  /** The browser census rows of the owner's rooms (queue 28/10 01:03: Nous could not list a browser pane's tabs). */
  browserTabs?(owner: string): Promise<BrowserTabsRow[]>;
  /** R11-2 (2): the operator's working time zone, for a waitsOn.until written without an offset. */
  ownerTimeZone?(owner: string): Promise<string>;
  /** R10-8: whether Space's records hold a live browser session for the pane (browser.* operations need one). */
  browserSessionActive?(paneId: string): Promise<boolean>;
  /** Closes one tab no fence, handoff or lease holds; throws with the reason otherwise. */
  closeBrowserTab?(pane: Pane, tabId: string, traceId: string): Promise<void>;
  /** Plan clipboard:iLvBs5eOMZjF: keeps a pane browser's network route and restarts a running browser on it; throws with the reason. */
  setBrowserRoute?(owner: string, pane: Pane, route: FreelanceEgressRoute, traceId: string): Promise<{ route: FreelanceEgressRoute; restarted: boolean }>;
  /** The operator's answers in every copilot rail and needs-you card since a time (goal 7365014c-b). */
  railDecisions?(owner: string, since: string): Promise<RailDecisionCount[]>;
  /** Goal 7365014c-e: the decision ledger since a time, newest first. */
  ledger?(owner: string, since: string): Promise<NousLedgerRow[]>;
  /** R53 (goal 7365014c): the operator-rule entries of Space Memory (tag operator-rule), as the cards read them. */
  operatorRules?(): Promise<Array<{ id: string; title: string; body: string }>>;
  /** R65 (goal ee5a573e): every live Space Memory entry with its card stems (`cardStems`), best read first; `rule` for the operator's rules and answers. */
  cardMemory?(): Promise<Array<{ id: string; title: string; body: string; rule: boolean; stems: Set<string> }>>;
  /** R66: the operator's devices as Space's push records keep them (the app version each one reported, when it was last seen). */
  appDevices?(owner: string): Promise<Array<{ platform: string; appVersion: string | null; lastSeenAt: string }>>;
  /** 9/11 REVIEW (lessons-1109-card-slot-night): the operator's quiet hours, for a card recommending a night slot. */
  ownerQuiet?(owner: string): Promise<Pick<OwnerQuietState, "enabled" | "zoneSet" | "start" | "end" | "night">>;
  /** R66: Space Memory's embeddings (bge-m3), to tell a card's subject across wording and language; absent or failing: its words alone. */
  embed?(texts: string[], purpose: "document" | "query"): Promise<number[][]>;
  /** Queue item 36: the owner's needs-you requests still waiting on open panes (the Needs you tab's list). */
  paneNeeds?(owner: string): Promise<SpaceNotification[]>;
  /** R16-7: the operator's "Ask me before changes on my own hosts" (off by default). */
  askOwnHosts?(owner: string): Promise<boolean>;
  /** Waits between stop checks (tests pass a fast one). */
  wait?(ms: number): Promise<void>;
  /** The owner's copilot memories and Live personal memory holding the query's words (space_memory_recall after Space Memory). */
  copilotMemory?(owner: string, query: string): Promise<Array<{ source: string; id: string; key: string | null; text: string; updatedAt: string }>>;
  mail?: {
    search(owner: string, input: { account: string; q?: string; labelId: string; max: number; pageToken?: string }): Promise<MailThreadsPage>;
    read(owner: string, account: string, threadId: string): Promise<MailThread>;
    /** R17-6: the connected Gmail addresses, named when a read failed on the account or the thread. */
    accounts?(owner: string): Promise<string[]>;
    /** One attachment's text (PDF, text, Word, Excel, PowerPoint), read in the document reader process (read only). */
    attachmentText?(owner: string, account: string, messageId: string, attachmentId: string, filename?: string): Promise<{ status: string; reason: string | null; text: string }>;
  };
}
export interface BrowserTabsRow {
  paneId: string; roomId: string; paneName: string | null; title: string | null; accountEmail: string | null;
  /** The browser account's profile label: panes with the same one share one Chrome. */
  profile?: string;
  /** The pane browser's network route ("direct" when never chosen); absent where no browser host answers it. */
  route?: string | null;
  control: { holderType: string } | null; handoff: { status: string } | null;
  tabs: Array<{ fenced: true; isActive: boolean } | { pageId: string; title: string | null; url: string | null; isActive: boolean }>;
}
/** A room's finished pane as the standing orders see it (`roomCloseouts`); declared here so the tool modules import no standing-orders module (cycle). */
export interface RoomCloseout { pane: Pane; state: string; since: string | null; idleMinutes: number | null; save: string; closable: boolean; skip: CloseoutSkip | null }
