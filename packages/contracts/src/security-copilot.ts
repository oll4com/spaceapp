import { z } from "zod";

// Security Copilot pane (plan clipboard:8ce8_URHW9Dk, operator request 2026-10-24): Space watches public vulnerability feeds
// around the clock and matches them to what every Proxmox host runs; the pane's CLI agent inventories the hosts over SSH and
// fixes what a finding needs, always through one server gate (beginAction/finishAction). Operator decisions 2026-10-24: the
// whole Proxmox fleet, fully autonomous fixes except deletes and payments, executed from the pane over the existing SSH paths.
// The Browser Host parses every pane row with the contracts it loaded at start, so every metadata field is declared up front.
export const SECURITY_COPILOT_PANE_MODE = "SECURITY_COPILOT" as const;

const idOf = (prefix: string) => z.string().regex(new RegExp(`^${prefix}:[A-Za-z0-9_-]{6,80}$`));
const isoDateTime = z.string().datetime({ offset: true });
export const SECURITY_TEXT_MAX = 4000;
const text = (max = SECURITY_TEXT_MAX) => z.string().trim().min(1).max(max);

// ---- pane metadata ------------------------------------------------------------------------------
/** ASSIST: every action asks the operator. FULL (operator decision 2026-10-24): the gate's GO kinds run on their own. */
export const SECURITY_AUTONOMY_LEVELS = ["ASSIST", "FULL"] as const;
export const securityAutonomySchema = z.enum(SECURITY_AUTONOMY_LEVELS);
export type SecurityAutonomy = z.infer<typeof securityAutonomySchema>;
export const securityHostIdSchema = idOf("sechost");

export const securityCopilotPaneSettingsSchema = z.object({
  /** The agent takes no new work and the gate answers no GO while paused. */
  paused: z.boolean().default(false),
  autonomy: securityAutonomySchema.default("FULL"),
  /** Hosts the copilot leaves alone (no inventory, no action). */
  excludedHosts: z.array(securityHostIdSchema).max(100).default([]),
  /** Public IPv4 addresses Shodan's InternetDB is asked about, each with the host alias that serves it. */
  publicAddresses: z.array(z.object({ ip: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/), alias: z.string().regex(/^(local|pve|qm:\d{2,6}|pct:\d{2,6}|[A-Za-z][A-Za-z0-9_.-]{0,62})$/) }).strict()).max(20).default([]),
  notifications: z.object({
    needsYou: z.boolean().default(true),
    fixed: z.boolean().default(true),
    telegram: z.boolean().default(false)
  }).strict().default({ needsYou: true, fixed: true, telegram: false })
}).strict();
export type SecurityCopilotPaneSettings = z.infer<typeof securityCopilotPaneSettingsSchema>;

export const securityCopilotPaneMetadataSchema = z.object({
  version: z.literal(1),
  settings: securityCopilotPaneSettingsSchema
}).strict();
export type SecurityCopilotPaneMetadata = z.infer<typeof securityCopilotPaneMetadataSchema>;

export function defaultSecurityCopilotPaneMetadata(): SecurityCopilotPaneMetadata {
  return securityCopilotPaneMetadataSchema.parse({ version: 1, settings: {} });
}
/** Panes never configured read as defaults. */
export function resolveSecurityCopilotPaneMetadata(metadata: SecurityCopilotPaneMetadata | null | undefined): SecurityCopilotPaneMetadata {
  return metadata ? securityCopilotPaneMetadataSchema.parse(metadata) : defaultSecurityCopilotPaneMetadata();
}

// ---- hosts and inventory ------------------------------------------------------------------------
/** How the agent reaches a host from public-host (the same paths the operator's agents use today). */
export const SECURITY_HOST_REACHES = ["LOCAL", "SSH", "PVE_SHELL", "QM_GUEST_EXEC", "PCT_EXEC", "NONE"] as const;
export const SECURITY_OS_FAMILIES = ["DEBIAN", "UBUNTU", "ALMALINUX", "PROXMOX", "OPENWRT", "WINDOWS", "MACOS", "UNKNOWN"] as const;
export const SECURITY_HOST_STATUSES = ["ACTIVE", "STOPPED", "UNREACHABLE"] as const;
export const securityHostReachSchema = z.enum(SECURITY_HOST_REACHES);
export const securityOsFamilySchema = z.enum(SECURITY_OS_FAMILIES);
export const securityHostStatusSchema = z.enum(SECURITY_HOST_STATUSES);

/** An SSH alias, `local`, `pve`, `qm:<vmid>` or `pct:<ctid>`: the key the collector takes. */
export const securityHostAliasSchema = z.string().regex(/^(local|pve|qm:\d{2,6}|pct:\d{2,6}|[A-Za-z][A-Za-z0-9_.-]{0,62})$/);
// Strict shapes for everything a guest prints: a compromised guest must not smuggle text into the agent's context.
const packageName = z.string().regex(/^[A-Za-z0-9@][A-Za-z0-9@+._:~/-]{0,199}$/);
const packageVersion = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9+._:~-]{0,119}$/);
const advisoryRef = z.string().regex(/^[A-Z][A-Z0-9]{1,15}-[A-Za-z0-9:._-]{1,60}$/);
export const securityProductSchema = z.enum(["php", "node", "openssh", "nginx", "openssl", "linux_kernel", "proxmox_ve", "plesk", "chrome", "postgresql", "docker"]);
export type SecurityProduct = z.infer<typeof securityProductSchema>;

export const securityInventorySchema = z.object({
  alias: securityHostAliasSchema,
  label: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,79}$/),
  reach: securityHostReachSchema,
  os: z.object({ family: securityOsFamilySchema, version: z.string().regex(/^[A-Za-z0-9._-]{0,40}$/), kernel: z.string().regex(/^[A-Za-z0-9+._-]{0,80}$/) }).strict(),
  /** Distro packages: dpkg carries the source package (OSV's Debian names), rpm the source rpm name. */
  packages: z.array(z.object({ name: packageName, version: packageVersion, source: packageName.optional(), sourceVersion: packageVersion.optional() }).strict()).max(20_000),
  /** Software outside a distro's security metadata (Plesk PHP builds, /usr/local Node, CLIs, Chrome ...). */
  products: z.array(z.object({ product: securityProductSchema, version: packageVersion, path: z.string().regex(/^\/[A-Za-z0-9._/+-]{0,199}$/).optional() }).strict()).max(200),
  /** npm and PyPI packages of SpaceApp's own lockfiles and venvs. */
  libraries: z.array(z.object({ ecosystem: z.enum(["npm", "PyPI"]), name: packageName, version: packageVersion, from: z.string().regex(/^\/[A-Za-z0-9._/+-]{0,199}$/) }).strict()).max(20_000),
  /** Updates the host's own package manager marks as security fixes (apt security origin, dnf updateinfo --security --with-cve). */
  pendingSecurity: z.array(z.object({ package: packageName, version: packageVersion.optional(), advisory: advisoryRef.optional(),
    cves: z.array(z.string().regex(/^CVE-\d{4}-\d{4,8}$/)).max(100).default([]), severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]).default("UNKNOWN") }).strict()).max(5000),
  listening: z.array(z.number().int().min(1).max(65535)).max(500),
  rebootRequired: z.boolean().default(false)
}).strict();
export type SecurityInventory = z.infer<typeof securityInventorySchema>;

export const securityHostSchema = z.object({
  id: securityHostIdSchema,
  ownerUserId: z.string().min(1).max(200),
  alias: securityHostAliasSchema,
  label: z.string().min(1).max(80),
  reach: securityHostReachSchema,
  osFamily: securityOsFamilySchema,
  osVersion: z.string().max(40),
  kernel: z.string().max(80),
  status: securityHostStatusSchema,
  /** The latest inventory as the collector sent it (replaced each time). */
  inventory: securityInventorySchema.nullable(),
  inventoryAt: isoDateTime.nullable(),
  note: z.string().max(1000).nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type SecurityHost = z.infer<typeof securityHostSchema>;

// ---- findings -----------------------------------------------------------------------------------
/** P0: known exploited (CISA KEV) or exploited in the wild; P1 critical; P2 high; P3 the rest. */
export const SECURITY_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export const securityPrioritySchema = z.enum(SECURITY_PRIORITIES);
export type SecurityPriority = z.infer<typeof securityPrioritySchema>;
export const SECURITY_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
export const securitySeveritySchema = z.enum(SECURITY_SEVERITIES);
export type SecuritySeverity = z.infer<typeof securitySeveritySchema>;
/** NEWS alone is a lead: it needs a structured source or a vendor page the server checked before the gate answers GO. */
export const SECURITY_ADVISORY_SOURCES = ["KEV", "OSV", "NVD", "DISTRO", "EPSS", "INTERNETDB", "NEWS", "VENDOR"] as const;
export const securityAdvisorySourceSchema = z.enum(SECURITY_ADVISORY_SOURCES);
export type SecurityAdvisorySource = z.infer<typeof securityAdvisorySourceSchema>;
export const SECURITY_FINDING_STATUSES = ["NEW", "TRIAGING", "FIXING", "FIXED", "MITIGATED", "NOT_AFFECTED", "ACCEPTED", "FAILED"] as const;
export const securityFindingStatusSchema = z.enum(SECURITY_FINDING_STATUSES);
export type SecurityFindingStatus = z.infer<typeof securityFindingStatusSchema>;
export const SECURITY_OPEN_FINDING_STATUSES: readonly SecurityFindingStatus[] = ["NEW", "TRIAGING", "FIXING", "FAILED"];
export const securityFindingIdSchema = idOf("secfind");

/** Structured fields only: no free description text from third parties reaches the agent. */
export const securityAdvisorySchema = z.object({
  id: z.string().min(3).max(120),
  aliases: z.array(z.string().max(120)).max(40).default([]),
  sources: z.array(securityAdvisorySourceSchema).min(1).max(SECURITY_ADVISORY_SOURCES.length),
  title: z.string().max(300),
  severity: securitySeveritySchema,
  cvss: z.number().min(0).max(10).nullable().default(null),
  epss: z.number().min(0).max(1).nullable().default(null),
  kev: z.boolean().default(false),
  kevAddedAt: z.string().max(40).nullable().default(null),
  publishedAt: z.string().max(40).nullable().default(null),
  references: z.array(z.string().url().max(500)).max(20).default([])
}).strict();
export type SecurityAdvisory = z.infer<typeof securityAdvisorySchema>;

export const securityFindingSchema = z.object({
  id: securityFindingIdSchema,
  ownerUserId: z.string().min(1).max(200),
  hostId: securityHostIdSchema,
  /** The advisory's key: a CVE id when there is one, else the distro or OSV id. */
  advisoryId: z.string().min(3).max(120),
  advisory: securityAdvisorySchema,
  package: z.string().min(1).max(200),
  installedVersion: z.string().max(120),
  fixedVersion: z.string().max(120).nullable(),
  priority: securityPrioritySchema,
  status: securityFindingStatusSchema,
  /** A vendor page on an allowlisted domain the server fetched and found the advisory id on (confirms a NEWS lead). */
  confirmedBy: z.string().url().max(500).nullable(),
  note: z.string().max(2000).nullable(),
  firstSeenAt: isoDateTime,
  lastSeenAt: isoDateTime,
  closedAt: isoDateTime.nullable()
}).strict();
export type SecurityFinding = z.infer<typeof securityFindingSchema>;

export const securityFindingUpdateSchema = z.object({
  status: z.enum(["TRIAGING", "FIXING", "MITIGATED", "NOT_AFFECTED", "ACCEPTED", "FIXED"]),
  note: text(2000)
}).strict();

// ---- actions (the gate) -------------------------------------------------------------------------
export const SECURITY_ACTION_KINDS = [
  "PACKAGE_UPGRADE", "SERVICE_RESTART", "CONFIG_CHANGE", "WAF_RULE", "CONTAINER_UPDATE", "CODE_FIX",
  "HOST_REBOOT", "SESSION_ENDING_RESTART", "DATA_DELETE", "OTHER"
] as const;
export const securityActionKindSchema = z.enum(SECURITY_ACTION_KINDS);
export type SecurityActionKind = z.infer<typeof securityActionKindSchema>;
/** Kinds that ask the operator whatever the autonomy (deletes; reboots; restarts that end the operator's sessions; free-form commands). */
export const SECURITY_ALWAYS_ASK_KINDS: readonly SecurityActionKind[] = ["HOST_REBOOT", "SESSION_ENDING_RESTART", "DATA_DELETE", "OTHER"];
/** Kinds whose `backup` must name what restores the host (a snapshot, a backup file, the package's old version). */
export const SECURITY_BACKUP_KINDS: readonly SecurityActionKind[] = ["PACKAGE_UPGRADE", "CONFIG_CHANGE", "WAF_RULE", "CONTAINER_UPDATE"];
/** At most this many actions the gate lets run on its own per host and hour; one RUNNING action per host at a time. */
export const SECURITY_MAX_ACTIONS_PER_HOST_HOUR = 6;
export const SECURITY_ACTION_STATUSES = ["RUNNING", "ASKED", "APPROVED", "DECLINED", "VERIFIED", "FAILED", "ROLLED_BACK"] as const;
export const securityActionStatusSchema = z.enum(SECURITY_ACTION_STATUSES);
export type SecurityActionStatus = z.infer<typeof securityActionStatusSchema>;
export const securityActionIdSchema = idOf("secact");

export const securityActionSchema = z.object({
  id: securityActionIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: idOf("pane"),
  hostId: securityHostIdSchema.nullable(),
  findingIds: z.array(securityFindingIdSchema).max(50),
  kind: securityActionKindSchema,
  summary: z.string().min(1).max(500),
  commands: z.string().min(1).max(SECURITY_TEXT_MAX),
  backup: z.string().max(1000),
  rollback: z.string().max(2000),
  /** GO: the gate let it run; ASK: it waits for a person (the review event). */
  gate: z.enum(["GO", "ASK"]),
  reason: z.string().max(500).nullable(),
  status: securityActionStatusSchema,
  verification: z.string().max(SECURITY_TEXT_MAX).nullable(),
  reviewEventId: idOf("secevt").nullable(),
  startedAt: isoDateTime,
  finishedAt: isoDateTime.nullable()
}).strict();
export type SecurityAction = z.infer<typeof securityActionSchema>;

export const securityActionBeginSchema = z.object({
  hostId: securityHostIdSchema.nullable(),
  findingIds: z.array(securityFindingIdSchema).max(50).default([]),
  kind: securityActionKindSchema,
  summary: text(500),
  commands: text(),
  backup: z.string().trim().max(1000).default(""),
  rollback: z.string().trim().max(2000).default("")
}).strict();
export type SecurityActionBegin = z.infer<typeof securityActionBeginSchema>;
export const securityActionFinishSchema = z.object({
  status: z.enum(["VERIFIED", "FAILED", "ROLLED_BACK"]),
  verification: text()
}).strict();

// ---- memory (the copilot's own, separate from Space Memory) --------------------------------------
export const SECURITY_MEMORY_KINDS = ["HOST", "RULE", "FACT", "LESSON", "EXCEPTION", "PLAYBOOK", "PREFERENCE"] as const;
export const securityMemoryKindSchema = z.enum(SECURITY_MEMORY_KINDS);
export const securityMemoryIdSchema = idOf("secmem");
export const securityMemorySchema = z.object({
  id: securityMemoryIdSchema,
  ownerUserId: z.string().min(1).max(200),
  kind: securityMemoryKindSchema,
  key: z.string().min(1).max(300).nullable(),
  text: z.string().min(1).max(SECURITY_TEXT_MAX),
  hostId: securityHostIdSchema.nullable(),
  tags: z.array(z.string().min(1).max(60)).max(20),
  source: z.enum(["USER", "AGENT"]),
  pinned: z.boolean(),
  uses: z.number().int().min(0),
  lastUsedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type SecurityMemory = z.infer<typeof securityMemorySchema>;
export const securityMemoryCreateSchema = z.object({
  kind: securityMemoryKindSchema,
  key: z.string().trim().min(1).max(300).optional(),
  text: text(),
  hostId: securityHostIdSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  pinned: z.boolean().default(false)
}).strict();
export const securityMemoryUpdateSchema = z.object({
  text: text().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  pinned: z.boolean().optional()
}).strict();

// ---- the pane's feed -----------------------------------------------------------------------------
export const securityEventIdSchema = idOf("secevt");
/**
 * One feed per pane: a BRIEF (operator or Nous → agent), a QUESTION (agent → operator) and a REVIEW (an action the gate held for a
 * person) carry a status; the rest is the activity timeline.
 */
export const SECURITY_EVENT_TYPES = [
  "BRIEF", "QUESTION", "REVIEW", "ANSWERED", "REVIEWED", "BRIEF_DONE", "BRIEF_FAILED", "FINDINGS", "ACTION", "NOTE", "DIGEST",
  "SETTINGS_CHANGED", "RUN_STARTED", "RUN_PAUSED", "RUN_STOPPED"
] as const;
export const securityEventTypeSchema = z.enum(SECURITY_EVENT_TYPES);
export type SecurityEventType = z.infer<typeof securityEventTypeSchema>;
export const securityEventStatusSchema = z.enum(["PENDING", "TAKEN", "DONE", "FAILED", "OPEN", "ANSWERED", "APPROVED", "DECLINED"]);
export type SecurityEventStatus = z.infer<typeof securityEventStatusSchema>;
export const securityEventSchema = z.object({
  id: securityEventIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: idOf("pane"),
  type: securityEventTypeSchema,
  status: securityEventStatusSchema.nullable(),
  message: z.string().min(1).max(2000),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type SecurityEvent = z.infer<typeof securityEventSchema>;
export const securityBriefCreateSchema = z.object({ text: text(2000) }).strict();
export const securityAnswerSchema = z.object({ answer: text(2000) }).strict();
export const securityReviewDecisionSchema = z.object({ approve: z.boolean(), note: z.string().trim().max(1000).optional() }).strict();
/** The run follows the newest RUN_* event: no event yet reads as IDLE. */
export type SecurityRunStatus = "IDLE" | "RUNNING" | "PAUSED" | "STOPPED";

// ---- vendor pages the agent may read (space_security_read_advisory) ---------------------------------
/**
 * Pages the vendor or the authority writes itself, by exact host and path (security review 2026-10-24): never a whole domain, which
 * would admit forums, bug trackers and mailing-list archives anyone can write into (forum.proxmox.com, lists.debian.org, ...).
 */
export const SECURITY_ADVISORY_PAGES: ReadonlyArray<readonly [host: string, pathPrefix: string]> = [
  ["www.debian.org", "/security/"], ["security-tracker.debian.org", "/tracker/"], ["errata.almalinux.org", "/"], ["ubuntu.com", "/security/"],
  ["www.php.net", "/ChangeLog"], ["www.php.net", "/releases/"], ["docs.plesk.com", "/release-notes/"], ["pve.proxmox.com", "/pve-docs/"],
  ["nginx.org", "/en/security_advisories.html"], ["nginx.org", "/en/CHANGES"], ["openssl-library.org", "/news/"], ["www.openssh.com", "/releasenotes.html"],
  ["www.openssh.com", "/security.html"], ["nodejs.org", "/en/blog/vulnerability/"], ["nodejs.org", "/en/blog/release/"], ["chromereleases.googleblog.com", "/20"],
  ["www.cisa.gov", "/known-exploited-vulnerabilities-catalog"], ["nvd.nist.gov", "/vuln/detail/"], ["osv.dev", "/vulnerability/"], ["www.postgresql.org", "/support/security/"],
  ["docs.docker.com", "/security/"]
];
export function securityAdvisoryUrlAllowed(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) return false;
  const host = parsed.hostname.toLowerCase();
  return SECURITY_ADVISORY_PAGES.some(([allowedHost, prefix]) => host === allowedHost && parsed.pathname.startsWith(prefix));
}
