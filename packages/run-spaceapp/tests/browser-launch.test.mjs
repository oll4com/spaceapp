import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeCommand} from '../src/cli.mjs';
import {ensureDockerAvailable} from '../src/prerequisites.mjs';
// These fixtures execute real POSIX shell scripts; Windows native launch is
// covered by the PowerShell launcher and prerequisite tests.
const posixFixture = { skip: process.platform === 'win32' ? 'requires executable POSIX shell fixtures' : false };
test('a persistent Linux browser survives after the launcher returns, while immediate launch errors are reported',posixFixture,async()=>{
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
test('macOS reports a rejected native Docker launch before waiting for its engine',posixFixture,async()=>{
 const root=await mkdtemp(join(tmpdir(),'spaceapp-mac-open-')),previous=process.env.PATH;
 try{
  const argsFile=join(root,'arguments');
  await writeFile(join(root,'open'),`#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nexit 7\n`,{mode:0o700});
  process.env.PATH=root;let error='';
  const result=await ensureDockerAvailable({platform:'darwin',arch:'x64',env:process.env,
   stdout:{write(){}},stderr:{write(text){error+=text;}},
   execute:async()=>1,pathExists:async path=>path==='/Applications/Docker.app',
   sleep:async()=>{throw Error('Rejected launches must not poll the engine');}});
  assert.equal(result.code,7);assert.match(error,/could not start/i);
  assert.deepEqual((await readFile(argsFile,'utf8')).trim().split('\n'),['-a','/Applications/Docker.app']);
 }finally{process.env.PATH=previous;await rm(root,{recursive:true,force:true});}
});
