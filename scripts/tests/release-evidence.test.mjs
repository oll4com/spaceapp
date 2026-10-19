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
test('the 1.1.6-only Zen exception (operator decision efc30984) covers only a named first-agent proof of 1.1.6',()=>{
 const v116={digest:'source',version:'1.1.6',runtime:'1.1.6',now};
 const without=(versions)=>{const e=complete();e.launcherVersion=versions;e.runtimeVersion=versions;e.checks=e.checks.filter(x=>x.scenario!=='first-agent');return e;};
 const named=(platforms)=>platforms.map(platform=>({platform,scenario:'first-agent',decision:'efc30984',reason:'OpenCode Zen upstream refusal'}));
 const passes=without('1.1.6');passes.knownExceptions=named(['linux','windows','macos']);
 assert.deepEqual(validateEvidence(passes,v116),[]);
 assert.deepEqual(validateEvidence(without('1.1.6'),v116),['linux/first-agent: missing real successful proof','windows/first-agent: missing real successful proof','macos/first-agent: missing real successful proof']);
 const otherDecision=without('1.1.6');otherDecision.knownExceptions=named(['linux','windows','macos']).map(x=>({...x,decision:'other'}));
 assert.equal(validateEvidence(otherDecision,v116).length,3);
 const onePlatform=without('1.1.6');onePlatform.knownExceptions=named(['linux']);
 assert.deepEqual(validateEvidence(onePlatform,v116),['windows/first-agent: missing real successful proof','macos/first-agent: missing real successful proof']);
 const v117=without('1.1.7');v117.knownExceptions=named(['linux','windows','macos']);
 assert.equal(validateEvidence(v117,{...v116,version:'1.1.7',runtime:'1.1.7'}).length,3);
 const otherScenario=complete();otherScenario.launcherVersion='1.1.6';otherScenario.runtimeVersion='1.1.6';otherScenario.checks=otherScenario.checks.filter(x=>!(x.platform==='linux'&&x.scenario==='upgrade'));otherScenario.knownExceptions=[{platform:'linux',scenario:'upgrade',decision:'efc30984'}];
 assert.deepEqual(validateEvidence(otherScenario,v116),['linux/upgrade: missing real successful proof']);
});
