import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEvidence} from '../release-evidence.mjs';
const now=Date.now();
const context={digest:'source',version:'1.0.12',runtime:'1.0.12',now};
function complete(){return {schemaVersion:1,candidateDigest:'source',launcherVersion:'1.0.12',runtimeVersion:'1.0.12',createdAt:new Date(now).toISOString(),checks:['linux','windows','macos'].flatMap(platform=>['fresh-install','upgrade','repair','docker-stopped','first-agent','profiles'].map(scenario=>({platform,scenario,pass:true,executed:true,exitCode:0,ready:true,artifactSha256:'a'.repeat(64),dataPreserved:true,dockerInitiallyStopped:true,nativeTaskId:'ses_proof',responseObserved:true,uiOpened:true,freeModel:true,interactiveDesktop:true,profilesObserved:['small','medium','large']})))}}
test('missing, stale, changed and plan-only evidence all block publication',()=>{
 assert.ok(validateEvidence(null,context).length);
 assert.deepEqual(validateEvidence(complete(),context),[]);
 for(const change of [e=>e.candidateDigest='old',e=>e.checks[0].executed=false,e=>e.checks.pop(),e=>e.createdAt='2000-01-01',e=>e.checks.find(x=>x.platform==='windows'&&x.scenario==='upgrade').dataPreserved=false,e=>e.checks.find(x=>x.platform==='windows').interactiveDesktop=false,e=>e.checks.find(x=>x.scenario==='profiles').profilesObserved=['small']]){const e=complete();change(e);assert.ok(validateEvidence(e,context).length);}
});
