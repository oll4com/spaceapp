import { terminalRenderBatchSchema } from "@space/contracts";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { controlToolSchemas,controlToolDescriptions,controlExecuteSchema,controlInspectSchema } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import type { createSpaceControl,ControlActor } from "./space-control.js";
export function registerSpaceControlRoutes(app:FastifyInstance,control:ReturnType<typeof createSpaceControl>, options?:{cliRoom(request:FastifyRequest):string|null;resolveActor?(id:string,verifiedEmail?:string):Promise<ControlActor>}){
 const actor=async(request:FastifyRequest):Promise<ControlActor>=>{
  if(!request.user||(request.user.role!=="ADMIN"&&request.user.role!=="USER")||request.user.automationScope)throw new SpaceConflictError("An authenticated user is required for Space control.");
  return options?.resolveActor?options.resolveActor(request.user.id,request.user.email):{id:request.user.id,role:request.user.role};
 };
 const toolList=Object.entries(controlToolSchemas).map(([name,schema])=>({name,description:controlToolDescriptions[name as keyof typeof controlToolDescriptions],inputSchema:z.toJSONSchema(schema)}));
function sanitizeControlExecute(raw:unknown):unknown{
 if(!raw||typeof raw!=="object")return raw;
 const copy={...(raw as Record<string,unknown>)};
 if(Array.isArray(copy.actions)){
  copy.actions=copy.actions.map((action:unknown)=>{
   if(!action||typeof action!=="object")return action;
   const act={...(action as Record<string,unknown>)};
   const isPaneAction=act.kind==="pane"||(!act.kind&&(act.paneId||act.paneIds||["stop","cancel","start","restart","reopen","close","resume","continue","prompt","minimize","maximize","restore","unminimize","focus"].includes(String(act.operation||act.action))));
   if(isPaneAction){
    act.kind="pane";
    if(!act.operation)act.operation=act.action||"stop";
    if(act.operation==="cancel")act.operation="stop";
    if(act.operation==="unminimize")act.operation="restore";
    delete act.action;
    if(!act.target||typeof act.target!=="object"){
     const pId=act.paneId||act.paneIds;
     if(pId){
      const arr=Array.isArray(pId)?pId:[pId];
      act.target={paneIds:arr,state:"ALL"};
     }else{
      act.target={state:"ALL"};
     }
    }else{
     const targetObj={...(act.target as Record<string,unknown>)};
     if(!targetObj.state)targetObj.state="ALL";
     act.target=targetObj;
    }
    delete act.paneId;
    delete act.paneIds;
   }
   if(act.kind==="configure"){
    if(!act.target||typeof act.target!=="object"){
     const pId=act.paneId||act.paneIds;
     if(pId){
      const arr=Array.isArray(pId)?pId:[pId];
      act.target={paneIds:arr,state:"ALL"};
     }else{
      act.target={state:"ALL"};
     }
    }else{
     const targetObj={...(act.target as Record<string,unknown>)};
     if(!targetObj.state)targetObj.state="ALL";
     act.target=targetObj;
    }
   }
   if(act.kind==="resource"&&act.operation==="panes.open"&&act.input&&typeof act.input==="object"){
    const inputObj={...(act.input as Record<string,unknown>)};
    if(inputObj.counts&&typeof inputObj.counts==="object"){
     const rawCounts=inputObj.counts as Record<string,unknown>;
     const cleanCounts:Record<string,number>={};
      for(const [k,v] of Object.entries(rawCounts)){
       let cleanKey=k.replace(/^(cli:|pane:)/,"").trim().toLowerCase();
       if(cleanKey === "antigravity" || cleanKey === "agy" || cleanKey === "google antigravity") {
        cleanKey = "gemini";
       }
       if(cleanKey === "kimi code" || cleanKey === "kimi koud" || cleanKey === "kimi cli") cleanKey = "kimi";
       if(cleanKey === "qwen code" || cleanKey === "qwen cli") cleanKey = "qwen";
       if(cleanKey === "claude code" || cleanKey === "claude cli") cleanKey = "claude";
       if(cleanKey === "grok build" || cleanKey === "grok cli") cleanKey = "grok";
       if(cleanKey === "deepseek cli") cleanKey = "deepseek";
       if(cleanKey === "hermes agent" || cleanKey === "hermes cli") cleanKey = "hermes";
       if(cleanKey === "autohand code" || cleanKey === "autohand cli") cleanKey = "autohand";
       if(cleanKey === "open code" || cleanKey === "opencode cli") cleanKey = "opencode";
       if(cleanKey === "codex cli") cleanKey = "codex";
       const num=typeof v==="number"?v:1;
       cleanCounts[cleanKey]=(cleanCounts[cleanKey]||0)+num;
      }
     inputObj.counts=cleanCounts;
     act.input=inputObj;
    }
   }
    if(act.kind==="resource"&&act.operation==="ui.scale"&&act.input&&typeof act.input==="object"){
     const inputObj={...(act.input as Record<string,unknown>)};
     if(typeof inputObj.scale==="number"&&!inputObj.zoomLevel)inputObj.zoomLevel=inputObj.scale;
     if(typeof inputObj.zoom==="number"&&!inputObj.zoomLevel)inputObj.zoomLevel=inputObj.zoom;
     if(typeof inputObj.fontSize==="number"&&!inputObj.terminalFontSize)inputObj.terminalFontSize=inputObj.fontSize;
     act.input=inputObj;
    }
   return act;
  });
 }
 return copy;
}
 async function call(user:ControlActor,name:string,raw:unknown){
  switch(name){
   case "space_capabilities":return control.capabilities(controlToolSchemas.space_capabilities.parse(raw).roomId);
   case "space_inspect":return control.inspect(user,controlInspectSchema.parse(raw));
   case "space_execute":{const parsed=controlExecuteSchema.parse(sanitizeControlExecute(raw));return control.execute(user,parsed,parsed.waitForCompletion??true);}
   case "space_operations":{const p=controlToolSchemas.space_operations.parse(raw);return control.operations(user,p.roomId,p.id,p.operation==="cancel");}
   case "space_schedules":{const p=controlToolSchemas.space_schedules.parse(raw);return control.schedules(user,p.roomId,p.operation,p.id,p.dueAt,p.command);}
   case "space_watches":{const p=controlToolSchemas.space_watches.parse(raw);return control.watches(user,p.roomId,p.operation,p);}
   case "space_screenshot":{const p=controlToolSchemas.space_screenshot.parse(raw);return control.screenshot(user,p.roomId,p);}
   case "space_test_mcp_tools":{const p=controlToolSchemas.space_test_mcp_tools.parse(raw);return control.testMcpTools(user,p.roomId,p);}
    case "space_list_mcp_tools":{const p=controlToolSchemas.space_list_mcp_tools.parse(raw);return control.listMcpTools(p.category);}
    case "space_describe_pane_types":{const p=controlToolSchemas.space_describe_pane_types.parse(raw);return control.describePaneTypes(p.roomId);}
   case "space_debug":{const p=controlToolSchemas.space_debug.parse(raw);return control.runDebug(user,p.roomId,p.operation,p.paneId,p.query);}
   default:throw new SpaceConflictError("Unknown Space control tool.");
  }
 }
 app.get("/api/control/v1/capabilities",async request=>{await actor(request);return control.capabilities(z.object({roomId:z.string().min(1).optional()}).parse(request.query).roomId);});
 app.post("/api/control/v1/inspect",async request=>control.inspect(await actor(request),controlInspectSchema.parse(request.body)));
 app.post("/api/control/v1/commands",async request=>{const parsed=controlExecuteSchema.parse(sanitizeControlExecute(request.body));return control.execute(await actor(request),parsed,parsed.waitForCompletion??true);});
 app.post("/api/control/v1/screenshot",async request=>{const user=await actor(request);const p=controlToolSchemas.space_screenshot.parse(request.body);return control.screenshot(user,p.roomId,p);});
 app.post("/api/control/v1/test-tools",async request=>{const user=await actor(request);const p=controlToolSchemas.space_test_mcp_tools.parse(request.body);return control.testMcpTools(user,p.roomId,p);});
  app.get("/api/control/v1/tools",async request=>{await actor(request);const p=controlToolSchemas.space_list_mcp_tools.parse(request.query);return control.listMcpTools(p.category);});
  app.get("/api/control/v1/pane-types",async request=>{await actor(request);const p=controlToolSchemas.space_describe_pane_types.parse(request.query);return control.describePaneTypes(p.roomId);});
 app.post("/api/control/v1/debug",async request=>{const user=await actor(request);const p=controlToolSchemas.space_debug.parse(request.body);return control.runDebug(user,p.roomId,p.operation,p.paneId,p.query);});
 app.post("/api/control/v1/operations",async request=>call(await actor(request),"space_operations",request.body));
 app.post("/api/control/v1/schedules",async request=>call(await actor(request),"space_schedules",request.body));
  app.post("/api/control/v1/watches",async request=>call(await actor(request),"space_watches",request.body));
  app.get("/api/control/v1/watches/pending",async request=>{const user=await actor(request);const {roomId}=z.object({roomId:z.string().min(1).optional()}).parse(request.query);return control.pendingWatches(user,roomId);});
  app.post("/api/control/v1/watches/ack",async request=>{const user=await actor(request);const p=z.object({roomId:z.string().min(1),id:z.string().min(1)}).parse(request.body);return control.watches(user,p.roomId,"ack",p);});
 app.get("/api/control/v1/layout/:roomId",async request=>{await actor(request);return control.layout(z.object({roomId:z.string().min(1)}).parse(request.params).roomId);});
 app.post("/api/control/v1/client",async request=>{const p=z.object({roomId:z.string().min(1),clientId:z.string().min(1).max(200),targets:z.array(z.object({id:z.string().max(200),kind:z.enum(["YOUTUBE","MUSIC"]),playing:z.boolean()}).strict()).max(64),terminalRender:terminalRenderBatchSchema.optional(),geometry:z.array(z.object({paneId:z.string().max(200),x:z.number(),y:z.number(),width:z.number(),height:z.number()}).strict()).max(64)}).strict().parse(request.body);return {commands:control.registerClient(await actor(request),p.roomId,p.clientId,p.targets,p.geometry,p.terminalRender),layout:await control.layout(p.roomId)};});
 app.post("/api/control/v1/client/release",async request=>control.unregisterClient(await actor(request),z.object({clientId:z.string().max(200)}).strict().parse(request.body).clientId));
 app.post("/api/control/v1/client/ack",async request=>{const p=z.object({clientId:z.string().max(200),id:z.string().max(200),ok:z.boolean(),evidence:z.record(z.string(),z.unknown()).default({})}).strict().parse(request.body);return control.acknowledge(await actor(request),p.clientId,p.id,{ok:p.ok,evidence:p.evidence});});
 // Streamable HTTP permits a stateless JSON response and a 405 for the optional GET stream.
 const mcpHandler = async(request:FastifyRequest,reply:FastifyReply)=>{
  const user=await actor(request),p=z.object({jsonrpc:z.literal("2.0"),id:z.union([z.string(),z.number()]).optional(),method:z.string(),params:z.unknown().optional()}).parse(request.body);
  if(p.id===undefined)return reply.code(202).send();
  try{let result:unknown;
   if(p.method==="initialize")result={protocolVersion:"2025-11-25",capabilities:{tools:{listChanged:false}},serverInfo:{name:"space-control",version:"1.0.0"}};
   else if(p.method==="ping")result={};
   else if(p.method==="tools/list")result={tools:toolList};
   else if(p.method==="tools/call"){const args=z.object({name:z.string(),arguments:z.unknown().optional()}).parse(p.params);const cliRoom=options?.cliRoom(request);if(cliRoom && (args.arguments as {roomId?:string})?.roomId!==cliRoom)throw new SpaceConflictError("CLI control grant is restricted to its own room.");const data=await call(user,args.name,args.arguments??{});const structuredContent=data!==null&&typeof data==="object"&&!Array.isArray(data)?data:{data};result={content:[{type:"text",text:JSON.stringify(structuredContent)}],structuredContent,isError:["FAILED","PARTIAL","UNKNOWN","CANCELLED"].includes((data as {status?:string})?.status??"")};}
   else return {jsonrpc:"2.0",id:p.id,error:{code:-32601,message:"Method not found"}};
   return {jsonrpc:"2.0",id:p.id,result};
  }catch(error){return {jsonrpc:"2.0",id:p.id,error:{code:-32602,message:error instanceof SpaceConflictError?error.message:"Invalid Space control arguments."}};}
 };
  const mcpRateLimitOptions = {
  config: {
   rateLimit: {
    max: 600,
    timeWindow: "1 minute",
    keyGenerator: (request: FastifyRequest) => {
     return (request.headers["x-space-control-token"] as string | undefined)
      ?? request.user?.id
      ?? request.ip;
    }
   }
  }
 };
 app.post("/api/control/v1/mcp", mcpRateLimitOptions, mcpHandler);
 app.post("/api/cli/control/mcp", mcpRateLimitOptions, mcpHandler);
 app.get("/api/control/v1/mcp", async (_request, reply) => reply.code(405).send());

 app.get("/api/control/v1/operations/:id/stream", async (request, reply) => {
  const user = await actor(request);
  const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
  const roomId = z.object({ roomId: z.string().min(1) }).parse(request.query).roomId;
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.flushHeaders?.();

  let closed = false;
  request.raw.on("close", () => { closed = true; });

  const sendEvent = (event: string, data: unknown) => {
   if (!closed) {
    reply.raw.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
   }
  };

  const poll = async () => {
   while (!closed) {
    try {
     const op = await control.operations(user, roomId, id) as any;
     sendEvent("telemetry", op);
     if (["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "UNKNOWN"].includes(op?.status)) {
      sendEvent("done", { status: op.status });
      break;
     }
    } catch (e) {
     sendEvent("error", { message: (e as Error).message });
     break;
    }
    await new Promise(r => setTimeout(r, 500));
   }
   reply.raw.end();
  };

  void poll();
 });

 return {call,toolList};
}
