import { createHash } from "node:crypto";
export const fixtureComposerText = "SPACE_LOCAL_COMPOSER_PROOF μνήμη φωτογραφία ξανά";
export const fixtureComposerImageName = "space-local-composer-proof.png";
/** Unicode lexical tokenizer v1: words/numbers and each non-space punctuation.
 * These are fixture tokens, not any provider's tokens. No bytes/4 estimation.
 */
export function fixtureTokens(text) { return [...text.matchAll(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)].length; }
export function fixtureLine(index) {
  return `SRM:${String(index).padStart(6,"0")} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda μνήμη 中文 🙂 e\u0301 literal 38;2;255;0;0`;
}
export function fixtureManifest() {
  const hash=createHash("sha256"), checkpoints=[]; let tokens=0,bytes=0,next=0;
  const targets=[10000,25000,50000,75000];
  for(let i=1;i<=6000;i++) {
    const line=fixtureLine(i)+"\n"; tokens+=fixtureTokens(line);bytes+=Buffer.byteLength(line);hash.update(line);
    while(next<targets.length&&tokens>=targets[next])checkpoints.push({targetTokens:targets[next++],line:i,tokens});
  }
  return {version:1,tokenizer:"space-fixture-unicode-lexical-v1",providerTokens:false,logicalLines:6000,tokens,bytes,digest:hash.digest("hex"),checkpoints,maxBytes:16*1024*1024,maxDurationMs:180000};
}
// The fixed process waits for the browser proof before producing output. No shell
// or executable input is accepted. After rendering, one fixed composer probe can be
// acknowledged by byte hash and consumption count; other input is ignored.
export function fixtureProgram() {
  const manifest=fixtureManifest();
  return `(${fixtureProcess.toString()})(${JSON.stringify(manifest)},${fixtureLine.toString()},${JSON.stringify(fixtureComposerText)},${JSON.stringify(fixtureComposerImageName)})`;
}
async function fixtureProcess(manifest,line,composerText,composerImageName) {
  const {once}=await import('node:events');
  const {createHash}=await import('node:crypto');
  process.stdin.setRawMode?.(true);process.stdin.resume();
  let bytes=0,started=false,input='',renderComplete=false,composerInput=Buffer.alloc(0),consumed=0;
  const limit=setTimeout(()=>process.exit(2),manifest.maxDurationMs); limit.unref();
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const write=async data=>{const b=Buffer.isBuffer(data)?data:Buffer.from(data);bytes+=b.length;if(bytes>manifest.maxBytes)process.exit(2);if(!process.stdout.write(b))await once(process.stdout,'drain');};
  await write('SPACE_RENDER_READY\r\n');
  const run=async()=>{
    for(let i=1;i<=6000;i++) {
      const data=Buffer.from('\x1b[38;2;80;190;240m'+line(i)+'\x1b[0m\r\n');
      // Intentionally split CSI and multi-byte UTF-8 boundaries at the producer.
      const split=data.indexOf(Buffer.from('μ'))+1;
      await write(data.subarray(0,3));await write(data.subarray(3,split));await write(data.subarray(split));
      if(i%64===0)await sleep(100);
      if(i===1200){await write('\x1b[?1049h\x1b[2J\x1b[HSPACE_ALT_SCREEN\x1b[?1049l');await sleep(3500);}
      if(i===2400){await write('\x1b[?2026hSPACE_SYNCHRONIZED\r\x1b[2K');await sleep(250);await write('\x1b[?2026l');}
    }
    await write('SRD:'+manifest.digest+'\r\n');
    await sleep(200);
    await write('\x1b[2J\x1b[HSPACE_RENDER_FINAL '+manifest.digest+'\r\nGreek: μνήμη CJK: 中文 emoji: 🙂 combining: é\r\nLiteral ANSI example: 38;2;255;0;0\r\nSPACE_RENDER_COMPLETE\r\n');
    renderComplete=true;
  };
  process.stdin.on('data',data=>{
    input=(input+data.toString()).slice(-128);
    if(!started&&/(?:^|\n)SPACE_LOCAL_COMPOSER_START\n/.test(input)){
      started=true;renderComplete=true;
      // Exercise the normal Codex input-readiness gate, including after reload.
      void write('SPACE_LOCAL_COMPOSER_READY\r\n› ').catch(()=>process.exit(2));
      // The fixed mode selector is control input, not part of the pasted draft.
      return;
    }
    if(!started&&input.includes('SPACE_RENDER_START')){started=true;void run().catch(()=>process.exit(2));}
    if(!renderComplete)return;
    // Buffer bytes, not decoded chunks: the Greek paste may cross UTF-8 boundaries.
    composerInput=Buffer.concat([composerInput,data]);
    if(composerInput.length>8192){composerInput=Buffer.alloc(0);return;}
    for(let end;(end=composerInput.indexOf(13))>=0;){
      const raw=composerInput.subarray(0,end+1);composerInput=composerInput.subarray(end+1);
      const value=raw.subarray(0,-1).toString('utf8'),prefix='\x1b[200~',suffix='\x1b[201~\x1b[200~'+composerText+'\x1b[201~';
      if(!value.startsWith(prefix)||!value.endsWith(suffix))continue;
      const path=value.slice(prefix.length,-suffix.length);
      // The path is never opened, executed, or echoed. Only the fixed fixture
      // photo reference and exact public Greek probe are acknowledged.
      if(!path.startsWith('/')||!path.includes('/cli-uploads/')||!path.endsWith('-'+composerImageName)||path.length>1000||/[\x00-\x1f\x7f-\x9f]/.test(path))continue;
      consumed++;
      void write(`SPACE_LOCAL_COMPOSER_ACK ${consumed} ${raw.length} ${createHash('sha256').update(raw).digest('hex')}\r\n`).catch(()=>process.exit(2));
    }
  });
}

/** Replayed output may repeat an ACK; only the process's counter proves delivery. */
export function createFixtureComposerVerifier() {
  let tail='',consumptions=0,conflicts=0,invalid=0;
  const acknowledgements=new Map();
  return {
    push(data) {
      const text=tail+data,end=text.lastIndexOf('\n');
      if(end<0){tail=text.slice(-4096);return;}
      // The producer writes CRLF; a real PTY with ONLCR adds one more CR.
      // Pipes may preserve CRLF or LF. Payload/count/hash validation stays exact.
      for(const match of text.slice(0,end+1).matchAll(/SPACE_LOCAL_COMPOSER_ACK (\d+) (\d+) ([a-f0-9]{64})\r{0,2}\n/g)) {
        const count=Number(match[1]),bytes=Number(match[2]),digest=match[3];
        if(!Number.isSafeInteger(count)||count<1||count>16||bytes<1||bytes>8192){invalid++;continue;}
        const previous=acknowledgements.get(count);
        if(previous&&(previous.bytes!==bytes||previous.digest!==digest))conflicts++;
        acknowledgements.set(count,{bytes,digest});consumptions=Math.max(consumptions,count);
      }
      tail=text.slice(end+1).slice(-4096);
    },
    result() {return {consumptions,consistent:!conflicts&&!invalid,conflicts,invalid,...(acknowledgements.get(consumptions)??{bytes:null,digest:null})};}
  };
}
export function createFixtureStreamVerifier(manifest=fixtureManifest()) {
  let tail='',last=0,missing=0,duplicates=0,outOfOrder=0,digest=null,bytes=0,overflow=false;
  const seen=new Uint8Array(manifest.logicalLines+1),hash=createHash('sha256');let corrupted=0;
  return {
    push(data) {
      bytes+=Buffer.byteLength(data);if(bytes>manifest.maxBytes){overflow=true;return;}
      const text=tail+data; const end=text.lastIndexOf('\n');if(end<0){tail=text.slice(-4096);return;}
      for(const match of text.slice(0,end+1).replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'').matchAll(/SRM:(\d{6})([^\r\n]*)|SRD:([a-f0-9]{64})/g)) {
        if(match[3]){digest=match[3];continue;}
        const n=Number(match[1]);if(n<1||n>manifest.logicalLines){outOfOrder++;continue;}
        const actual='SRM:'+match[1]+match[2];if(actual!==fixtureLine(n))corrupted++;hash.update(actual+'\n');
        if(seen[n])duplicates++;if(n<last)outOfOrder++;seen[n]=1;last=n;
      }
      tail=text.slice(end+1).slice(-4096);
    },
    result(){missing=manifest.logicalLines-seen.reduce((a,b)=>a+b,0);return {ok:!overflow&&!missing&&!duplicates&&!outOfOrder&&!corrupted&&digest===manifest.digest&&hash.copy().digest('hex')===manifest.digest,missing,duplicates,outOfOrder,corrupted,bytes,overflow,digestMatches:digest===manifest.digest&&hash.copy().digest('hex')===manifest.digest,lastMarker:last};}
  };
}
