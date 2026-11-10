import type pg from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {InMemorySiteSigninsRepository, PostgresSiteSigninsRepository, type SiteSigninsRepository} from "../src/site-signins-repository.js";
import {searchCopilotMemories} from "../src/copilot-memory-search.js";
import {applyPendingMigrations} from "../src/migration-runner.js";
import {loadMigrations} from "../src/migrations.js";
import {disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres} from "./support/disposable-postgres.js";
const owner="user:signin";
async function exercise(repo: SiteSigninsRepository) {
  await repo.record(owner,{site:"www.upwork.com",accountLabel:"main",outcome:"SUCCESS",method:"GOOGLE",googleAccountEmail:"sso@example.com",siteAccountEmail:"alias@example.com",mailbox:"work@example.com via forwarding",mfa:"security question via vault_key:opaque"},"FREELANCE:pane:one");
  await repo.record(owner,{site:"https://auth.upwork.com/login",accountLabel:"main",outcome:"CHANGED",siteAccountEmail:"new@example.com"},"JOB:pane:two");
  const pending=await repo.record(owner,{site:"upwork.com",accountLabel:"main",outcome:"PENDING",method:"VAULT_LOGIN",vaultHandle:"vault_item:opaque"},"VAULT:pane:two");
  expect(pending).toMatchObject({method:"GOOGLE",successCount:1,pendingAttempt:{vaultHandle:"vault_item:opaque"}});
  const failed=await repo.record(owner,{site:"upwork.com",accountLabel:"main",outcome:"FAILURE",reason:"account challenge"},"JOB:pane:two");
  expect(failed).toMatchObject({method:"GOOGLE",siteAccountEmail:"new@example.com",googleAccountEmail:"sso@example.com",successCount:1,lastFailureReason:"account challenge",pendingAttempt:null});
  expect(failed.lastSuccessBy).toBe("FREELANCE:pane:one");
  await repo.record(owner,{site:"confirm.example.net",accountLabel:"main",outcome:"CHANGED",method:"GOOGLE"},"seed");
  await repo.record(owner,{site:"confirm.example.net",accountLabel:"main",outcome:"PENDING",method:"VAULT_LOGIN",vaultHandle:"vault_item:confirmed",browserProfileId:"profile:confirmed"},"VAULT:pane:two");
  const confirmed = await repo.record(owner,{site:"example.net",accountLabel:"main",outcome:"SUCCESS"},"JOB:pane:two");
  expect(confirmed).toMatchObject({method:"VAULT_LOGIN",vaultHandle:"vault_item:confirmed",browserProfileId:"profile:confirmed",successCount:1,pendingAttempt:null});
  await repo.record(owner,{site:"example.net",accountLabel:"main",outcome:"PENDING",method:"VAULT_LOGIN",vaultHandle:"vault_item:other"},"VAULT:pane:two");
  const sso = await repo.record(owner,{site:"example.net",accountLabel:"main",outcome:"SUCCESS",method:"GOOGLE"},"JOB:pane:two");
  expect(sso.method).toBe("GOOGLE");
  expect(sso.vaultHandle).toBe("vault_item:confirmed");
  await Promise.all(Array.from({length:8},()=>repo.record(owner,{site:"upwork.com",accountLabel:"main",outcome:"SUCCESS"},"JOB:pane:two")));
  expect((await repo.get(owner,"www.upwork.com"))?.successCount).toBe(9);
  expect(await repo.get("user:other","upwork.com")).toBeNull();
  expect(await repo.list("user:other")).toEqual([]);
  expect((await repo.list(owner)).length).toBe(2);
  await repo.record(owner,{site:"upwork.com",accountLabel:"other",outcome:"CHANGED",method:"EMAIL_CODE"},"MAIL:pane:three");
  expect((await repo.list(owner)).length).toBe(3);
  const old=await repo.record(owner,{site:"old.example.com",accountLabel:"main",outcome:"CHANGED",method:"GOOGLE"},"seed","2020-01-01T00:00:00.000Z");
  expect(old.history.length).toBe(1);
  const fresh=await repo.record(owner,{site:"example.com",accountLabel:"main",outcome:"SUCCESS"},"JOB:pane:two");
  expect(fresh.history.length).toBe(1); // recipe survives; obsolete change log expires
  expect(fresh.method).toBe("GOOGLE");
}
describe("site sign-ins in memory",()=>{it("preserves recipes and owners across changes, failures and concurrent successes",async()=>exercise(new InMemorySiteSigninsRepository()));});
const unavailable=disposablePostgresUnavailableReason();
describe.skipIf(unavailable!==null)(`site sign-ins on PostgreSQL${unavailable ? ` (${unavailable})`:""}`,()=>{
 let server:DisposablePostgres,pool:pg.Pool,repo:PostgresSiteSigninsRepository;
 beforeAll(async()=>{server=await startDisposablePostgres("site-signins");await server.createDatabase("space_signins");pool=server.pool("space_signins",4);const client=await pool.connect();try{await applyPendingMigrations(client,await loadMigrations());}finally{client.release();}await pool.query("INSERT INTO users(id,email,role) VALUES($1,'signin@space.local','OPERATOR')",[owner]);repo=new PostgresSiteSigninsRepository(pool);},120000);
 afterAll(async()=>{await pool?.end();await server?.stop();});
 it("atomically preserves recipes, isolates owners and exposes sign-in facts through recall",async()=>{
   await exercise(repo);
   expect(await searchCopilotMemories(pool,owner,"sso@example.com")).toEqual(expect.arrayContaining([expect.objectContaining({source:"site sign-in upwork.com",text:expect.stringContaining("new@example.com")})]));
   expect(await searchCopilotMemories(pool,"user:other","sso@example.com")).toEqual([]);
 });
});
