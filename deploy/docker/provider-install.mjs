import { createHash } from 'node:crypto';
import { mkdir, access, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const providers=Object.freeze({
  cursor:{bin:'cursor-agent',archive:true},
  codex:{package:'@openai/codex@0.145.0',bin:'codex'},
  gemini:{package:'@google/gemini-cli@0.52.0',bin:'gemini'},
  qwen:{package:'@qwen-code/qwen-code@0.20.1',bin:'qwen'},
  kimi:{package:'@moonshot-ai/kimi-code@0.29.0',bin:'kimi'},
  grok:{package:'@xai-official/grok@0.2.111',bin:'grok'},
  autohand:{package:'autohand-cli@0.9.3',bin:'autohand'},
  copilot:{package:'@github/copilot@1.0.78',bin:'copilot'},
  deepseek:{package:'run-deepseek-cli@0.1.1',bin:'deepseek-cli'},
  claude:{package:'@anthropic-ai/claude-code@2.1.301',bin:'claude',allowScripts:true}
});
// npm 11 runs a dependency's install scripts only with an allow-scripts warning unless package.json allowScripts covers
// them, and is moving to blocking them. Claude Code's postinstall puts its native binary in place, so the vendor project
// approves exactly the pinned version (the launcher's provider install claude does the same).
// The pinned Cursor agent build: an archive with any other bytes is refused before it is unpacked (review INT5-C-F14).
export const CURSOR_ARCHIVE_SHA256=Object.freeze({
  x64:'702ad595213bee5df0268be9f80a19f29fcceaa2a42fc55e39f2b5199051f0c4',
  arm64:'f40b99647cb24e0da885e97620a2048034f1fe8961910d573d827d77c4d26dcb'
});
export function verifyCursorArchive(bytes,arch){
  if(createHash('sha256').update(bytes).digest('hex')!==CURSOR_ARCHIVE_SHA256[arch])throw new Error('The Cursor download does not match its pinned checksum; nothing was installed.');
}
export async function approveInstallScripts(directory,spec){
  const file=join(directory,'package.json');
  const manifest=await readFile(file,'utf8').then(JSON.parse).catch(()=>({private:true}));
  manifest.allowScripts={...manifest.allowScripts,[spec]:true};
  await writeFile(file,`${JSON.stringify(manifest,null,2)}\n`);
}
const LOCK_STALE_MS=30*60*1000;
function execute(command,args){return new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Provider installation exited ${code}`)));});}
export async function installProvider(name,root='/var/lib/spaceapp-cli/vendor') {
  const entry=providers[name];
  if(!entry)throw new Error(`Unsupported optional provider: ${name}`);
  const directory=join(root,name);
  const bin=entry.archive?join(directory,entry.bin):join(directory,'node_modules','.bin',entry.bin);
  try {await access(bin);return bin;}catch{}
  await mkdir(directory,{recursive:true});
  const lock=join(directory,'.install-lock');
  // A lock older than any install was left by a killed install (OOM, SIGKILL); it used to block the provider for good.
  const age=await stat(lock).then(info=>Date.now()-info.mtimeMs,()=>0);
  if(age>LOCK_STALE_MS)await rm(lock,{recursive:true,force:true});
  try{await mkdir(lock);}catch(error){
    if(error.code!=='EEXIST')throw error;
    throw new Error(`${name} installation is already running. Retry after it completes.`);
  }
  try{
    process.stderr.write(`Installing optional provider ${name}. This happens only on first use.\n`);
    if(entry.archive) {
      if(!['x64','arm64'].includes(process.arch))throw new Error('Unsupported Cursor architecture');
      const url=`https://downloads.cursor.com/lab/2026.07.23-e383d2b/linux/${process.arch}/agent-cli-package.tar.gz`;
      const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
      if(!response.ok)throw new Error(`Cursor download HTTP ${response.status}`);
      const archive=join(directory,'package.tar.gz');
      const bytes=Buffer.from(await response.arrayBuffer());verifyCursorArchive(bytes,process.arch);
      try {await writeFile(archive,bytes);await execute('tar',['-xzf',archive,'-C',directory,'--strip-components=1']);}finally{await rm(archive,{force:true});}
    } else {
      if(entry.allowScripts)await approveInstallScripts(directory,entry.package);
      await execute('npm',['install','--prefix',directory,'--no-audit','--no-fund',entry.package]);
    }
    await access(bin);return bin;
  }finally{await rm(lock,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url)) installProvider(process.argv[2]).catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
