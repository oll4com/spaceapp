import { createHmac } from "node:crypto";
import { afterAll,afterEach,describe,expect,it,vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { controlExecuteSchema, controlToolSchemas } from "@space/contracts";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createCsrfToken,signSession } from "../src/auth.js";
import { issueControlToken,verifyControlToken } from "../src/space-control-token.js";
const secret="space-control-unit-test-only";
// Pane account selections go next to the artifacts: never into the live Space's var/.
const artifactRoot=mkdtempSync(join(tmpdir(),"space-control-auth-"));
afterAll(()=>rmSync(artifactRoot,{recursive:true,force:true}));
const apps:Array<Awaited<ReturnType<typeof createApp>>>=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.useRealTimers();});
const headers=(role:"ADMIN"|"OPERATOR"="ADMIN",csrf=true)=>{
 const session=signSession({id:`user:${role}`,role,email:"control@space.local"},secret);
 return {cookie:`space_session=${session}`,...(csrf?{"x-space-csrf-token":createCsrfToken(session,secret)!}:{})};
};
async function fixture(){
 const store=new InMemorySpaceStore();const room=store.createRoom({name:"Control auth",initialPaneCount:0,kind:"AGENT_PROOF"});
 store.upsertUser({id:"user:ADMIN",role:"ADMIN",email:"control@space.local"});
 const app=await createApp({store,config:getApiConfig({SPACE_INTERNAL_API_TOKEN:secret,SPACE_LOG_LEVEL:"silent",SPACE_ARTIFACT_ROOT:join(artifactRoot,"artifacts")}),auth:{sessionSecret:secret,devLogin:false,secureCookies:false}});apps.push(app);
 return {app,store,room};
}
describe("Space control authorization",()=>{
 it("does not expose anonymous browser evidence as an authenticated room screenshot",async()=>{
  const {app,room}=await fixture();
  const response=await app.inject({method:"POST",url:"/api/control/v1/commands",headers:headers(),payload:{roomId:room.id,requestId:"no-anonymous-shot",actions:[{kind:"screenshot",operation:"capture",target:"APP"}]}});
  expect(response.json().status).toBe("FAILED");
  expect(response.json().results[0].detail).toContain("Authenticated room screenshot capture is unavailable");
 });
 // Appearance, plugin, update and rollback adapters exist since cef5d0b619; they are
 // covered below and in space-control-settings. These two still have no adapter.
 it.each([
  ["ui.scale",{zoomLevel:250}], ["asteroids.control",{action:"pause"}]
 ])("does not claim execution for the unavailable %s adapter",async(operation,input)=>{
  const {app,store,room}=await fixture();
  for (const dryRun of [false,true]) {
   const response=await app.inject({method:"POST",url:"/api/control/v1/commands",headers:headers(),payload:{roomId:room.id,requestId:`unsupported:${operation}:${dryRun}`,dryRun,actions:[{kind:"resource",operation,input},{kind:"room",operation:"rename",name:"Must not execute"}]}});
   expect(response.statusCode).toBe(200);
   expect(response.json().status).toBe("FAILED");
   expect(response.json().results[0].status).toBe("FAILED");
   expect(store.getRoom(room.id).name).toBe("Control auth");
  }
 });
 it("sends ops.status to the space-readonly tool the API registry serves",async()=>{
  const {app,room}=await fixture();
  const response=await app.inject({method:"POST",url:"/api/control/v1/commands",headers:headers(),payload:{roomId:room.id,requestId:"ops-status-readonly",actions:[{kind:"resource",operation:"ops.status",input:{}}]}});
  expect(JSON.stringify(response.json())).toContain("space-readonly:space_status");
 });
 it("reports adapter dry runs as simulated and fails a rollback of an unknown snapshot",async()=>{
  const {app,store,room}=await fixture();
  const run=(requestId:string,dryRun:boolean,action:Record<string,unknown>)=>app.inject({method:"POST",url:"/api/control/v1/commands",headers:headers(),
   payload:{roomId:room.id,requestId,dryRun,actions:[action,{kind:"room",operation:"rename",name:"Must not execute"}]}}).then(response=>response.json());
  const preview=await run("theme-preview",true,{kind:"resource",operation:"ui.theme",input:{theme:"forest"}});
  expect(preview.results[0]).toMatchObject({status:"COMPLETED",evidence:{dryRun:true,simulated:true}});
  expect(store.getRoom(room.id).name).toBe("Control auth");
  const rollback=await run("rollback-missing",false,{kind:"resource",operation:"settings.rollback",input:{snapshotId:"missing",confirm:true}});
  expect(rollback.status).toBe("FAILED");
  expect(rollback.results[0].status).toBe("FAILED");
  expect(rollback.results[0].error ?? rollback.results[0].detail).toMatch(/does not exist or cannot be accessed/);
  expect(store.getRoom(room.id).name).toBe("Control auth");
 });
 it("returns the same verified restorable snapshot on request retry",async()=>{
  const {app,room}=await fixture();
  const payload={roomId:room.id,requestId:"snapshot-once",actions:[{kind:"resource",operation:"settings.snapshot",input:{label:"Test snapshot"}}]};
  const invoke=()=>app.inject({method:"POST",url:"/api/control/v1/commands",headers:headers(),payload});
  const first=(await invoke()).json();const retry=(await invoke()).json();
  expect(first.status).toBe("COMPLETED");
  // Snapshots of the restored configuration are restorable since cef5d0b619.
  expect(first.results[0].evidence.result).toMatchObject({restorable:true,scope:"RESTORED_CONFIG",verifiedVersion:1});
  expect(retry.id).toBe(first.id);
  expect(retry.results[0].evidence.result.snapshotId).toBe(first.results[0].evidence.result.snapshotId);
 });
 it("isolates personal-memory routes and enforces CSRF and revision conflicts",async()=>{
  const {app}=await fixture();
  const save=await app.inject({method:"POST",url:"/api/live/personal-memory",headers:headers(),payload:{key:"language",value:"el",expectedRevision:0}});
  expect(save.statusCode).toBe(200);
  expect(save.json()).toMatchObject({revision:1,item:{key:"language",value:"el"}});
  const anonymous=await app.inject({method:"GET",url:"/api/live/personal-memory"});
  expect(anonymous.statusCode).toBe(401);
  const other=await app.inject({method:"GET",url:"/api/live/personal-memory",headers:headers("OPERATOR")});
  expect(other.json().items).toEqual([]);
  const stale=await app.inject({method:"POST",url:"/api/live/personal-memory",headers:headers(),payload:{key:"language",value:"en",expectedRevision:0}});
  expect(stale.statusCode).toBe(409);
  const noCsrf=await app.inject({method:"DELETE",url:`/api/live/personal-memory/${encodeURIComponent(save.json().item.id)}`,headers:headers("ADMIN",false)});
  expect(noCsrf.statusCode).toBe(403);
  const current=await app.inject({method:"GET",url:"/api/live/personal-memory",headers:headers()});
  expect(current.json().items[0].value).toBe("el");
 });
 it("separates session tokens from dedicated room/pane grants and expires them",()=>{
  const token=issueControlToken(secret,{roomId:"room:one",paneId:"pane:one",cliSessionId:"session:one",purpose:"NORMAL"})!;
  expect(verifyControlToken(secret,token)).toMatchObject({roomId:"room:one",paneId:"pane:one",cliSessionId:"session:one"});
  expect(verifyControlToken("other",token)).toBeNull();expect(verifyControlToken(secret,token+"tampered")).toBeNull();
  expect(issueControlToken(secret,{roomId:"r",paneId:"p",cliSessionId:"s",purpose:"LOGIN"})).toBeNull();
  // It outlives a long CLI session (the control route checks the session is still active), but not the 30-day cap.
  vi.useFakeTimers();const issuedAt=Date.now();vi.setSystemTime(issuedAt+13*60*60*1000);expect(verifyControlToken(secret,token)).not.toBeNull();
  vi.setSystemTime(issuedAt+30*24*60*60*1000+1000);expect(verifyControlToken(secret,token)).toBeNull();
  vi.useRealTimers();
  // A token minted before the fix (no iat, exp 12 h after launch) works again for its running session.
  const legacyPayload=Buffer.from(JSON.stringify({roomId:"room:one",paneId:"pane:one",cliSessionId:"session:one",exp:Math.floor(Date.now()/1000)-3600})).toString("base64url");
  const legacy=`spacecontrol.v1.${legacyPayload}.${createHmac("sha256",`space-control:${secret}`).update(legacyPayload).digest("base64url")}`;
  expect(verifyControlToken(secret,legacy)).toMatchObject({cliSessionId:"session:one"});
 });
 it("pages SKILLS as metadata and leaves each skill's text to skills.read",async()=>{
  const {app,store}=await fixture();
  const skill=(n:number)=>({id:`skill:${n}`,displayName:`Skill ${n}`,triggerDescription:`Does ${n}`,body:"skill text ".repeat(1800)});
  vi.spyOn(store,"listSkills").mockReturnValue([1,2,3].map(skill) as any);
  const response=await app.inject({method:"POST",url:"/api/control/v1/inspect",headers:headers(),payload:{section:"SKILLS",offset:1,limit:1}});
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({registered:[{id:"skill:2",name:"Skill 2",description:"Does 2"}],registeredTotal:3,offset:1,limit:1});
  expect(response.json().installed.skills.length).toBeLessThanOrEqual(1);
  expect(response.body).not.toContain("skill text");
 });
 it("requires an authenticated ADMIN and CSRF before executing a control",async()=>{
  const {app,store,room}=await fixture();const payload=controlExecuteSchema.parse({roomId:room.id,requestId:"rename",actions:[{kind:"room",operation:"rename",name:"Changed"}]});
  for(const requestHeaders of [undefined,headers("OPERATOR"),headers("ADMIN",false)]){
   const response=await app.inject({method:"POST",url:"/api/control/v1/commands",headers:requestHeaders,payload});
   expect(response.statusCode).toBeGreaterThanOrEqual(400);expect(store.getRoom(room.id).name).toBe("Control auth");
  }
  const response=await app.inject({method:"POST",url:"/api/control/v1/commands",headers:headers(),payload});
  expect(response.statusCode).toBe(200);expect(response.json().status).toBe("COMPLETED");expect(store.getRoom(room.id).name).toBe("Changed");
 });
 it("does not accept a CLI token as an operator session or without an active grant",async()=>{
  const {app,room}=await fixture();const token=issueControlToken(secret,{roomId:room.id,paneId:"pane:missing",cliSessionId:"session:missing"})!;
  const response=await app.inject({method:"POST",url:"/api/cli/control/mcp",headers:{"x-space-control-token":token},payload:{jsonrpc:"2.0",id:1,method:"tools/list"}});
  expect(response.statusCode).toBeGreaterThanOrEqual(400);
  const normal=await app.inject({method:"POST",url:"/api/control/v1/mcp",headers:{"x-space-control-token":token},payload:{jsonrpc:"2.0",id:1,method:"tools/list"}});
  expect(normal.statusCode).toBe(401);
 });
 it("exposes the typed MCP tools and rejects arbitrary tool names",async()=>{
  const {app,room}=await fixture();
  const invoke=(method:string,params?:unknown)=>app.inject({method:"POST",url:"/api/control/v1/mcp",headers:headers(),payload:{jsonrpc:"2.0",id:1,method,params}});
  expect((await invoke("initialize")).json().result.serverInfo.name).toBe("space-control");
  const list=(await invoke("tools/list")).json().result.tools;
  expect(list.map((t:any)=>t.name)).toEqual(Object.keys(controlToolSchemas));
  const rejected=(await invoke("tools/call",{name:"shell",arguments:{roomId:room.id,command:"anything"}})).json();expect(rejected.error).toBeDefined();
 });
 it("executes pane minimize and restore/unminimize via MCP tools/call end-to-end",async()=>{
  const {app,store,room}=await fixture();
  const pane=store.createPane({roomId:room.id,title:"Test Pane",mode:"TERMINAL",terminalRuntimeId:"cli:codex"});
  const invoke=(name:string,args:unknown)=>app.inject({method:"POST",url:"/api/control/v1/mcp",headers:headers(),payload:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}}});
  const minRes=await invoke("space_execute",{roomId:room.id,requestId:"mcp-min-1",actions:[{kind:"pane",operation:"minimize",target:{paneIds:[pane.id]}}]});
  expect(minRes.statusCode).toBe(200);expect(minRes.json().result.isError).toBe(false);expect(store.getPane(pane.id).isMinimized).toBe(true);
  const unminRes=await invoke("space_execute",{roomId:room.id,requestId:"mcp-unmin-1",actions:[{kind:"pane",operation:"unminimize",target:{paneIds:[pane.id]}}]});
  expect(unminRes.statusCode).toBe(200);expect(unminRes.json().result.isError).toBe(false);expect(store.getPane(pane.id).isMinimized).toBe(false);
 });
 it("rejects stale ADMIN cookies after database role revocation on read and grant paths",async()=>{
  const {app,store,room}=await fixture();store.upsertUser({id:"user:ADMIN",role:"OPERATOR",email:"control@space.local"});
  for(const [url,payload] of [
   ["/api/control/v1/inspect",{roomId:room.id,section:"STATE"}],
   ["/api/control/v1/grant",{roomId:room.id,enabled:true}]
  ] as const){
   const response=await app.inject({method:"POST",url,headers:headers(),payload});
   expect(response.statusCode).toBeGreaterThanOrEqual(400);
  }
  expect(store.getControlActor("user:ADMIN")?.role).toBe("OPERATOR");
 });

 it("allows an active Codex grant only in its room and applies revocation immediately",async()=>{
  const {app,store,room}=await fixture();
  const pane=store.createPane({roomId:room.id,title:"Codex",mode:"TERMINAL",terminalRuntimeId:"cli:codex",cwd:"/etc"});
  const session=store.createPaneCliSession({paneId:pane.id,roomId:room.id,runtimeId:"cli:codex",providerId:"codex",agentId:"codex",modelId:"test",reasoningEffort:"medium",cwd:"/etc",status:"RUNNING",statusReason:"test",isActive:true});
  const token=issueControlToken(secret,{roomId:room.id,paneId:pane.id,cliSessionId:session.sessionId})!;
  const grant=async(enabled:boolean)=>app.inject({method:"POST",url:"/api/control/v1/grant",headers:headers(),payload:{roomId:room.id,enabled}});
  const call=async(roomId:string,requestId:string)=>app.inject({method:"POST",url:"/api/cli/control/mcp",headers:{"x-space-control-token":token},payload:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"space_execute",arguments:{roomId,requestId,actions:[{kind:"room",operation:"rename",name:"Granted"}]}}}});
  expect((await grant(true)).statusCode).toBe(200);
  const allowed=await call(room.id,"allowed");expect(allowed.statusCode).toBe(200);expect(allowed.json().result.structuredContent.status).toBe("COMPLETED");
  const other=store.createRoom({name:"Other",initialPaneCount:0,kind:"AGENT_PROOF"});
  expect((await call(other.id,"foreign")).json().error).toBeDefined();expect(store.getRoom(other.id).name).toBe("Other");
  expect((await grant(false)).statusCode).toBe(200);expect((await call(room.id,"revoked")).statusCode).toBe(403);
  expect((await grant(true)).statusCode).toBe(200);
  store.updatePaneCliSession(session.sessionId,{isActive:false,status:"EXITED"});
  expect((await call(room.id,"exited")).statusCode).toBe(403);
 });
 it("refuses the CLI control token in a pane a USER opened and in a USER's room; the operator's panes keep it (MU-009)",async()=>{
  const {app,store,room}=await fixture();store.upsertUser({id:"user:member",role:"USER",email:"member@space.local"});
  const memberRoom=store.createRoom({name:"Member room",initialPaneCount:0,kind:"AGENT_PROOF"},undefined,"user:member");
  const call=async(roomId:string,opener:string|null)=>{
   const pane=store.createPane({roomId,title:"Codex",mode:"TERMINAL",terminalRuntimeId:"cli:codex",cwd:"/etc"});if(opener)store.setPaneOwner(pane.id,opener);
   const session=store.createPaneCliSession({paneId:pane.id,roomId,runtimeId:"cli:codex",providerId:"codex",agentId:"codex",modelId:"test",reasoningEffort:"medium",cwd:"/etc",status:"RUNNING",statusReason:"test",isActive:true});
   const token=issueControlToken(secret,{roomId,paneId:pane.id,cliSessionId:session.sessionId})!;
   return app.inject({method:"POST",url:"/api/cli/control/mcp",headers:{"x-space-control-token":token},payload:{jsonrpc:"2.0",id:1,method:"tools/list"}});
  };
  for(const roomId of [room.id,memberRoom.id])expect((await app.inject({method:"POST",url:"/api/control/v1/grant",headers:headers(),payload:{roomId,enabled:true}})).statusCode).toBe(200);
  expect((await call(room.id,null)).statusCode).toBe(200);expect((await call(room.id,"user:ADMIN")).statusCode).toBe(200);
  for(const refused of [await call(room.id,"user:member"),await call(memberRoom.id,null)]){expect(refused.statusCode).toBe(403);expect(refused.json().error.code).toBe("CONTROL_PANE_NOT_GRANTED");}
 });
 it("gives a CLI call without a roomId its token's room and still refuses another room",async()=>{
  const {app,store,room}=await fixture();
  const pane=store.createPane({roomId:room.id,title:"Hermes",mode:"TERMINAL",terminalRuntimeId:"cli:hermes",cwd:"/etc"});
  const session=store.createPaneCliSession({paneId:pane.id,roomId:room.id,runtimeId:"cli:hermes",providerId:"hermes",agentId:"hermes",modelId:"test",reasoningEffort:"medium",cwd:"/etc",status:"RUNNING",statusReason:"test",isActive:true});
  const token=issueControlToken(secret,{roomId:room.id,paneId:pane.id,cliSessionId:session.sessionId})!;
  expect((await app.inject({method:"POST",url:"/api/control/v1/grant",headers:headers(),payload:{roomId:room.id,enabled:true}})).statusCode).toBe(200);
  const call=async(name:string,args?:unknown)=>(await app.inject({method:"POST",url:"/api/cli/control/mcp",headers:{"x-space-control-token":token},payload:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}}})).json();
  const state=await call("space_inspect",{section:"STATE"});
  expect(state.error).toBeUndefined();expect(state.result.structuredContent.room.id).toBe(room.id);
  expect((await call("space_test_mcp_tools",undefined)).error).toBeUndefined();
  const renamed=await call("space_execute",{requestId:"no-room",actions:[{kind:"room",operation:"rename",name:"Defaulted"}]});
  expect(renamed.result.structuredContent.status).toBe("COMPLETED");expect(store.getRoom(room.id).name).toBe("Defaulted");
  const other=store.createRoom({name:"Other",initialPaneCount:0,kind:"AGENT_PROOF"});
  expect((await call("space_inspect",{roomId:other.id,section:"STATE"})).error.message).toBe("CLI control grant is restricted to its own room.");
  expect((await call("space_inspect",["not","an","object"])).error.message).toBe("CLI control grant is restricted to its own room.");
  // The static tool catalog takes no room, so its strict schema never accepted one from a CLI before.
  expect((await call("space_list_mcp_tools",{category:"mcp"})).error).toBeUndefined();
 });

 it("gives a CLI call without roomId its own room and still refuses another room",async()=>{
  const {app,store,room}=await fixture();
  const pane=store.createPane({roomId:room.id,title:"Droid",mode:"TERMINAL",terminalRuntimeId:"cli:droid",cwd:"/etc"});
  const session=store.createPaneCliSession({paneId:pane.id,roomId:room.id,runtimeId:"cli:droid",providerId:"droid",agentId:"droid",modelId:"test",reasoningEffort:"medium",cwd:"/etc",status:"RUNNING",statusReason:"test",isActive:true});
  const token=issueControlToken(secret,{roomId:room.id,paneId:pane.id,cliSessionId:session.sessionId})!;
  expect((await app.inject({method:"POST",url:"/api/control/v1/grant",headers:headers(),payload:{roomId:room.id,enabled:true}})).statusCode).toBe(200);
  const call=(name:string,args?:unknown)=>app.inject({method:"POST",url:"/api/cli/control/mcp",headers:{"x-space-control-token":token},payload:{jsonrpc:"2.0",id:1,method:"tools/call",params:args===undefined?{name}:{name,arguments:args}}});
  const capabilities=(await call("space_capabilities")).json();
  expect(capabilities.error).toBeUndefined();expect(capabilities.result.structuredContent.roomId).toBe(room.id);
  const inspect=(await call("space_inspect",{section:"STATE"})).json();
  expect(inspect.error).toBeUndefined();expect(inspect.result.structuredContent.room.id).toBe(room.id);
  const renamed=(await call("space_execute",{requestId:"implicit-room",actions:[{kind:"room",operation:"rename",name:"Implicit"}]})).json();
  expect(renamed.result.structuredContent.status).toBe("COMPLETED");expect(store.getRoom(room.id).name).toBe("Implicit");
  const other=store.createRoom({name:"Other",initialPaneCount:0,kind:"AGENT_PROOF"});
  expect((await call("space_inspect",{roomId:other.id})).json().error.message).toBe("CLI control grant is restricted to its own room.");
  expect((await call("space_execute",[{roomId:other.id}])).json().error).toBeDefined();
  expect((await call("space_list_mcp_tools",{})).json().error).toBeUndefined();
 });

 it("splits a pane through the real single-pane endpoint",async()=>{
  const {app,store,room}=await fixture();
  const pane=store.createPane({roomId:room.id,title:"Browser",mode:"BROWSER"});
  const result=await app.inject({method:"POST",url:"/api/control/v1/commands",headers:headers(),payload:{roomId:room.id,requestId:"split",actions:[{kind:"resource",operation:"panes.split",id:pane.id,input:{direction:"vertical"}}]}});
  expect(result.statusCode).toBe(200);expect(result.json().status).toBe("COMPLETED");
  const panes=store.listPanes(room.id);expect(panes).toHaveLength(2);
  expect(panes.find(p=>p.id!==pane.id)?.mode).toBe("BROWSER");
 });

});
