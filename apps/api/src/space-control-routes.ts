import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { controlToolSchemas,controlToolDescriptions,controlExecuteSchema,controlInspectSchema } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import type { createSpaceControl,ControlActor } from "./space-control.js";
export function registerSpaceControlRoutes(app:FastifyInstance,control:ReturnType<typeof createSpaceControl>, options?:{cliRoom(request:FastifyRequest):string|null;resolveActor?(id:string,verifiedEmail?:string):Promise<ControlActor>}){
 const actor=async(request:FastifyRequest):Promise<ControlActor>=>{
  if(!request.user||request.user.role!=="ADMIN"||request.user.automationScope)throw new SpaceConflictError("An authenticated operator ADMIN is required for Space control.");
  return options?.resolveActor?options.resolveActor(request.user.id,request.user.email):{id:request.user.id,role:request.user.role};
 };
 const toolList=Object.entries(controlToolSchemas).map(([name,schema])=>({name,description:controlToolDescriptions[name as keyof typeof controlToolDescriptions],inputSchema:z.toJSONSchema(schema)}));
 async function call(user:ControlActor,name:string,raw:unknown){
  switch(name){
   case "space_capabilities":return control.capabilities(controlToolSchemas.space_capabilities.parse(raw).roomId);
   case "space_inspect":return control.inspect(user,controlInspectSchema.parse(raw));
   case "space_execute":return control.execute(user,controlExecuteSchema.parse(raw));
   case "space_operations":{const p=controlToolSchemas.space_operations.parse(raw);return control.operations(user,p.roomId,p.id,p.operation==="cancel");}
   case "space_schedules":{const p=controlToolSchemas.space_schedules.parse(raw);return control.schedules(user,p.roomId,p.operation,p.id,p.dueAt,p.command);}
   default:throw new SpaceConflictError("Unknown Space control tool.");
  }
 }
 app.get("/api/control/v1/capabilities",async request=>{await actor(request);return control.capabilities(z.object({roomId:z.string().min(1)}).parse(request.query).roomId);});
 app.post("/api/control/v1/inspect",async request=>control.inspect(await actor(request),controlInspectSchema.parse(request.body)));
 app.post("/api/control/v1/commands",async request=>control.execute(await actor(request),controlExecuteSchema.parse(request.body)));
 app.post("/api/control/v1/operations",async request=>call(await actor(request),"space_operations",request.body));
 app.post("/api/control/v1/schedules",async request=>call(await actor(request),"space_schedules",request.body));
 app.get("/api/control/v1/layout/:roomId",async request=>{await actor(request);return control.layout(z.object({roomId:z.string().min(1)}).parse(request.params).roomId);});
 app.post("/api/control/v1/client",async request=>{const p=z.object({roomId:z.string().min(1),clientId:z.string().min(1).max(200),targets:z.array(z.object({id:z.string().max(200),kind:z.enum(["YOUTUBE","MUSIC"]),playing:z.boolean()}).strict()).max(64),geometry:z.array(z.object({paneId:z.string().max(200),x:z.number(),y:z.number(),width:z.number(),height:z.number()}).strict()).max(64)}).strict().parse(request.body);return {commands:control.registerClient(await actor(request),p.roomId,p.clientId,p.targets,p.geometry),layout:await control.layout(p.roomId)};});
 app.post("/api/control/v1/client/release",async request=>control.unregisterClient(await actor(request),z.object({clientId:z.string().max(200)}).strict().parse(request.body).clientId));
 app.post("/api/control/v1/client/ack",async request=>{const p=z.object({clientId:z.string().max(200),id:z.string().max(200),ok:z.boolean(),evidence:z.object({applied:z.boolean(),reason:z.string().max(500).optional()}).strict()}).strict().parse(request.body);return control.acknowledge(await actor(request),p.clientId,p.id,{ok:p.ok,evidence:p.evidence});});
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
 app.post("/api/control/v1/mcp",mcpHandler);
 app.post("/api/cli/control/mcp",mcpHandler);
 app.get("/api/control/v1/mcp",async(_request,reply)=>reply.code(405).send());
 return {call,toolList};
}
