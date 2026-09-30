import { z } from "zod";

export const SPACE_CONTROL_VERSION = "space-control-v1";
const paneCategoryColorSchema = z.enum(["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"]).nullable();
const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(100_000);
export const controlTargetSchema = z.object({
  paneIds: z.array(id).min(1).max(64).optional(),
  runtimeId: id.optional(),
  state: z.enum(["OPEN", "CLOSED", "STOPPED", "RUNNING", "ALL"]).default("ALL")
}).strict();
export const controlPlacementSchema = z.object({ paneId: id, x: z.number().min(0).max(100),
  y: z.number().min(0).max(1000), width: z.number().positive().max(100), height: z.number().positive().max(1000)
}).strict().refine(p => p.x + p.width <= 100, "Pane exceeds canvas width.");
export const controlLayoutSchema = z.object({ mode: z.enum(["GRID", "CUSTOM"]),
  columns: z.number().int().min(0).max(4).nullable().optional().default(2),
  placements: z.array(controlPlacementSchema).max(64).default([])
}).strict().superRefine((v,c) => {
  if (new Set(v.placements.map(p=>p.paneId)).size !== v.placements.length)
    c.addIssue({code:"custom",message:"Duplicate pane placement."});
  for(let i=0;i<v.placements.length;i++) for(let j=i+1;j<v.placements.length;j++) {
    const a=v.placements[i]!,b=v.placements[j]!;
    if(a.x<b.x+b.width && b.x<a.x+a.width && a.y<b.y+b.height && b.y<a.y+a.height)
      c.addIssue({code:"custom",message:"Pane placements overlap."});
  }
});
export const controlResourceOperations = ["panes.open","panes.move","panes.split","panes.update","rooms.reorder",
 "browser.navigate","browser.back","browser.forward","browser.reload","browser.content",
 "links.list","links.create","links.update","links.delete","skills.list","skills.read",
 "tasks.list","tasks.get","tasks.create","tasks.update","tasks.delete",
 "files.publish","files.delete","media.publish","media.delete","files.preview",
 "settings.providers","settings.tools","settings.task_titles","settings.plugins","settings.voice","settings.appearance","settings.snapshot","settings.rollback","settings.update","models.list",
 "ops.status","ops.logs","ops.test","ops.verify","ops.deploy","ops.proof","access.cli",
 "ui.theme","ui.scale","asteroids.control"] as const;
export const controlVoicePreferencePatchSchema = z.object({
  enabled: z.boolean().optional(),
  model: id.optional(),
  voice: id.optional(),
  language: id.optional(),
  insertMode: z.enum(["replace", "append"]).optional(),
  prewarm: z.boolean().optional()
}).strict().refine(patch => Object.values(patch).some(value => value !== undefined), "Provide at least one voice preference.");
export const controlActionSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("resource"),operation:z.enum(controlResourceOperations),id:id.optional(),input:z.record(z.string(),z.unknown()).default({}),approvalReason:z.string().trim().min(5).max(500).optional(),confirm:z.boolean().optional(),dryRun:z.boolean().optional()}).strict(),
  z.object({kind:z.literal("room"), operation:z.enum(["rename","create","activate"]), name:id.optional(), targetRoomId:id.optional()}).strict(),
  z.object({kind:z.literal("pane"), operation:z.enum(["rename","close","reopen","restart","start","resume","stop","cancel","continue","prompt","minimize","maximize","restore","unminimize","focus","color","visual_audit"]), target:controlTargetSchema,
    captureScreenshot:z.boolean().optional(), text:text.optional(), color:paneCategoryColorSchema.optional(), when:z.enum(["NOW","AFTER_TURN"]).default("AFTER_TURN")}).strict(),
  z.object({kind:z.literal("configure"), target:controlTargetSchema, modelId:id.optional(), reasoningEffort:id.optional(), nativeMode:id.optional(), accountProfileId:id.optional(), paneId:id.optional(),
    when:z.enum(["NOW","AFTER_TURN"]).default("AFTER_TURN")}).strict(),
  z.object({kind:z.literal("layout"), operation:z.enum(["sort","apply","tree","save","restore"]),
    sortBy:z.enum(["createdAt","sessionStartedAt","taskStartedAt","title","runtimeId"]).default("createdAt"),
    direction:z.enum(["asc","desc"]).default("asc"), layout:controlLayoutSchema.optional(), snapshotId:id.optional()}).strict(),
  z.object({kind:z.literal("playback"), operation:z.enum(["play","pause","next","previous","seek","volume","mute","unmute"]),
    targetId:id.optional(), target:z.enum(["AUTO","YOUTUBE","MUSIC"]).default("AUTO"), value:z.number().min(0).max(86400).optional()}).strict(),
  z.object({kind:z.literal("cli"), runtimeId:id, enabled:z.boolean()}).strict(),
  z.object({kind:z.literal("vpn"), operation:z.enum(["set","rotate"]), runtimeId:id.optional(), enabled:z.boolean().optional(), profile:z.enum(["mullvad","nord"]).optional()}).strict(),
  z.object({kind:z.literal("clipboard"), operation:z.enum(["save","complete","delete"]), id:id.optional(),
    text:text.optional(), title:z.string().max(200).optional(), source:z.enum(["COPY","PASTE","MANUAL_NOTE","AGENT_NOTE","PLAN"]).default("MANUAL_NOTE"), completed:z.boolean().optional(),
    confirm:z.boolean().optional(), confirmed:z.boolean().optional()}).strict(),
  z.object({kind:z.literal("native_command"), target:controlTargetSchema,
    command:z.string().min(2).max(2000).regex(/^\/[a-zA-Z][a-zA-Z0-9_-]*(?: [^\x00-\x1f\x7f]*)?$/), when:z.enum(["NOW","AFTER_TURN"]).default("AFTER_TURN")}).strict(),
  z.object({kind:z.literal("watch"), operation:z.enum(["register","cancel","status","ack"]), id:id.optional(), target:controlTargetSchema.optional(), paneId:id.optional(),
    targetTaskRef:z.string().trim().min(1).max(200).optional(), timeoutMs:z.number().int().min(1000).max(3_600_000).optional(), maxRetries:z.number().int().min(0).max(3).optional(),
    verificationPrompt:z.string().max(20_000).optional(), remediationPrompt:z.string().max(20_000).optional()}).strict(),
  z.object({kind:z.literal("screenshot"), operation:z.enum(["capture"]).default("capture"),
    target:z.enum(["APP","WINDOW","SCREEN"]).default("APP"),
    format:z.enum(["jpeg","png","webp"]).default("jpeg"),
    quality:z.number().min(1).max(100).default(80),
    maxWidth:z.number().int().min(320).max(3840).optional(),
    maxHeight:z.number().int().min(240).max(2160).optional()}).strict()
]);
export const controlExecuteSchema = z.object({roomId:id, requestId:id,
  expectedRevision:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  waitForCompletion:z.boolean().optional(),
  dryRun:z.boolean().optional(),
  userExplicitlyAuthorized:z.boolean().optional(),
  actions:z.array(controlActionSchema).min(1).max(32)
}).strict().superRefine((v,c) => {
  const audits = v.actions.filter(a => a.kind === "pane" && a.operation === "visual_audit");
  if (audits.length && (v.actions.length !== 1 || v.expectedRevision))
    c.addIssue({code:"custom",message:"Visual audit requires one isolated action without a mutation revision."});
  for (const a of v.actions) if (a.kind === "pane") {
    if (a.operation === "visual_audit" && (a.target.paneIds?.length !== 1 || a.target.runtimeId || a.target.state !== "ALL" || a.text !== undefined || a.color !== undefined))
      c.addIssue({code:"custom",message:"Visual audit requires exactly one explicit pane ID and no mutation fields."});
    if (a.operation !== "visual_audit" && a.captureScreenshot !== undefined)
      c.addIssue({code:"custom",message:"captureScreenshot is only valid for visual_audit."});
  }
}).refine(v=>JSON.stringify(v).length<=500_000,"Control request is too large.");
export const controlInspectSections = [
  "STATE", "CONTENT", "MODELS", "QUOTA", "RUNTIMES", "VPN", "CLIPBOARD",
  "FILES", "MEDIA", "SKILLS", "SETTINGS", "ROOMS",
  "SYSTEM_HEALTH", "PLUGINS", "MODULES", "VOICE", "LINKS", "TASKS", "AUDIT", "TERMINAL_RENDER"
] as const;
export const controlInspectSchema = z.object({roomId:id.optional(),
  section:z.enum(controlInspectSections).default("STATE"),
  paneId:id.optional(), query:z.string().max(500).optional(), offset:z.number().int().min(0).default(0), limit:z.number().int().min(1).max(100).default(25)
}).strict();
export const controlResultSchema=z.object({index:z.number().int().min(0), paneId:id.optional(),
  status:z.enum(["COMPLETED","PENDING","FAILED","CANCELLED","UNKNOWN"]), detail:z.string().max(2000), error:z.string().max(2000).optional(), evidence:z.record(z.string(),z.unknown()).default({})});
export const controlOperationSchema=z.object({id, actorId:id, roomId:id, requestId:id, payloadHash:z.string(),
  status:z.enum(["RUNNING","COMPLETED","PARTIAL","FAILED","CANCELLED","UNKNOWN"]),
  createdAt:z.string(),updatedAt:z.string(), results:z.array(controlResultSchema), cancelRequested:z.boolean().default(false),
  command:controlExecuteSchema.optional(),nextIndex:z.number().int().min(0).default(0)});
export const controlScheduleSchema=z.object({id,actorId:id,roomId:id,dueAt:z.iso.datetime(),command:controlExecuteSchema,
  status:z.enum(["SCHEDULED","RUNNING","COMPLETED","CANCELLED","BLOCKED"]),
  expectedTasks:z.record(z.string(),z.string().nullable()).default({}),
  expectedModels:z.record(z.string(),z.string().nullable()).default({}),
  stopVersions:z.record(z.string(),z.number().int().min(0)).default({}),
  condition:z.enum(["AT_TIME","AFTER_TURN"]).default("AT_TIME"),
  parentOperationId:id.optional(),
  operationId:id.optional(),createdAt:z.string(),reason:z.string().nullable().default(null)});
export const controlWatchAuditEntrySchema = z.object({
  timestamp: z.string(),
  status: z.string(),
  detail: z.string(),
  evidence: z.record(z.string(), z.unknown()).default({})
}).strict();
export const controlWatchPaneDetailsSchema = z.object({
  paneId: z.string(),
  title: z.string().default(""),
  runtimeId: z.string().nullable().default(null),
  modelId: z.string().nullable().default(null),
  state: z.string().default("IDLE"),
  status: z.string().default("COMPLETED"),
  statusReason: z.string().nullable().default(null),
  durationMs: z.number().nullable().default(null),
  lastOutput: z.string().default(""),
  summary: z.string().default(""),
  commands: z.array(z.string()).default([]),
  nativeTaskRef: z.string().nullable().default(null)
}).strict();
export const controlWatchSchema = z.object({
  id: id,
  actorId: id,
  roomId: id,
  paneId: id,
  targetTaskRef: z.string().trim().min(1).max(200).nullable().default(null),
  submission: z.object({ startedAt: z.string(), previousTaskIds: z.array(z.string()).max(256), turnId: z.string().nullable() }).optional(),
  status: z.enum(["PENDING", "RUNNING", "VERIFYING", "VERIFIED", "FAILED", "BLOCKED", "CANCELLED"]),
  reason: z.string().max(2000).nullable().default(null),
  taskState: z.enum(["UNKNOWN", "RUNNING", "COMPLETED", "FAILED", "INTERRUPTED", "TIMED_OUT", "WAITING_FOR_INPUT"]).default("UNKNOWN"),
  maxRetries: z.number().int().min(0).max(3).default(1),
  retriesCount: z.number().int().min(0).default(0),
  timeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000),
  verificationPrompt: z.string().max(20_000).optional(),
  remediationPrompt: z.string().max(20_000).optional(),
  auditTrail: z.array(controlWatchAuditEntrySchema).default([]),
  voiceDelivery: z.object({
    queued: z.boolean().default(false),
    delivered: z.boolean().default(false),
    deliveredAt: z.string().nullable().default(null),
    acknowledged: z.boolean().default(false),
    acknowledgedAt: z.string().nullable().default(null)
  }).strict().default({
    queued: false,
    delivered: false,
    deliveredAt: null,
    acknowledged: false,
    acknowledgedAt: null
  }),
  paneDetails: controlWatchPaneDetailsSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string()
}).strict();
export type ControlAction=z.infer<typeof controlActionSchema>;
export type ControlExecute=z.infer<typeof controlExecuteSchema>;
export type ControlInspect=z.infer<typeof controlInspectSchema>;
export type ControlLayout=z.infer<typeof controlLayoutSchema>;
export type ControlOperation=z.infer<typeof controlOperationSchema>;
export type ControlResult=z.infer<typeof controlResultSchema>;
export type ControlSchedule=z.infer<typeof controlScheduleSchema>;
export type ControlTarget=z.infer<typeof controlTargetSchema>;
export type ControlWatch=z.infer<typeof controlWatchSchema>;
export type ControlWatchAuditEntry=z.infer<typeof controlWatchAuditEntrySchema>;
export type ControlWatchPaneDetails=z.infer<typeof controlWatchPaneDetailsSchema>;

export const roomControlActionSchema=z.object({type:z.literal("CONTROL"),actions:z.array(controlActionSchema).min(1).max(32)}).strict();
export const controlToolSchemas = {
  space_capabilities: z.object({roomId:id.optional()}).strict(),
  space_inspect:controlInspectSchema,
  space_execute:controlExecuteSchema,
  space_operations:z.object({roomId:id,id:id.optional(),operation:z.enum(["list","get","cancel"]).default("list")}).strict(),
  space_schedules:z.object({roomId:id,id:id.optional(),operation:z.enum(["list","create","cancel"]).default("list"),dueAt:z.iso.datetime().optional(),command:controlExecuteSchema.optional()}).strict(),
  space_watches:z.object({
    roomId:id,
    operation:z.enum(["list","register","status","cancel","ack"]).default("list"),
    id:id.optional(),
    paneId:id.optional(),
    targetTaskRef:z.string().trim().min(1).max(200).optional(),
    timeoutMs:z.number().int().min(1000).max(3_600_000).optional(),
    maxRetries:z.number().int().min(0).max(3).optional(),
    verificationPrompt:z.string().max(20_000).optional(),
    remediationPrompt:z.string().max(20_000).optional()
  }).strict(),
  space_screenshot: z.object({
    roomId: id,
    format: z.enum(["jpeg", "png", "webp"]).default("jpeg"),
    quality: z.number().min(1).max(100).default(80),
    maxWidth: z.number().int().min(320).max(3840).optional(),
    maxHeight: z.number().int().min(240).max(2160).optional(),
    query: z.string().max(2000).optional()
  }).strict(),
  space_test_mcp_tools: z.object({
    roomId: id.optional(),
    tools: z.array(z.string()).optional(),
    fast: z.boolean().default(true)
  }).strict(),
  space_list_mcp_tools: z.object({
    category: z.enum(["all", "voice", "mcp", "resources"]).default("all")
  }).strict(),
  space_describe_pane_types: z.object({
    roomId: id.optional()
  }).strict(),
  space_debug: z.object({
    roomId: id.optional(),
    operation: z.string().optional(),
    paneId: id.optional(),
    query: z.string().optional()
  }).strict()
};
export const controlToolDescriptions = {
  space_capabilities:"Discover actual Space room controls and runtime support before targeting panes.",
  space_inspect:"Read authoritative room state, positions, times, content and available model/runtime information.",
  space_execute:"Apply one validated batch of Space controls. Preserve task identity on reopen. Returns verified per-target outcomes; pending is not completion.",
  space_screenshot:"Capture full-screen visual state of the Space App for vision analysis when the user asks to see or inspect the screen.",
  space_operations:"Inspect or cancel durable operations belonging to the authenticated operator.",
  space_schedules:"Create explicit one-shot schedules or inspect/cancel them. Automatic policies are not enabled.",
  space_watches:"Durable room/task completion watch jobs for realtime voice assistant re-engagement, independent verification, and bounded remediation.",
  space_test_mcp_tools:"Run an automated 1-by-1 health and capability verification of all Space Control MCP tools and inspect sections.",
  space_list_mcp_tools:"List all available Space Control MCP and Voice tools with their descriptions and usage patterns.",
  space_describe_pane_types:"List pane types with open keys and live availability.",
  space_debug:"Run diagnostics on any Space operation, room, or pane, investigate errors, and generate developer agent handoff prompts."
};

export interface ControlActionCatalogItem {
  domain: "panes" | "navigation" | "browser" | "links" | "tasks" | "files" | "settings" | "voice" | "plugins" | "layout" | "playback" | "operations" | "system" | "room" | "clipboard" | "watches" | "screenshot";
  action: string;
  description: string;
  requiredPermission: "OPERATOR_READ" | "OPERATOR_WRITE" | "ADMIN_WRITE";
  isDestructive: boolean;
  supportsDryRun: boolean;
  supportsRollback: boolean;
  parameters: Record<string, { type: string; required: boolean; description: string }>;
  voiceIntents: string[];
}

// Advertise gaps explicitly. Recognizing an action name does not mean that an
// authenticated, verifiable execution adapter exists for it.
export const controlUnavailableResources: Partial<Record<(typeof controlResourceOperations)[number], string>> = {
  "settings.plugins": "Plugin enable/disable is unavailable through Control. Use the authenticated Plugins settings; disconnecting is not a reversible enable/disable switch.",
  "settings.rollback": "Settings snapshots are sanitized observations, not restorable backups. Rollback is unavailable; no settings were restored."
};

export interface ControlInspectSectionItem {
  section: (typeof controlInspectSections)[number];
  description: string;
  scope: "room" | "workspace" | "installation" | "operator";
}

export const controlInspectSectionCatalog: ControlInspectSectionItem[] = [
  { section: "TERMINAL_RENDER", description: "Numeric browser render observations, scoped by actor/client, with freshness and geometry-only verdicts. Does not capture content or activate panes.", scope: "room" },
  { section: "STATE", description: "Authoritative room state, open panes, positions, and active clients.", scope: "room" },
  { section: "CONTENT", description: "Terminal or chat pane output, activity logs, and turn status.", scope: "room" },
  { section: "MODELS", description: "Active CLI models, configured vs effective models, and account identities.", scope: "room" },
  { section: "QUOTA", description: "Account token quotas, 5h/weekly usage percentages, and reset deadlines.", scope: "workspace" },
  { section: "RUNTIMES", description: "CLI runtime installation status, versions, and execution modes.", scope: "installation" },
  { section: "VPN", description: "CLI egress VPN routing profiles and city status.", scope: "installation" },
  { section: "CLIPBOARD", description: "Operator private clipboard entries (notes, plans, copied content).", scope: "operator" },
  { section: "FILES", description: "Uploaded and published workspace files and documents.", scope: "room" },
  { section: "MEDIA", description: "Images, videos, and screenshots attached to the room.", scope: "room" },
  { section: "SKILLS", description: "Installed and registered agent skills with markdown guides.", scope: "installation" },
  { section: "SETTINGS", description: "Complete sanitized app settings across CLI, providers, tools, task titles, plugins, voice, and appearance.", scope: "installation" },
  { section: "ROOMS", description: "List of all user rooms with metadata and pane counts.", scope: "workspace" },
  { section: "SYSTEM_HEALTH", description: "Realtime health metrics, CPU/memory, active services, and API error rates.", scope: "installation" },
  { section: "PLUGINS", description: "Installed plugins, connection status, and enabled agent capabilities.", scope: "installation" },
  { section: "MODULES", description: "Discoverable UI navigation groups, docks, tool surfaces, and feature flags.", scope: "workspace" },
  { section: "VOICE", description: "Voice transcription settings, local/cloud provider status, and supported speech models.", scope: "installation" },
  { section: "LINKS", description: "Workspace bookmark links and metadata.", scope: "workspace" },
  { section: "TASKS", description: "Task items, objectives, completion status, and room linkages.", scope: "workspace" },
  { section: "AUDIT", description: "Audit trail of recent Space Control actions and mutations.", scope: "room" }
];

export const controlActionCatalog: ControlActionCatalogItem[] = [
  {domain:"panes",action:"visual_audit",description:"Read one terminal surface in the focused authenticated client. No room activation, recovery or new polling. Screenshot availability is reported separately.",requiredPermission:"OPERATOR_WRITE",isDestructive:false,supportsDryRun:true,supportsRollback:false,
    parameters:{target:{type:"object",required:true,description:"Exactly one paneIds entry."},captureScreenshot:{type:"boolean",required:false,description:"Default false; unsupported capture returns UNAVAILABLE."}},voiceIntents:[]},
  {
    domain: "settings",
    action: "settings.appearance",
    description: "Unavailable until an active-client preference adapter can verify the requested theme and UI scale changes.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: true,
    supportsRollback: false,
    parameters: {
      theme: { type: "string", required: false, description: "Theme name: graphite, forest, copper, steel, contrast, modern, classic" },
      zoomLevel: { type: "number", required: false, description: "UI zoom percentage (50-200)" },
      terminalFontSize: { type: "number", required: false, description: "Terminal font size (8-32)" }
    },
    voiceIntents: ["change theme to forest", "switch theme to graphite", "make terminal font larger", "zoom out to 90 percent"]
  },
  {
    domain: "settings",
    action: "settings.voice",
    description: "Persist voice composer preferences in the authenticated focused Space tab and verify read-back. Models, voices and languages must be available in server settings. This does not reconfigure an already-open Live audio session.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: true,
    supportsRollback: false,
    parameters: {
      enabled: { type: "boolean", required: false, description: "Enable or disable voice transcription" },
      language: { type: "string", required: false, description: "Language code ('el', 'en', 'auto')" },
      model: { type: "string", required: false, description: "Speech model identifier" },
      voice: { type: "string", required: false, description: "TTS voice profile name" },
      insertMode: { type: "string", required: false, description: "Insertion mode ('replace' or 'append')" },
      prewarm: { type: "boolean", required: false, description: "Prewarm voice composer input" }
    },
    voiceIntents: ["set voice language to Greek", "turn off voice input", "change voice model to whisper"]
  },
  {
    domain: "settings",
    action: "settings.plugins",
    description: "Unavailable through Control. Use authenticated Plugins settings; enabling, connecting and deleting credentials are distinct operations.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: true,
    supportsRollback: false,
    parameters: {
      pluginId: { type: "string", required: true, description: "Unique plugin identifier" },
      enabled: { type: "boolean", required: true, description: "Enable (connect) or disable (disconnect)" }
    },
    voiceIntents: ["enable github plugin", "disconnect jira plugin", "check plugin status"]
  },
  {
    domain: "settings",
    action: "settings.snapshot",
    description: "Persist a sanitized settings observation with verified storage. This is not a restorable backup and excludes credentials and browser-local preferences.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: false,
    supportsRollback: false,
    parameters: {
      label: { type: "string", required: false, description: "Descriptive label for the settings snapshot" }
    },
    voiceIntents: ["create settings snapshot", "backup current configuration", "save settings checkpoint"]
  },
  {
    domain: "settings",
    action: "settings.rollback",
    description: "Unavailable: sanitized settings observations cannot be restored. No settings are changed.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: true,
    supportsDryRun: false,
    supportsRollback: false,
    parameters: {
      snapshotId: { type: "string", required: false, description: "Snapshot ID to restore, or omits to restore latest" },
      confirm: { type: "boolean", required: true, description: "Explicit confirmation required for rollback" }
    },
    voiceIntents: ["rollback settings", "restore previous settings snapshot", "undo configuration changes"]
  },
  {
    domain: "settings",
    action: "settings.update",
    description: "Unified settings mutation across allowlisted configuration domains.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: true,
    supportsRollback: false,
    parameters: {
      domain: { type: "string", required: true, description: "Target domain: appearance, voice, task_titles, tools, plugins" },
      patch: { type: "record", required: true, description: "Non-sensitive key-value patch for the domain" }
    },
    voiceIntents: ["update system settings", "configure workspace preferences"]
  },
  {
    domain: "tasks",
    action: "tasks.create",
    description: "Create a new task item with objective and status in the current workspace.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: true,
    supportsRollback: false,
    parameters: {
      title: { type: "string", required: true, description: "Task title" },
      objective: { type: "string", required: false, description: "Detailed task objective" },
      status: { type: "string", required: false, description: "Task status (OPEN, IN_PROGRESS, COMPLETED)" }
    },
    voiceIntents: ["create a task to test login", "add new task item", "track pending work"]
  },
  {
    domain: "tasks",
    action: "tasks.update",
    description: "Update existing task item fields or mark completed.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: true,
    supportsRollback: false,
    parameters: {
      id: { type: "string", required: true, description: "Task item ID" },
      title: { type: "string", required: false, description: "Updated title" },
      status: { type: "string", required: false, description: "New status" }
    },
    voiceIntents: ["mark task completed", "update task title", "change task status"]
  },
  {
    domain: "tasks",
    action: "tasks.delete",
    description: "Delete an existing task item (requires explicit confirmation).",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: true,
    supportsDryRun: true,
    supportsRollback: false,
    parameters: {
      id: { type: "string", required: true, description: "Task item ID" },
      confirm: { type: "boolean", required: true, description: "Explicit confirmation" }
    },
    voiceIntents: ["delete task item", "remove completed task"]
  },
  {
    domain: "links",
    action: "links.create",
    description: "Save a new bookmark or link in the workspace.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: true,
    supportsRollback: false,
    parameters: {
      title: { type: "string", required: true, description: "Link title" },
      url: { type: "string", required: true, description: "Valid HTTP or HTTPS URL" }
    },
    voiceIntents: ["add quick link to documentation", "save bookmark"]
  },
  {
    domain: "layout",
    action: "layout",
    description: "Sort, apply grid, build tree layout, or restore layout placements.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: true,
    supportsRollback: true,
    parameters: {
      operation: { type: "string", required: true, description: "sort, apply, tree, save, restore" },
      sortBy: { type: "string", required: false, description: "createdAt, sessionStartedAt, taskStartedAt, title, runtimeId" }
    },
    voiceIntents: ["arrange panes in a grid", "sort panes by task start time", "rebalance layout"]
  },
  {
    domain: "playback",
    action: "playback",
    description: "Control room audio, vibe music, or floating video playback.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: false,
    supportsRollback: false,
    parameters: {
      operation: { type: "string", required: true, description: "play, pause, next, previous, volume, mute, unmute" },
      value: { type: "number", required: false, description: "Volume level (0-100) or seek seconds" }
    },
    voiceIntents: ["pause music", "mute audio", "set volume to 50 percent", "resume playback"]
  },
  {
    domain: "room",
    action: "room.create",
    description: "Create a new agent workspace room.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: true,
    supportsRollback: false,
    parameters: {
      name: { type: "string", required: true, description: "Descriptive room name" }
    },
    voiceIntents: ["create a new room named debug", "make a new workspace room"]
  },
  {
    domain: "room",
    action: "room.rename",
    description: "Rename an existing workspace room.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: true,
    supportsRollback: false,
    parameters: {
      name: { type: "string", required: true, description: "New room name" }
    },
    voiceIntents: ["rename room to release testing", "update current room title"]
  },
  {
    domain: "room",
    action: "room.delete",
    description: "Delete an empty or retired workspace room (requires confirmation).",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: true,
    supportsDryRun: true,
    supportsRollback: false,
    parameters: {
      confirm: { type: "boolean", required: true, description: "Explicit confirmation" }
    },
    voiceIntents: ["delete this room", "remove closed room"]
  },
  {
    domain: "panes",
    action: "pane.open",
    description: "Open a new CLI terminal or chat pane with selected runtime.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: true,
    supportsRollback: false,
    parameters: {
      title: { type: "string", required: false, description: "Pane title" },
      runtimeId: { type: "string", required: false, description: "CLI runtime ID: cli:opencode, cli:codex, cli:gemini, cli:claude" }
    },
    voiceIntents: ["open new opencode pane", "start a codex terminal", "create new terminal"]
  },
  {
    domain: "panes",
    action: "pane.close",
    description: "Close a specific pane in the current room.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: true,
    supportsRollback: false,
    parameters: {
      paneId: { type: "string", required: true, description: "Target pane ID" }
    },
    voiceIntents: ["close pane two", "close this terminal"]
  },
  {
    domain: "panes",
    action: "pane.prompt",
    description: "Submit a prompt or task instruction to a running pane.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: true,
    supportsRollback: false,
    parameters: {
      paneId: { type: "string", required: true, description: "Target pane ID" },
      text: { type: "string", required: true, description: "Instruction or prompt text" }
    },
    voiceIntents: ["tell opencode to run the tests", "send message to active pane"]
  },
  {
    domain: "clipboard",
    action: "clipboard.save",
    description: "Save a note, task summary, or PLAN item to the operator clipboard.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: true,
    supportsRollback: false,
    parameters: {
      text: { type: "string", required: true, description: "Clipboard content text" },
      title: { type: "string", required: false, description: "Short title" },
      source: { type: "string", required: false, description: "MANUAL_NOTE, AGENT_NOTE, PLAN" }
    },
    voiceIntents: ["save note to clipboard", "record plan for deployment"]
  },
  {
    domain: "screenshot",
    action: "screenshot.capture",
    description: "Capture visual state of the Space App canvas for multimodal inspection.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: false,
    supportsRollback: false,
    parameters: {
      format: { type: "string", required: false, description: "jpeg, png, webp" },
      quality: { type: "number", required: false, description: "Image quality (1-100)" }
    },
    voiceIntents: ["take a screenshot of the app", "look at the screen", "capture current UI"]
  },
  {
    domain: "watches",
    action: "watches.register",
    description: "Register a background watch job for real-time task completion detection and assistant wakeup.",
    requiredPermission: "OPERATOR_WRITE",
    isDestructive: false,
    supportsDryRun: true,
    supportsRollback: false,
    parameters: {
      paneId: { type: "string", required: true, description: "Target pane to monitor" },
      timeoutMs: { type: "number", required: false, description: "Watch timeout in milliseconds" }
    },
    voiceIntents: ["notify me when the build finishes", "watch pane 1 for task completion"]
  }
];

export const controlSecurityPolicy = {
  forbiddenTargets: [
    "secrets",
    "credentials",
    "passwords",
    "api_keys",
    "auth_tokens",
    "session_secret",
    "sudoers",
    "host_firewall",
    "network_interfaces",
    "destructive_db_wipe"
  ],
  prohibitedKeys: [
    "secret",
    "token",
    "apiKey",
    "api_key",
    "password",
    "credential",
    "auth",
    "privateKey",
    "sessionSecret",
    "cookie",
    "sudo"
  ],
  requiresConfirmation: [
    "settings.rollback",
    "tasks.delete",
    "room.delete",
    "panes.close_all"
  ],
  rbacMatrix: {
    OPERATOR_READ: ["inspect:ALL", "operations:list", "schedules:list", "watches:list"],
    OPERATOR_WRITE: [
      "settings.appearance", "settings.voice", "settings.plugins", "settings.snapshot", "settings.rollback", "settings.update",
      "tasks.*", "links.*", "panes.*", "room.*", "layout.*", "playback.*", "clipboard.*", "watches.*", "screenshot.*"
    ],
    ADMIN_WRITE: ["settings.providers", "cli.*", "vpn.*", "ops.*", "access.cli"]
  }
};
