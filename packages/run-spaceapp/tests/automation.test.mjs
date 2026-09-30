import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { run } from '../src/cli.mjs';
import { initializeInstallation } from '../src/index.mjs';

function io() {
  let output = '';
  const stream = new Writable({write(c, e, done) { output += c; done(); }});
  return {stream, text: () => output};
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'spaceapp-automation-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const out = io(); const calls = []; const urls = [];
  const options = {
    env: {SPACEAPP_HOME:root, SPACEAPP_TELEMETRY:'0'}, platform:'linux',
    stdin:Readable.from([]), stdout:out.stream, stderr:out.stream,
    prepareDockerPath:async()=>{}, ensureDocker:async()=>({code:0}),
    inspectResources:async()=>({cpuCount:4,totalMemoryBytes:8*1024**3,freeDiskBytes:20*1024**3}),
    execute:async(spec)=>{ calls.push(spec); return 0; }, sleep:async()=>{},
    request:async(url)=>{ urls.push(url); return {ok:true,status:200,json:async()=>url.endsWith('/readyz')?{ok:true}:{setupRequired:true,expiresAt:null}}; }
  };
  return {root,out,calls,urls,options};
}
test('explicit unattended install runs the runtime, opens browser, and leaves owner choice to the user', async(t)=>{
  const f=await fixture(t);
  assert.equal(await run(['install','--non-interactive','--answers',JSON.stringify({confirm:true,profile:'light',access:'isolated',companions:false,telemetry:false,open:true})],f.options),0);
  assert.ok(f.calls.some(x=>x.command==='docker' && x.args.includes('up')));
  assert.ok(f.calls.some(x=>x.command==='xdg-open'));
  assert.ok(f.urls.some(x=>x.endsWith('/readyz')));
  assert.ok(!f.urls.some(x=>x.endsWith('/api/setup/claim')));
  assert.equal(JSON.parse(await readFile(join(f.root,'config.json'),'utf8')).profile,'light');
  assert.match(f.out.text(), /One-time setup token/);
});
test('noninteractive install without explicit confirm:true cannot mutate installation', async(t)=>{
  const f=await fixture(t);
  assert.equal(await run(['install','--non-interactive','--answers','{"profile":"light"}'],f.options),1);
  assert.equal(f.calls.length,0);
  await assert.rejects(readFile(join(f.root,'config.json')),{code:'ENOENT'});
});
test('doctor handles a missing installation and command help works without Docker', async(t)=>{
  const f=await fixture(t);
  assert.equal(await run(['doctor'],f.options),1);
  assert.match(f.out.text(),/FAIL Configuration/);
  f.options.prepareDockerPath=async()=>{ throw new Error('must not probe Docker'); };
  assert.equal(await run(['install','--help'],f.options),0);
});
test('doctor --fix repairs legacy configuration and requires runtime readiness',async(t)=>{
  const f=await fixture(t);
  await initializeInstallation(f.root,{version:'1.0.2'});
  const path=join(f.root,'config.json');
  const before=JSON.parse(await readFile(path,'utf8'));
  before.schemaVersion=3; before.companionsEnabled='false';
  await writeFile(path,JSON.stringify(before));
  assert.equal(await run(['doctor','--fix','--non-interactive','--answers','{"confirm":true}'],f.options),0);
  assert.equal(JSON.parse(await readFile(path,'utf8')).companionsEnabled,false);
  assert.ok(f.urls.some(x=>x.endsWith('/readyz')));
  assert.ok(!f.calls.some(x=>x.args.includes('--volumes')));
});

test('an empty database checkpoint prevents upgrade even when pg_dump exits zero',async(t)=>{
  const f=await fixture(t);await initializeInstallation(f.root,{version:'0.1.29'});
  const before=await readFile(join(f.root,'config.json'),'utf8');
  await assert.rejects(run(['install','--non-interactive','--answers','{"confirm":true,"open":false}'],f.options),/dump failed or was empty/);
  assert.equal(await readFile(join(f.root,'config.json'),'utf8'),before);
  assert.ok(!f.calls.some(x=>x.args.includes('up')));
});
