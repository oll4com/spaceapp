import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const excluded=new Set(['release/acceptance.json']);
export function candidateDigest(root=process.cwd()) {
  const entries=execFileSync('git',['-C',root,'ls-files','-s','-z'],{encoding:'utf8'}).split('\0').filter(Boolean).filter(line=>!excluded.has(line.split('\t')[1]));
  return createHash('sha256').update(entries.sort().join('\0')).digest('hex');
}
// OpenCode Zen refused every free model from the lab's address, so a platform's free-model first answer may be missing
// only for these versions and only when release/acceptance.json names that version's decision for it:
// - 1.1.6: operator decision efc30984 (2026-10-18).
// Every other version, platform and check stays as strict as before. (1.1.7's unused entry zen-refusal-1.1.7 was removed in
// 1.1.8: every 1.1.7 first-agent check passed on a free Zen model.)
const zenFirstAnswerExceptions=Object.freeze({'1.1.6':'efc30984'});
function zenExceptionApplies(evidence,version,platform){
  const decision=Object.hasOwn(zenFirstAnswerExceptions,version)?zenFirstAnswerExceptions[version]:null;
  return Boolean(decision)&&evidence?.launcherVersion===version&&Array.isArray(evidence?.knownExceptions)&&
    evidence.knownExceptions.some(entry=>entry?.platform===platform&&entry?.scenario==='first-agent'&&entry?.decision===decision);
}
export function validateEvidence(evidence,{digest,version,runtime,now=Date.now()}={}) {
  const failures=[];
  if(evidence?.schemaVersion!==1)failures.push('Missing supported evidence schema');
  if(evidence?.candidateDigest!==digest)failures.push('Candidate source differs from tested source');
  if(evidence?.launcherVersion!==version||evidence?.runtimeVersion!==runtime)failures.push('Tested versions do not match package versions');
  const age=now-Date.parse(evidence?.createdAt);
  if(!Number.isFinite(age)||age<0||age>7*86400000)failures.push('Evidence must be at most seven days old');
  for(const platform of ['linux','windows','macos']) {
    for(const scenario of ['fresh-install','upgrade','repair','docker-stopped','first-agent','profiles']) {
      if(scenario==='first-agent'&&zenExceptionApplies(evidence,version,platform))continue;
      const proof=evidence?.checks?.find(x=>x.platform===platform&&x.scenario===scenario);
      if(!proof||proof.pass!==true||proof.executed!==true||proof.exitCode!==0||proof.ready!==true||!proof.artifactSha256?.match(/^[a-f0-9]{64}$/)) {failures.push(`${platform}/${scenario}: missing real successful proof`);continue;}
      if(['upgrade','repair','docker-stopped'].includes(scenario)&&proof.dataPreserved!==true)failures.push(`${platform}/${scenario}: data preservation missing`);
      if(scenario==='docker-stopped'&&proof.dockerInitiallyStopped!==true)failures.push(`${platform}: stopped Docker not exercised`);
      if(scenario==='first-agent'&&(!proof.nativeTaskId||proof.responseObserved!==true||proof.uiOpened!==true||proof.freeModel!==true))failures.push(`${platform}: first agent execution incomplete`);
      if(scenario==='profiles'&&(!['small','medium','large'].every(profile=>proof.profilesObserved?.includes(profile))||proof.dataPreserved!==true))failures.push(`${platform}: three profile transitions and data preservation required`);
      if(platform==='windows'&&proof.interactiveDesktop!==true)failures.push(`windows/${scenario}: graphical sign-in required`);
    }
  }
  return failures;
}
export async function checkReleaseEvidence(root=process.cwd()) {
  const dirty=execFileSync("git",["-C",root,"status","--porcelain"],{encoding:"utf8"}).trim();
  if(dirty) throw new Error("Commit the candidate and acceptance evidence before release validation");
  const pkg=JSON.parse(await readFile(resolve(root,'packages/run-spaceapp/package.json'),'utf8'));
  let evidence=null;try{evidence=JSON.parse(await readFile(resolve(root,'release/acceptance.json'),'utf8'));}catch{}
  const failures=validateEvidence(evidence,{digest:candidateDigest(root),version:pkg.version,runtime:pkg.spaceappRuntimeVersion});
  if(failures.length)throw new Error('Release blocked:\n'+failures.map(x=>' - '+x).join('\n'));
  return evidence;
}
if(process.argv[1]===fileURLToPath(import.meta.url))checkReleaseEvidence().then(()=>console.log('Exact candidate acceptance verified')).catch(e=>{console.error(e.message);process.exitCode=1;});
