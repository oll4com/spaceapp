import { mkdir, access, rm, writeFile } from 'node:fs/promises';
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
  claude:{package:'@anthropic-ai/claude-code@2.1.206',bin:'claude'}
});
function execute(command,args){return new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Provider installation exited ${code}`)));});}
export async function installProvider(name,root='/var/lib/spaceapp-cli/vendor') {
  const entry=providers[name];
  if(!entry)throw new Error(`Unsupported optional provider: ${name}`);
  const directory=join(root,name);
  const bin=entry.archive?join(directory,entry.bin):join(directory,'node_modules','.bin',entry.bin);
  try {await access(bin);return bin;}catch{}
  await mkdir(directory,{recursive:true});
  const lock=join(directory,'.install-lock');
  try{await mkdir(lock);}catch{throw new Error(`${name} installation is already running. Retry after it completes.`);}
  try{
    process.stderr.write(`Installing optional provider ${name}. This happens only on first use.\n`);
    if(entry.archive) {
      if(!['x64','arm64'].includes(process.arch))throw new Error('Unsupported Cursor architecture');
      const url=`https://downloads.cursor.com/lab/2026.07.23-e383d2b/linux/${process.arch}/agent-cli-package.tar.gz`;
      const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
      if(!response.ok)throw new Error(`Cursor download HTTP ${response.status}`);
      const archive=join(directory,'package.tar.gz');
      try {await writeFile(archive,Buffer.from(await response.arrayBuffer()));await execute('tar',['-xzf',archive,'-C',directory,'--strip-components=1']);}finally{await rm(archive,{force:true});}
    } else await execute('npm',['install','--prefix',directory,'--no-audit','--no-fund',entry.package]);
    await access(bin);return bin;
  }finally{await rm(lock,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url)) installProvider(process.argv[2]).catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
