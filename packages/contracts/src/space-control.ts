import { z } from "zod";

export const SPACE_CONTROL_VERSION = "space-control-v1";
const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(100_000);
export const controlTargetSchema = z.object({
  paneIds: z.array(id).min(1).max(64).optional(),
  runtimeId: id.optional(),
  state: z.enum(["OPEN", "CLOSED", "STOPPED", "RUNNING", "ALL"]).default("OPEN")
}).strict();
export const controlPlacementSchema = z.object({ paneId: id, x: z.number().min(0).max(100),
  y: z.number().min(0).max(1000), width: z.number().positive().max(100), height: z.number().positive().max(1000)
}).strict().refine(p => p.x + p.width <= 100, "Pane exceeds canvas width.");
export const controlLayoutSchema = z.object({ mode: z.enum(["GRID", "CUSTOM"]),
  columns: z.number().int().min(1).max(4).default(2),
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
 "files.publish","files.delete","media.publish","media.delete","files.preview",
 "settings.providers","settings.tools","settings.task_titles","models.list",
 "ops.status","ops.logs","ops.test","ops.verify","ops.deploy","ops.proof","access.cli"] as const;
export const controlActionSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("resource"),operation:z.enum(controlResourceOperations),id:id.optional(),input:z.record(z.string(),z.unknown()).default({}),approvalReason:z.string().trim().min(5).max(500).optional()}).strict(),
  z.object({kind:z.literal("room"), operation:z.enum(["rename","create","activate"]), name:id.optional(), targetRoomId:id.optional()}).strict(),
  z.object({kind:z.literal("pane"), operation:z.enum(["rename","close","reopen","restart","start","resume","stop","continue","prompt","minimize","maximize","restore","focus"]), target:controlTargetSchema,
    text:text.optional(), when:z.enum(["NOW","AFTER_TURN"]).default("AFTER_TURN")}).strict(),
  z.object({kind:z.literal("configure"), target:controlTargetSchema, modelId:id.optional(), reasoningEffort:id.optional(), nativeMode:id.optional(),
    when:z.enum(["NOW","AFTER_TURN"]).default("AFTER_TURN")}).strict(),
  z.object({kind:z.literal("layout"), operation:z.enum(["sort","apply","tree","save","restore"]),
    sortBy:z.enum(["createdAt","sessionStartedAt","taskStartedAt","title","runtimeId"]).default("createdAt"),
    direction:z.enum(["asc","desc"]).default("asc"), layout:controlLayoutSchema.optional(), snapshotId:id.optional()}).strict(),
  z.object({kind:z.literal("playback"), operation:z.enum(["play","pause","next","previous","seek","volume","mute","unmute"]),
    targetId:id.optional(), target:z.enum(["AUTO","YOUTUBE","MUSIC"]).default("AUTO"), value:z.number().min(0).max(86400).optional()}).strict(),
  z.object({kind:z.literal("cli"), runtimeId:id, enabled:z.boolean()}).strict(),
  z.object({kind:z.literal("vpn"), operation:z.enum(["set","rotate"]), runtimeId:id.optional(), enabled:z.boolean().optional(), profile:z.enum(["mullvad","nord"]).optional()}).strict(),
  z.object({kind:z.literal("clipboard"), operation:z.enum(["save","complete","delete"]), id:id.optional(),
    text:text.optional(), title:z.string().max(200).optional(), source:z.enum(["COPY","PASTE","MANUAL_NOTE","AGENT_NOTE","PLAN"]).default("MANUAL_NOTE"), completed:z.boolean().optional()}).strict(),
  z.object({kind:z.literal("native_command"), target:controlTargetSchema,
    command:z.string().min(2).max(2000).regex(/^\/[a-zA-Z][a-zA-Z0-9_-]*(?: [^\x00-\x1f\x7f]*)?$/), when:z.enum(["NOW","AFTER_TURN"]).default("AFTER_TURN")}).strict()
]);
export const controlExecuteSchema = z.object({roomId:id, requestId:id,
  expectedRevision:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  actions:z.array(controlActionSchema).min(1).max(32)
}).strict().refine(v=>JSON.stringify(v).length<=500_000,"Control request is too large.");
export const controlInspectSchema = z.object({roomId:id,
  section:z.enum(["STATE","CONTENT","MODELS","QUOTA","RUNTIMES","VPN","CLIPBOARD","FILES","MEDIA","SKILLS","SETTINGS","ROOMS"]).default("STATE"),
  paneId:id.optional(), query:z.string().max(500).optional(), offset:z.number().int().min(0).default(0), limit:z.number().int().min(1).max(100).default(25)
}).strict();
export const controlResultSchema=z.object({index:z.number().int().min(0), paneId:id.optional(),
  status:z.enum(["COMPLETED","PENDING","FAILED","CANCELLED","UNKNOWN"]), detail:z.string().max(2000), evidence:z.record(z.string(),z.unknown()).default({})});
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
export type ControlAction=z.infer<typeof controlActionSchema>;
export type ControlExecute=z.infer<typeof controlExecuteSchema>;
export type ControlInspect=z.infer<typeof controlInspectSchema>;
export type ControlLayout=z.infer<typeof controlLayoutSchema>;
export type ControlOperation=z.infer<typeof controlOperationSchema>;
export type ControlResult=z.infer<typeof controlResultSchema>;
export type ControlSchedule=z.infer<typeof controlScheduleSchema>;
export type ControlTarget=z.infer<typeof controlTargetSchema>;

export const roomControlActionSchema=z.object({type:z.literal("CONTROL"),actions:z.array(controlActionSchema).min(1).max(32)}).strict();
export const controlToolSchemas = {
  space_capabilities: z.object({roomId:id}).strict(),
  space_inspect:controlInspectSchema,
  space_execute:controlExecuteSchema,
  space_operations:z.object({roomId:id,id:id.optional(),operation:z.enum(["list","get","cancel"]).default("list")}).strict(),
  space_schedules:z.object({roomId:id,id:id.optional(),operation:z.enum(["list","create","cancel"]).default("list"),dueAt:z.iso.datetime().optional(),command:controlExecuteSchema.optional()}).strict()
};
export const controlToolDescriptions = {
  space_capabilities:"Discover actual Space room controls and runtime support before targeting panes.",
  space_inspect:"Read authoritative room state, positions, times, content and available model/runtime information.",
  space_execute:"Apply one validated batch of Space controls. Preserve task identity on reopen. Returns verified per-target outcomes; pending is not completion.",
  space_operations:"Inspect or cancel durable operations belonging to the authenticated operator.",
  space_schedules:"Create explicit one-shot schedules or inspect/cancel them. Automatic policies are not enabled."
};
