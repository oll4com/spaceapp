import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { calculateStoragePlan, estimateMissingLayers, inspectStoragePlan, storageChecks } from "../src/storage.mjs";
import { composeCommand, initializeInstallation, installResourceChecks, renderRuntimeEnv } from "../src/index.mjs";
import { run } from "../src/cli.mjs";
const GiB = 1024 ** 3;
const imageId = "sha256:" + "a".repeat(64);
const resources = { cpuCount: 8, totalMemoryBytes: 16 * GiB, freeDiskBytes: 2.1 * GiB };

test("cached-image upgrade needs checkpoint and headroom rather than fresh-install space", () => {
  const plan = calculateStoragePlan({ operation: "upgrade", profile: "small", databaseBytes: 100 * 1024 ** 2 });
  assert.ok(plan.requiredDiskBytes < GiB);
  assert.equal(storageChecks({ ...plan, dockerFreeDiskBytes: GiB }, resources).every(x => x.ok), true);
  assert.equal(installResourceChecks(resources, "small").at(-1).ok, false);
  assert.equal(storageChecks({ ...plan, dockerFreeDiskBytes: 100 * 1024 ** 2 }, resources).at(-1).ok, false);
  assert.ok(calculateStoragePlan({ operation: "upgrade", profile: "small", databaseBytes: 3 * GiB }).requiredDiskBytes > resources.freeDiskBytes);
});

test("shared layers are excluded; changed layers retain extraction headroom", () => {
  assert.equal(estimateMissingLayers([{size:100*1024**2},{size:20*1024**2}], ["same","new"], new Set(["same"])), 100 * 1024 ** 2);
  assert.throws(() => estimateMissingLayers([{size:-1}], ["new"], new Set()), /Invalid/);
});

test("small omits optional services, medium keeps workflows, large includes browser", () => {
  for (const [profile, workflows, browser] of [["small",false,false],["medium",true,false],["large",true,true]]) {
    const args = composeCommand("up", tmpdir(), {profile}).args;
    assert.equal(args.includes("workflows"), workflows);
    assert.equal(args.includes("standard"), browser);
    const env = renderRuntimeEnv({schemaVersion:4,version:"1.0.28",previousVersion:null,bindHost:"127.0.0.1",port:4911,telemetry:false,profile,accessMode:"isolated",companionsEnabled:false,workspaces:[]});
    assert.match(env, new RegExp(`SPACEAPP_WORKFLOWS_ENABLED=${workflows}`));
  }
});

async function fixture(t, cached) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-storage-"));
  t.after(() => rm(root, {recursive:true,force:true}));
  await initializeInstallation(root, {version:"1.0.26",profile:"light"});
  let output = ""; const calls=[];
  const stream = new Writable({write(chunk,_encoding,done){output += chunk; done();}});
  const execute = async (spec,io) => {
    calls.push(spec);
    const args=spec.args;
    if (args.includes("inspect")) { if(cached) io.stdout.write(imageId); return cached ? 0 : 1; }
    if (args.includes("SELECT pg_database_size(current_database())")) io.stdout.write("10485760");
    if (args.includes("pg_dump")) io.stdout.write("-- PostgreSQL database dump\nSELECT 1;\n");
    return 0;
  };
  return { root,calls,text:()=>output,execute,options:{env:{SPACEAPP_HOME:root},platform:"linux",stdin:Readable.from([]),stdout:stream,stderr:stream,
    execute,inspectResources:async()=>resources,prepareDockerPath:async()=>{},ensureDocker:async()=>({code:0}),
    request:async()=>({ok:true,json:async()=>({ok:true})}),sleep:async()=>{}} };
}

test("actual update contract succeeds with 2.1 GiB and cached targets while preserving secrets",async(t)=>{
  const f=await fixture(t,true);
  const before=await readFile(join(f.root,"secrets","session-secret"));
  assert.equal(await run(["update","--non-interactive","--answers",'{"confirm":true}'],f.options),0);
  assert.equal((JSON.parse(await readFile(join(f.root,"config.json")))).profile,"light");
  assert.deepEqual(await readFile(join(f.root,"secrets","session-secret")),before);
  assert.match(f.text(),/required additionally for upgrade/);
  assert.doesNotMatch(f.text(),/15 GiB required/);
});

test("unknown uncached target rejects low disk before pull, checkpoint or cutover",async(t)=>{
  const f=await fixture(t,false),before=await readFile(join(f.root,"config.json"));
  assert.equal(await run(["update","--non-interactive","--answers",'{"confirm":true}'],f.options),1);
  assert.deepEqual(await readFile(join(f.root,"config.json")),before);
  assert.equal(f.calls.some(x=>x.args.includes("pull")||x.args.includes("pg_dump")||x.args.includes("up")),false);
});

test("disk is measured again after pull and low remaining space preserves current runtime",async(t)=>{
  const f=await fixture(t,true),before=await readFile(join(f.root,"config.json"));
  let pulled=false;
  f.options.execute=async(spec,io)=>{if(spec.args.at(-1)==="pull")pulled=true; return f.execute(spec,io);};
  f.options.inspectResources=async()=>({...resources,freeDiskBytes:pulled?128*1024**2:resources.freeDiskBytes});
  assert.equal(await run(["update","--non-interactive","--answers",'{"confirm":true}'],f.options),1);
  assert.equal(pulled,true);
  assert.deepEqual(await readFile(join(f.root,"config.json")),before);
  assert.equal(f.calls.some(x=>x.args.includes("pg_dump")||x.args.includes("up")),false);
});

test("Docker CPU and memory allocations constrain the host's resources",async(t)=>{
  const f=await fixture(t,true);
  const config=JSON.parse(await readFile(join(f.root,"config.json")));
  const execute=async(spec,io)=>{
    if(spec.args[0]==="info") {io.stdout.write(JSON.stringify({NCPU:4,MemTotal:8*GiB}));return 0;}
    return f.execute(spec,io);
  };
  const plan=await inspectStoragePlan({root:f.root,config,resources,execute,operation:"repair"});
  assert.equal(plan.resources.engineCpuCount,4);
  assert.equal(plan.resources.engineMemoryBytes,8*GiB);
  assert.equal(plan.resources.totalMemoryBytes,resources.totalMemoryBytes);
  assert.equal(installResourceChecks({...plan.resources,engineMemoryBytes:2*GiB},"small").find(x=>x.name==="Docker memory").ok,false);
});
