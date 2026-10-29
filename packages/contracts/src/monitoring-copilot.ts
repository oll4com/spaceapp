import { z } from "zod";

// Monitoring Copilot pane (plan clipboard:xkCJ9CeYZq4D, operator request 2026-10-24): the work of public-host (ai-guardian) and public-host
// (monitoring-pro) moves into Space. A collector outside public-host (CT 210: Prometheus, Alertmanager, blackbox, Loki and the guardian
// Telegram relay) does the probing; Space pulls only what it needs (Alertmanager's active alerts and the guardian's messages, once
// a minute; PromQL and LogQL on demand) and turns it into Space notifications and a pane for the agent and Nous. Operator decision
// 2026-10-24: critical alerts reach Nous, warnings stay in the pane's list. The Browser Host parses every pane row with the
// contracts it loaded at start, so every metadata field is declared up front (also the ones later phases use).
export const MONITORING_COPILOT_PANE_MODE = "MONITORING_COPILOT" as const;

const idOf = (prefix: string) => z.string().regex(new RegExp(`^${prefix}:[A-Za-z0-9_-]{6,80}$`));
const isoDateTime = z.string().datetime({ offset: true });
export const MONITORING_TEXT_MAX = 4000;
const text = (max = MONITORING_TEXT_MAX) => z.string().trim().min(1).max(max);

// ---- pane metadata ------------------------------------------------------------------------------
/** ASSIST: every self-healing action asks the operator. FULL: the gate's GO kinds run on their own (Phase 4). */
export const MONITORING_AUTONOMY_LEVELS = ["ASSIST", "FULL"] as const;
export const monitoringAutonomySchema = z.enum(MONITORING_AUTONOMY_LEVELS);
export type MonitoringAutonomy = z.infer<typeof monitoringAutonomySchema>;

/**
 * Only a collector on the fleet's private bridge, over plain HTTP with an explicit port: Space never fetches anything else for
 * this pane, so a stored setting cannot turn the watcher into a request forwarder.
 */
/** The collector network, one plain string: the public export rewrites it like every private address, so the pattern built
 * from it below matches the public tree's own defaults (EXP-001: a regex-escaped copy was left private and rejected them). */
export const MONITORING_COLLECTOR_NETWORK = "192.0.2.";
export const monitoringCollectorUrlSchema = z.string().regex(
  new RegExp(`^http://${MONITORING_COLLECTOR_NETWORK.replace(/\./g, "\\.")}(?:[1-9]\\d?|1\\d\\d|2[0-4]\\d|25[0-4]):(?:[1-9]\\d{1,4})$`),
  `Use http://${MONITORING_COLLECTOR_NETWORK}<host>:<port> (the collector on the fleet's private bridge).`);
export const MONITORING_COLLECTOR_DEFAULTS = {
  prometheusUrl: "http://192.0.2.210:9090",
  alertmanagerUrl: "http://192.0.2.210:9093",
  lokiUrl: "http://192.0.2.210:3100"
} as const;

export const monitoringCopilotPaneSettingsSchema = z.object({
  /** The agent takes no new work while paused; the watcher keeps reading alerts (they matter even then). */
  paused: z.boolean().default(false),
  autonomy: monitoringAutonomySchema.default("ASSIST"),
  collector: z.object({
    prometheusUrl: monitoringCollectorUrlSchema.default(MONITORING_COLLECTOR_DEFAULTS.prometheusUrl),
    alertmanagerUrl: monitoringCollectorUrlSchema.default(MONITORING_COLLECTOR_DEFAULTS.alertmanagerUrl),
    lokiUrl: monitoringCollectorUrlSchema.default(MONITORING_COLLECTOR_DEFAULTS.lokiUrl)
  }).strict().default(MONITORING_COLLECTOR_DEFAULTS),
  notifications: z.object({
    /** critical alerts: ATTENTION notifications, so Nous gets them in its inbox. */
    critical: z.boolean().default(true),
    /** warnings: INFO notifications in the list (no Nous turn). */
    warning: z.boolean().default(true),
    /** the guardian relay's messages (backups, memory pressure, WAN, VPN ...). */
    guardian: z.boolean().default(true),
    /** Off by default: the collector already sends Telegram itself. */
    telegram: z.boolean().default(false)
  }).strict().default({ critical: true, warning: true, guardian: true, telegram: false })
}).strict();
export type MonitoringCopilotPaneSettings = z.infer<typeof monitoringCopilotPaneSettingsSchema>;

export const monitoringCopilotPaneMetadataSchema = z.object({
  version: z.literal(1),
  settings: monitoringCopilotPaneSettingsSchema
}).strict();
export type MonitoringCopilotPaneMetadata = z.infer<typeof monitoringCopilotPaneMetadataSchema>;

export function defaultMonitoringCopilotPaneMetadata(): MonitoringCopilotPaneMetadata {
  return monitoringCopilotPaneMetadataSchema.parse({ version: 1, settings: {} });
}
/** Panes never configured read as defaults. */
export function resolveMonitoringCopilotPaneMetadata(metadata: MonitoringCopilotPaneMetadata | null | undefined): MonitoringCopilotPaneMetadata {
  return metadata ? monitoringCopilotPaneMetadataSchema.parse(metadata) : defaultMonitoringCopilotPaneMetadata();
}

// ---- alerts (Alertmanager's active alerts, as the watcher last saw them) -----------------------------
export const MONITORING_SEVERITIES = ["CRITICAL", "WARNING", "INFO"] as const;
export const monitoringSeveritySchema = z.enum(MONITORING_SEVERITIES);
export type MonitoringSeverity = z.infer<typeof monitoringSeveritySchema>;
/** PROMETHEUS rules or LOKI ruler rules (Loki's rules carry the label source="loki"). */
export const monitoringAlertSourceSchema = z.enum(["PROMETHEUS", "LOKI"]);
export type MonitoringAlertSource = z.infer<typeof monitoringAlertSourceSchema>;
export const monitoringAlertStateSchema = z.enum(["FIRING", "RESOLVED"]);
export type MonitoringAlertState = z.infer<typeof monitoringAlertStateSchema>;
export const monitoringAlertIdSchema = idOf("monalert");
/** Alertmanager's fingerprint: 16 hex digits. */
export const monitoringFingerprintSchema = z.string().regex(/^[0-9a-f]{16}$/);
const labelName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/);

export const monitoringAlertSchema = z.object({
  id: monitoringAlertIdSchema,
  ownerUserId: z.string().min(1).max(200),
  fingerprint: monitoringFingerprintSchema,
  alertname: z.string().min(1).max(200),
  severity: monitoringSeveritySchema,
  source: monitoringAlertSourceSchema,
  instance: z.string().max(300),
  job: z.string().max(200),
  /** Every label as the rule set it (capped); rule files are ours, but a label value can still carry a probed URL. */
  labels: z.record(labelName, z.string().max(300)),
  summary: z.string().max(500),
  description: z.string().max(1000),
  state: monitoringAlertStateSchema,
  startsAt: isoDateTime,
  /** When the watcher stopped seeing it (RESOLVED), else null. */
  endsAt: isoDateTime.nullable(),
  lastSeenAt: isoDateTime,
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type MonitoringAlert = z.infer<typeof monitoringAlertSchema>;

/** What the watcher reads from Alertmanager's /api/v2/alerts (only these fields are kept). */
export const alertmanagerAlertSchema = z.object({
  fingerprint: monitoringFingerprintSchema,
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()).default({}),
  startsAt: z.string(),
  status: z.object({ state: z.string() }).passthrough().optional()
}).passthrough();
export type AlertmanagerAlert = z.infer<typeof alertmanagerAlertSchema>;

/** critical → CRITICAL, warning → WARNING, anything else (info, none, missing) → INFO. */
export function monitoringSeverityOf(label: string | undefined): MonitoringSeverity {
  const value = (label ?? "").toLowerCase();
  return value === "critical" ? "CRITICAL" : value === "warning" ? "WARNING" : "INFO";
}

// ---- guardian messages ----------------------------------------------------------------------------
/**
 * The guardian relay's messages (pve's guardian_notify.log through Loki: backups, memory pressure, BMC, NVMe, WAN, VPN ...),
 * classified by the server: ALERT, FAILED, DOWN or CRITICAL words are ATTENTION, RECOVERY, UP and CLEAR ones are INFO.
 */
export const monitoringGuardianLevelSchema = z.enum(["ALERT", "RECOVERY", "INFO"]);
export type MonitoringGuardianLevel = z.infer<typeof monitoringGuardianLevelSchema>;
export function monitoringGuardianLevel(message: string): MonitoringGuardianLevel {
  if (/\b(RECOVERY|RECOVERED|CLEAR|UP)\b|επανήλθε|✅/i.test(message)) return "RECOVERY";
  if (/\b(ALERT|FAILED|FAILURE|DOWN|CRITICAL|ESCALATION|LIMIT)\b/i.test(message)) return "ALERT";
  return "INFO";
}
/** Repeats of one kind of message share a key: digits and dates fold, so "Daily backup missing for 2026-10-25" is one card. */
export function monitoringGuardianKey(message: string): string {
  return message.split("\n")[0]!.replace(/\[[^\]]*\]/g, " ").replace(/\d+/g, "N").replace(/[^\p{L}\p{N} _:-]+/gu, " ")
    .replace(/\s+/g, " ").trim().slice(0, 80).toLowerCase();
}

// ---- on-demand queries (the agent and Nous) --------------------------------------------------------
export const MONITORING_QUERY_MAX_MINUTES = 1440;
export const MONITORING_QUERY_MAX_POINTS = 2000;
export const MONITORING_QUERY_MAX_SERIES = 50;
const rangeSchema = z.object({
  minutes: z.number().int().min(5).max(MONITORING_QUERY_MAX_MINUTES),
  stepSeconds: z.number().int().min(15).max(3600)
}).strict().refine((range) => (range.minutes * 60) / range.stepSeconds <= MONITORING_QUERY_MAX_POINTS,
  `At most ${MONITORING_QUERY_MAX_POINTS} points per series: raise stepSeconds.`);
/** PromQL, instant (no range) or over the last `minutes`. */
export const monitoringPromQuerySchema = z.object({ query: text(1000), range: rangeSchema.optional() }).strict();
export type MonitoringPromQuery = z.infer<typeof monitoringPromQuerySchema>;
/**
 * LogQL metric queries only (count_over_time, rate, sum by ...): log lines are written by anyone who can reach a site or a
 * service, so raw lines never reach the agent or Nous. The server also refuses an answer whose resultType is "streams".
 */
export const monitoringLogQuerySchema = z.object({
  query: text(1000).refine((query) => /\b(count_over_time|rate|bytes_over_time|bytes_rate|absent_over_time|sum_over_time|avg_over_time|max_over_time|min_over_time|quantile_over_time)\s*\(/.test(query),
    "Only LogQL metric queries (count_over_time, rate, ...): raw log lines are not returned.")
    // A parser or formatter stage turns line text into label values, which would carry log content out as labels.
    .refine((query) => !/\|\s*(json|logfmt|regexp|pattern|unpack|label_format|line_format|decolorize)\b/i.test(query),
      "No parser or formatter stages (| json, | logfmt, | regexp, | pattern, | unpack, | label_format, | line_format): they turn log text into labels. Filter with |= or |~ and count."),
  range: rangeSchema.optional()
}).strict();
export type MonitoringLogQuery = z.infer<typeof monitoringLogQuerySchema>;
/** One series of a query answer: labels and [unix seconds, value] points (an instant answer has one point). */
export const monitoringSeriesSchema = z.object({
  labels: z.record(z.string(), z.string()),
  points: z.array(z.tuple([z.number(), z.string()]))
}).strict();
export type MonitoringSeries = z.infer<typeof monitoringSeriesSchema>;

// ---- memory (the copilot's own, separate from Space Memory) --------------------------------------
export const MONITORING_MEMORY_KINDS = ["HOST", "RULE", "FACT", "LESSON", "EXCEPTION", "PLAYBOOK", "PREFERENCE"] as const;
export const monitoringMemoryKindSchema = z.enum(MONITORING_MEMORY_KINDS);
export const monitoringMemoryIdSchema = idOf("monmem");
export const monitoringMemorySchema = z.object({
  id: monitoringMemoryIdSchema,
  ownerUserId: z.string().min(1).max(200),
  kind: monitoringMemoryKindSchema,
  key: z.string().min(1).max(300).nullable(),
  text: z.string().min(1).max(MONITORING_TEXT_MAX),
  /** An instance or host the memory is about (e.g. "192.0.2.2:9100" or "pve"), or null for everything. */
  target: z.string().min(1).max(200).nullable(),
  tags: z.array(z.string().min(1).max(60)).max(20),
  source: z.enum(["USER", "AGENT"]),
  pinned: z.boolean(),
  uses: z.number().int().min(0),
  lastUsedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type MonitoringMemory = z.infer<typeof monitoringMemorySchema>;
export const monitoringMemoryCreateSchema = z.object({
  kind: monitoringMemoryKindSchema,
  key: z.string().trim().min(1).max(300).optional(),
  text: text(),
  target: z.string().trim().min(1).max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  pinned: z.boolean().default(false)
}).strict();
export const monitoringMemoryUpdateSchema = z.object({
  text: text().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  pinned: z.boolean().optional()
}).strict();

// ---- the pane's feed -----------------------------------------------------------------------------
export const monitoringEventIdSchema = idOf("monevt");
/**
 * One feed per pane: a BRIEF (operator or Nous → agent), a QUESTION (agent → operator) and a REVIEW (a self-healing action the gate
 * held for a person, Phase 4) carry a status; the rest is the activity timeline (ALERT: a critical alert fired or resolved; GUARDIAN:
 * a guardian relay message).
 */
export const MONITORING_EVENT_TYPES = [
  "BRIEF", "QUESTION", "REVIEW", "ANSWERED", "REVIEWED", "BRIEF_DONE", "BRIEF_FAILED", "ALERT", "GUARDIAN", "ACTION", "NOTE", "DIGEST",
  "SETTINGS_CHANGED", "RUN_STARTED", "RUN_PAUSED", "RUN_STOPPED"
] as const;
export const monitoringEventTypeSchema = z.enum(MONITORING_EVENT_TYPES);
export type MonitoringEventType = z.infer<typeof monitoringEventTypeSchema>;
export const monitoringEventStatusSchema = z.enum(["PENDING", "TAKEN", "DONE", "FAILED", "OPEN", "ANSWERED", "APPROVED", "DECLINED"]);
export type MonitoringEventStatus = z.infer<typeof monitoringEventStatusSchema>;
export const monitoringEventSchema = z.object({
  id: monitoringEventIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: idOf("pane"),
  type: monitoringEventTypeSchema,
  status: monitoringEventStatusSchema.nullable(),
  message: z.string().min(1).max(2000),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type MonitoringEvent = z.infer<typeof monitoringEventSchema>;
export const monitoringBriefCreateSchema = z.object({ text: text(2000) }).strict();
export const monitoringAnswerSchema = z.object({ answer: text(2000) }).strict();
export const monitoringReviewDecisionSchema = z.object({ approve: z.boolean(), note: z.string().trim().max(1000).optional() }).strict();
/** The run follows the newest RUN_* event: no event yet reads as IDLE. */
export type MonitoringRunStatus = "IDLE" | "RUNNING" | "PAUSED" | "STOPPED";

/** What the watcher knows about the collector (in memory; a restart starts unknown). */
export const monitoringCollectorStatusSchema = z.object({
  reachable: z.boolean().nullable(),
  lastOkAt: isoDateTime.nullable(),
  lastError: z.string().max(300).nullable(),
  downSince: isoDateTime.nullable()
}).strict();
export type MonitoringCollectorStatus = z.infer<typeof monitoringCollectorStatusSchema>;

// ---- self-healing actions (Phase 4: the gate every change on a host goes through) ------------------
/**
 * What the copilot may do to bring a service back, from the operator's former n8n self-healing flows (public-host start, MariaDB and
 * LiteSpeed restarts with checks after): GO kinds run on their own when the pane is fully autonomous and the change names an alert
 * that still fires; HOST_REBOOT, DATA_DELETE and OTHER always wait for a person.
 */
export const MONITORING_ACTION_KINDS = ["SERVICE_RESTART", "GUEST_START", "CONFIG_CHANGE", "CACHE_CLEAR", "HOST_REBOOT", "DATA_DELETE", "OTHER"] as const;
export const monitoringActionKindSchema = z.enum(MONITORING_ACTION_KINDS);
export type MonitoringActionKind = z.infer<typeof monitoringActionKindSchema>;
export const MONITORING_ALWAYS_ASK_KINDS: readonly MonitoringActionKind[] = ["HOST_REBOOT", "DATA_DELETE", "OTHER"];
/** Kinds whose `backup` must name what restores the host (a copy of the file, a snapshot). */
export const MONITORING_BACKUP_KINDS: readonly MonitoringActionKind[] = ["CONFIG_CHANGE"];
/** At most this many autonomous changes per target and hour; one RUNNING change per target at a time. */
export const MONITORING_MAX_ACTIONS_PER_TARGET_HOUR = 4;
export const MONITORING_ACTION_STATUSES = ["RUNNING", "ASKED", "APPROVED", "DECLINED", "VERIFIED", "FAILED", "ROLLED_BACK"] as const;
export const monitoringActionStatusSchema = z.enum(MONITORING_ACTION_STATUSES);
export type MonitoringActionStatus = z.infer<typeof monitoringActionStatusSchema>;
export const monitoringActionIdSchema = idOf("monact");
/** Where a change runs: `local` (public-host), `pve`, `qm:<vmid>`, `pct:<ctid>` or an SSH alias (the same reach the Security Copilot uses). */
export const monitoringTargetSchema = z.string().regex(/^(local|pve|qm:\d{2,6}|pct:\d{2,6}|[A-Za-z][A-Za-z0-9_.-]{0,62})$/);

export const monitoringActionSchema = z.object({
  id: monitoringActionIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: idOf("pane"),
  target: monitoringTargetSchema,
  alertIds: z.array(monitoringAlertIdSchema).max(20),
  kind: monitoringActionKindSchema,
  summary: z.string().min(1).max(500),
  commands: z.string().min(1).max(MONITORING_TEXT_MAX),
  backup: z.string().max(1000),
  rollback: z.string().max(2000),
  /** GO: the gate let it run; ASK: it waits for a person (the review event). */
  gate: z.enum(["GO", "ASK"]),
  reason: z.string().max(500).nullable(),
  status: monitoringActionStatusSchema,
  verification: z.string().max(MONITORING_TEXT_MAX).nullable(),
  reviewEventId: monitoringEventIdSchema.nullable(),
  startedAt: isoDateTime,
  finishedAt: isoDateTime.nullable()
}).strict();
export type MonitoringAction = z.infer<typeof monitoringActionSchema>;
export const monitoringActionBeginSchema = z.object({
  target: monitoringTargetSchema,
  alertIds: z.array(monitoringAlertIdSchema).max(20).default([]),
  kind: monitoringActionKindSchema,
  summary: text(500),
  commands: text(),
  backup: z.string().trim().max(1000).default(""),
  rollback: z.string().trim().max(2000).default("")
}).strict();
export type MonitoringActionBegin = z.infer<typeof monitoringActionBeginSchema>;
export const monitoringActionFinishSchema = z.object({
  status: z.enum(["VERIFIED", "FAILED", "ROLLED_BACK"]),
  verification: text()
}).strict();
