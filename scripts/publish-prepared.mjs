#!/usr/bin/env node
// Publish only an already committed, already tested candidate. Never re-export here.
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {checkReleaseEvidence} from './release-evidence.mjs';
const run=(command,args)=>execFileSync(command,args,{stdio:'inherit'});
const git=(args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
try {
 if(git(['branch','--show-current'])!=='main'||git(['status','--porcelain']))throw new Error('Prepared publication requires a clean main checkout');
 await checkReleaseEvidence();
 const pkg=JSON.parse(await readFile('packages/run-spaceapp/package.json','utf8'));
 const args=['scripts/public-release-readiness.mjs','--version',pkg.version,'--runtime-version',pkg.spaceappRuntimeVersion,'--release-mode','full','--npm-tag','next'];
 run(process.execPath,args);
 if(!process.argv.includes('--publish')){console.log('Prepared candidate is publishable. Add --publish to push main and dispatch the gated workflow.');}
 else {
  run('git',['push','origin','main']);
  run(process.env.SPACEAPP_GH_BIN||'gh',['workflow','run','release.yml','--repo','oll4com/spaceapp','--ref','main','-f',`version=${pkg.version}`,'-f',`runtime_version=${pkg.spaceappRuntimeVersion}`,'-f','release_mode=full','-f','npm_tag=next']);
  console.log('Dispatched immutable candidate. Environment review and npm latest promotion remain separate gates.');
 }
}catch(e){console.error(e.message);process.exitCode=1;}
