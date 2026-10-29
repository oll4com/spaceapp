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
test('no version after 1.1.6 has a Zen exception: the former 1.1.7 label waives nothing',()=>{
 for(const version of ['1.1.7','1.1.8']){
  const e=complete();e.launcherVersion=version;e.runtimeVersion=version;e.checks=e.checks.filter(x=>x.scenario!=='first-agent');
  e.knownExceptions=['linux','windows','macos'].map(platform=>({platform,scenario:'first-agent',decision:'zen-refusal-1.1.7',reason:'OpenCode Zen upstream refusal'}));
  assert.equal(validateEvidence(e,{digest:'source',version,runtime:version,now}).length,3,version);
 }
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
test('the 1.1.9 Zen exception (operator decision 54b65a84) covers only a named first-agent proof of 1.1.9',()=>{
 const v119={digest:'source',version:'1.1.9',runtime:'1.1.9',now};
 const withoutWindows=(version)=>{const e=complete();e.launcherVersion=version;e.runtimeVersion=version;e.checks=e.checks.filter(x=>!(x.platform==='windows'&&x.scenario==='first-agent'));return e;};
 const named=(platforms,decision='54b65a84')=>platforms.map(platform=>({platform,scenario:'first-agent',decision,reason:'OpenCode Zen free limit (provider.quota) on the lab address'}));
 const passes=withoutWindows('1.1.9');passes.knownExceptions=named(['windows']);
 assert.deepEqual(validateEvidence(passes,v119),[]);
 assert.deepEqual(validateEvidence(withoutWindows('1.1.9'),v119),['windows/first-agent: missing real successful proof']);
 // Only 1.1.9's own decision, only the named platform, only first-agent; the Linux and macOS first answers stay required.
 const oldDecision=withoutWindows('1.1.9');oldDecision.knownExceptions=named(['windows'],'efc30984');
 assert.equal(validateEvidence(oldDecision,v119).length,1);
 const v1110=withoutWindows('1.1.10');v1110.knownExceptions=named(['windows']);
 assert.equal(validateEvidence(v1110,{...v119,version:'1.1.10',runtime:'1.1.10'}).length,1);
 const linuxToo=withoutWindows('1.1.9');linuxToo.checks=linuxToo.checks.filter(x=>!(x.platform==='linux'&&x.scenario==='first-agent'));linuxToo.knownExceptions=named(['windows']);
 assert.deepEqual(validateEvidence(linuxToo,v119),['linux/first-agent: missing real successful proof']);
 const otherScenario=withoutWindows('1.1.9');otherScenario.knownExceptions=named(['windows']);otherScenario.checks=otherScenario.checks.filter(x=>!(x.platform==='windows'&&x.scenario==='upgrade'));
 assert.deepEqual(validateEvidence(otherScenario,v119),['windows/upgrade: missing real successful proof']);
});
