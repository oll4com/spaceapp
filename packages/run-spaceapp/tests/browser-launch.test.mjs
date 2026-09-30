import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeCommand} from '../src/cli.mjs';
test('a persistent Linux browser survives after the launcher returns, while immediate launch errors are reported',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spaceapp-browser-'));const previous=process.env.PATH;let pid;
 try{
  const path=join(root,'xdg-open'),pidFile=join(root,'pid');
  await writeFile(path,`#!/bin/sh\necho $$ > '${pidFile}'\nexec /bin/sleep 30\n`,{mode:0o700});
  process.env.PATH=root;
  const start=Date.now();assert.equal(await executeCommand({command:'xdg-open',args:['http://127.0.0.1:4911'],background:true}),0);
  assert.ok(Date.now()-start<3000);pid=Number((await readFile(pidFile,'utf8')).trim());process.kill(pid,0);
  await writeFile(path,'#!/bin/sh\nexit 7\n',{mode:0o700});
  assert.equal(await executeCommand({command:'xdg-open',args:['http://127.0.0.1:4911'],background:true}),7);
  await rm(path);assert.equal(await executeCommand({command:'xdg-open',args:['http://127.0.0.1:4911'],background:true}),127);
 }finally{process.env.PATH=previous;if(pid)try{process.kill(-pid,'SIGTERM');}catch{}await rm(root,{recursive:true,force:true});}
});
