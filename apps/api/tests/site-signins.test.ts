import Fastify from "fastify";
import {describe, expect, it} from "vitest";
import type {BrowserHandoffRequest} from "@space/contracts";
import type {SpaceStore} from "@space/runtime";
import {registerSiteSignins, registerSiteSigninAgentRoutes, recordCompletedSiteHandoff, signinHandoffRecipe} from "../src/site-signins.js";
import {isCliBridgeRoutePath} from "../src/cli-bridge-paths.js";
import {registerFreelanceCopilotAgentRoutes} from "../src/freelance-copilot/agent-routes.js";
import {defaultFreelanceCopilotPaneMetadata} from "@space/contracts";
import {createNousTools} from "../src/nous/tools.js";
import * as bootstrap from "../src/agent-bootstrap.js";

function setup() {
 const app=Fastify();
 const store={getRoom: async(id:string)=>({ownerUserId:id==="room:b"?"user:b":"user:a"}),
   getPane:async(id:string)=>({id,roomId:"room:a",mode:"FREELANCE_COPILOT",freelanceCopilotMetadata:defaultFreelanceCopilotPaneMetadata()}),
   listActivePaneBrowserSessions:async()=>[{paneId:"pane:a",currentUrl:"https://accounts.google.com"}]} as unknown as SpaceStore;
 const repo=registerSiteSignins(app,store);
 registerSiteSigninAgentRoutes(app,{store,requireBridge:async(req,reply)=>{const token=req.headers["x-test-token"];if(!["a","b"].includes(String(token))){reply.code(401).send();return null;}return {claims:{roomId:`room:${token}`,paneId:`pane:${token}`}};}});
 const post=(body:unknown,token="a")=>app.inject({method:"POST",url:"/api/cli/site-signins",headers:{"x-test-token":token},payload:body as never});
 return {app,store,repo,post};
}
describe("shared site sign-in API",()=>{
 it("reads and records recipes through the authenticated owner bridge and refuses credential fields",async()=>{
  const {app,post}=setup();try{
   expect(isCliBridgeRoutePath("/api/cli/site-signins")).toBe(true);
   expect(isCliBridgeRoutePath("/api/cli/site-signins-extra")).toBe(false);
   expect((await post({site:"upwork.com",outcome:"SUCCESS",method:"GOOGLE",googleAccountEmail:"sso@example.com"})).statusCode).toBe(200);
   const get=await app.inject({url:"/api/cli/site-signins?site=auth.upwork.com",headers:{"x-test-token":"a"}});
   expect(get.json().signin).toMatchObject({method:"GOOGLE",successCount:1,lastSuccessBy:"FREELANCE_COPILOT:pane:a"});
   const cred=await app.inject({url:`/api/cli/site-signins?site=${encodeURIComponent("https://u:pw@www.upwork.com/nx/login")}`,headers:{"x-test-token":"a"}});
   expect(cred.json().signin).toMatchObject({site:"upwork.com",method:"GOOGLE"});expect(cred.body).not.toMatch(/u:pw|pw@/);
   expect((await app.inject({url:"/api/cli/site-signins?site=upwork.com",headers:{"x-test-token":"b"}})).json()).toEqual({signin:null});
   const name=await app.inject({url:"/api/cli/site-signins?site=Braintrust",headers:{"x-test-token":"a"}});
   expect(name.statusCode).toBe(200);expect(name.json()).toMatchObject({signin:null,note:expect.stringMatching(/^"Braintrust" is not a site domain/)});
   expect((await post({site:"upwork.com",outcome:"CHANGED",password:"synthetic-should-never-be-stored"})).statusCode).toBeGreaterThanOrEqual(400);
   expect((await app.inject({url:"/api/cli/site-signins?site=upwork.com"})).statusCode).toBe(401);
  }finally{await app.close();}
 });
 it("returns the stored method before LOGIN/MFA handoff, preserves it after success, and ignores CAPTCHA completions",async()=>{
  const {app,store,repo}=setup();try{
   await repo.record("user:a",{site:"upwork.com",accountLabel:"main",outcome:"CHANGED",method:"GOOGLE",mailbox:"work@example.com"},"seed");
   expect(await signinHandoffRecipe(store,"user:a","https://www.upwork.com")).toMatchObject({blocked:true,signin:{method:"GOOGLE",mailbox:"work@example.com"}});
   expect((await signinHandoffRecipe(store,"user:a","https://upwork.com",true)).blocked).toBe(false);
   const handoff={handoffRequestId:"handoff:one",paneId:"pane:a",roomId:"room:a",reason:"LOGIN: [site:upwork.com] stored method tried"} as BrowserHandoffRequest;
   await recordCompletedSiteHandoff(store,handoff);await recordCompletedSiteHandoff(store,handoff);
   expect(await repo.get("user:a","upwork.com")).toMatchObject({method:"GOOGLE",successCount:1});
   await recordCompletedSiteHandoff(store,{...handoff,reason:"CAPTCHA: challenge"});
   expect((await repo.get("user:a","upwork.com"))?.successCount).toBe(1);
   await recordCompletedSiteHandoff(store,{...handoff,handoffRequestId:"handoff:two",reason:"MFA: [site:example.com] code"});
   expect(await repo.get("user:a","example.com")).toMatchObject({method:"OTHER",successCount:1});
  }finally{await app.close();}
 });
 it("Freelance state uses the stored SSO, alias and mailbox instead of channel defaults",async()=>{
  const {app,store,repo}=setup();try{
   await repo.record("user:a",{site:"arc.dev",accountLabel:"main",outcome:"CHANGED",method:"GOOGLE",siteAccountEmail:"sso@example.com",mailbox:"inbox@example.com"},"seed");
   registerFreelanceCopilotAgentRoutes(app,{settingsOf:()=>defaultFreelanceCopilotPaneMetadata().settings,listAccounts:async()=>[{channel:"ARC"}],mailboxStatus:async()=>null,runView:async()=>null,funnel:async()=>null} as never,
     {store,routeOptions:{},requireBridge:async()=>({claims:{roomId:"room:a",paneId:"pane:a",cliSessionId:"cli:a"}}),parseBody:(s,b)=>s.parse(b),parseQuery:(s,b)=>s.parse(b),audit:async()=>{}});
   const result=(await app.inject({url:"/api/cli/freelance-copilot/state"})).json();
   expect(result.channels.ARC).toMatchObject({signIn:"GOOGLE",alias:"sso@example.com",mailbox:"inbox@example.com"});
   expect(result.accounts[0].signin.method).toBe("GOOGLE");
  }finally{await app.close();}
 });
 it("Nous reads and writes the same owner-scoped recipe and records its turn as the source", async()=>{
  const {app,repo}=setup();try{
   const nous=createNousTools({siteSignins:repo} as never);
   const ctx={owner:"user:a",turnId:"nous_turn:test",callId:"call:one",traceId:"trace:one"};
   expect((await nous.execute("space_site_signin_record",{site:"auth.example.com",outcome:"SUCCESS",method:"GOOGLE"},ctx)).ok).toBe(true);
   const got=await nous.execute("space_site_signin_get",{site:"example.com"},ctx);
   expect(JSON.parse(got.result)).toMatchObject({site:"example.com",method:"GOOGLE",lastSuccessBy:"NOUS:nous_turn:test"});
   expect((await nous.execute("space_site_signin_get",{site:"example.com"},{...ctx,owner:"user:b"})).result).toBe("null");
   const name=await nous.execute("space_site_signin_get",{site:"Braintrust"},ctx);
   expect(name).toMatchObject({ok:true});expect(name.result).toMatch(/^null: "Braintrust" is not a site domain/);
   await repo.record("user:a",{site:"usebraintrust.com",accountLabel:"main",outcome:"SUCCESS",method:"GOOGLE"},"seed");
   expect(JSON.parse((await nous.execute("space_site_signin_get",{site:"Braintrust"},ctx)).result)).toMatchObject({site:"usebraintrust.com",method:"GOOGLE"});
   expect((await nous.execute("space_site_signin_get",{site:"Braintrust"},{...ctx,owner:"user:b"})).result).toMatch(/^null: "Braintrust" is not a site domain/);
   for(const form of ["APP.UseBraintrust.com.","usebraintrust.com/login?next=1","HTTPS://usebraintrust.com./x"]) expect(JSON.parse((await nous.execute("space_site_signin_get",{site:form},ctx)).result)).toMatchObject({site:"usebraintrust.com"});
   // 2026-11-22 REVIEW: a public URL with credentials and a path reads its domain's recipe; the credentials never echo.
   const cred=await nous.execute("space_site_signin_get",{site:"https://user:pw@app.usebraintrust.com/login?next=1"},ctx);
   expect(JSON.parse(cred.result)).toMatchObject({site:"usebraintrust.com"});expect(cred.result+cred.display).not.toMatch(/user:|pw@/);
   const local=await nous.execute("space_site_signin_get",{site:"https://user:pw@localhost"},ctx);expect(local.display).toBe("No site sign-in for https://localhost");
   for(const site of ["user:pw@10.0.0.1","https://user:pw@intranet","https://user:p@ss@intranet"]) expect((await nous.execute("space_site_signin_get",{site},ctx)).display).not.toMatch(/user|pw|ss@/);
   expect(local.result).toBe('null: "localhost" is not a site domain or http(s) URL of a public site (no IP address, localhost or local name) and must carry no user name or password; ask again with its public domain (e.g. app.example.com)');
   for(const form of ["Braintrust (usebraintrust.com)","<https://app.usebraintrust.com/login>","\"usebraintrust.com\""]) expect(JSON.parse((await nous.execute("space_site_signin_get",{site:form},ctx)).result)).toMatchObject({site:"usebraintrust.com"});
   // Daily Nous errors 21/11 (02:19Z ZodError on a bare site): a bare name or bare domain of one stored site answers with that site, never a failure.
   await repo.record("user:a",{site:"upwork.com",accountLabel:"main",outcome:"SUCCESS",method:"VAULT_LOGIN"},"seed");
   for(const form of ["upwork","Upwork","upwork.com","UPWORK.COM","www.upwork.com/nx/find-work/"]){const got=await nous.execute("space_site_signin_get",{site:form},ctx);expect(got.ok).toBe(true);expect(JSON.parse(got.result)).toMatchObject({site:"upwork.com",method:"VAULT_LOGIN"});}
   expect((await nous.execute("space_site_signin_get",{site:"usebraintrust.com or example.com"},ctx)).result).toMatch(/^null: .* is not a site domain/);
   // record: a non-domain site is a hold (refused, no ZodError failure); one domain in the text is recorded under it; credentials never echo.
   for(const site of ["Braintrust","https://user:pw@usebraintrust.com"]){const r=await nous.execute("space_site_signin_record",{site,outcome:"SUCCESS",method:"GOOGLE"},ctx);expect(r).toMatchObject({ok:false,refused:true});expect(r.result).toMatch(/^Nothing recorded: /);expect(r.result).not.toMatch(/user:|pw@/);}
   expect(JSON.parse((await nous.execute("space_site_signin_record",{site:"Acme (app.acme-signin.com)",outcome:"SUCCESS",method:"GOOGLE"},ctx)).result)).toMatchObject({site:"acme-signin.com"});
  }finally{await app.close();}
 });
 it("includes the mandatory read/save rule in bootstrap and every copilot persona",()=>{
  expect(bootstrap.buildCliAgentBootstrapMarkdown()).toContain(bootstrap.SITE_SIGNIN_RULE);
  for(const build of [bootstrap.buildJobCopilotPersonaMarkdown,bootstrap.buildMailCopilotPersonaMarkdown,bootstrap.buildFreelanceCopilotPersonaMarkdown,bootstrap.buildMarketingCopilotPersonaMarkdown,bootstrap.buildSecurityCopilotPersonaMarkdown,bootstrap.buildMonitoringCopilotPersonaMarkdown,bootstrap.buildAppStudioPersonaMarkdown,bootstrap.buildDesignPersonaMarkdown,bootstrap.buildVideoPersonaMarkdown]) expect(build()).toContain(bootstrap.SITE_SIGNIN_RULE);
 });
});
