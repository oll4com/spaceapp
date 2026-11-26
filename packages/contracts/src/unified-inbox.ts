import { z } from "zod";
import type { SpaceNotification } from "./notifications.js";
import type { NousDecision, NousOperatorRequest } from "./nous.js";

/**
 * One «Εισερχόμενα» for every client (operator 15/11 18:10 BKK, plan clipboard:aE7U1J_gU9OV): a view over the records that already exist
 * (space_notifications, nous_decisions, Nous's inbox, the operator's requests). Nothing is copied or migrated; an act writes to the record.
 */
export const UNIFIED_NOTICE_KINDS = ["ACTION_REQUIRED", "COMPLETED", "UPDATE", "IN_PROGRESS", "ALERT", "INTERNAL_QUEUE"] as const;
export type UnifiedNoticeKind = typeof UNIFIED_NOTICE_KINDS[number];
export type UnifiedNoticeStatus = "ACTION_PENDING" | "UNREAD" | "READ" | "RESOLVED";
export type UnifiedNoticePriority = "URGENT" | "ATTENTION" | "INFO";
export type UnifiedNoticeSource = "NOUS" | "AGENT" | "COPILOT" | "MONITORING" | "SECURITY" | "SYSTEM";
export type UnifiedNoticeActionType = "CHOICE" | "TEXT_INPUT" | "APPROVAL" | "GO_TO_PANE" | "ACKNOWLEDGE" | "OPEN_REPORT";

export interface UnifiedNoticeItem {
  /** `notification:<id>`, `decision:<id>`, `inbox:<key>` or `request:<messageId>`: the record it shows. */
  id: string;
  kind: UnifiedNoticeKind;
  status: UnifiedNoticeStatus;
  priority: UnifiedNoticePriority;
  source: UnifiedNoticeSource;
  sourceLabel: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  target?: { roomId?: string | null; paneId?: string | null; planId?: string | null; requestId?: string | null; ticketId?: string | null; url?: string | null };
  actions?: { type: UnifiedNoticeActionType; options?: string[]; recommended?: string; reportUrl?: string };
  /** The record itself, so a client keeps its own card for it (Needs you, Done, Update, decision, request). */
  record: { notification: SpaceNotification } | { decision: NousDecision } | { request: NousOperatorRequest } | { inbox: { key: string; text: string; at: string | null } };
}

/** The pills: Όλα, Ενέργεια, Ολοκληρωμένα, Ενημερώσεις & Alerts, Σε εξέλιξη, Αρχείο & Αναζήτηση. */
export const UNIFIED_INBOX_FILTERS = ["ALL", "ACTION", "COMPLETED", "UPDATES", "IN_PROGRESS", "ARCHIVE"] as const;
export type UnifiedInboxFilter = typeof UNIFIED_INBOX_FILTERS[number];

export const unifiedNoticeIdSchema = z.string().regex(/^(notification|decision|inbox|request):\S{1,400}$/);
export const unifiedInboxQuerySchema = z.object({
  filter: z.enum(UNIFIED_INBOX_FILTERS).default("ALL"),
  /** The page's `before` from the last answer: a time (notifications) or a message id (the archive's requests). */
  before: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** ARCHIVE only: words in the requests' text. */
  q: z.string().max(200).optional(),
  /** The History period's floor (HISTORY_FLOORS sets it): COMPLETED, UPDATES and ARCHIVE page inside it; what waits shows whatever its age. */
  since: z.string().datetime({ offset: true }).optional()
}).strict();
export type UnifiedInboxQuery = z.infer<typeof unifiedInboxQuerySchema>;

export interface UnifiedInboxPage {
  items: UnifiedNoticeItem[];
  /** Pass back as `before` for the next page; null when nothing older is left. */
  before: string | null;
  /** Waiting items per pill (ARCHIVE has no count: it is history). */
  counts: Record<Exclude<UnifiedInboxFilter, "ARCHIVE">, number>;
  /** The one badge (plan §B3): ACTION_PENDING + UNREAD at ATTENTION or URGENT. */
  badge: number;
  /** At least one ACTION_PENDING: the badge in the attention colour. */
  attention: boolean;
}

export const UNIFIED_INBOX_ACTIONS = ["ANSWER", "ACKNOWLEDGE", "MARK_READ", "DISMISS"] as const;
export const unifiedInboxActInputSchema = z.object({
  action: z.enum(UNIFIED_INBOX_ACTIONS),
  /** ANSWER: a needs-you card's option (Approve or Decline on a decision), and/or the operator's words. */
  option: z.string().trim().min(1).max(80).optional(),
  text: z.string().trim().min(1).max(2000).optional(),
  always: z.boolean().optional()
}).strict().refine((input) => input.action !== "ANSWER" || input.option || input.text, { message: "Pick an option or write an answer." });
export type UnifiedInboxActInput = z.infer<typeof unifiedInboxActInputSchema>;
export interface UnifiedInboxActResult { item: UnifiedNoticeItem | null; display: string | null; badge: number; attention: boolean }

/** The badge rule, shared by the server's count and any client that counts what it holds. */
export const unifiedBadgeCounts = (item: Pick<UnifiedNoticeItem, "status" | "priority">) =>
  item.status === "ACTION_PENDING" || (item.status === "UNREAD" && item.priority !== "INFO");
