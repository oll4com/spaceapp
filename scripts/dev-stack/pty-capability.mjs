import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confinedFile, fileHash } from './opencode-runtime.mjs';
import { run } from './resources.mjs';

const self = fileURLToPath(import.meta.url), marker = 'SPACE_DEV_ZERO_PROVIDER_PTY_OK';
const helperHashes = {
  x64: '46a4455777c6122d7e71cd706ea4b37b19bedd297684be8b6dabb833ff2a3965',
  arm64: '21c589109bca43e287df884f3c34ab888033a83927ea7d273949ac5030583f26'
};
export function knownHelperRepair({ platform, arch, version, sha256, mode, uid, nlink }, ownerUid = process.getuid?.()) {
  return platform === 'darwin' && version === '1.1.0' && helperHashes[arch] === sha256 && mode === 0o644 && Number.isInteger(ownerUid) && uid === ownerUid && nlink === 1;
}
async function helperInfo(root) {
  const packageFile = await confinedFile(root, join(root, 'node_modules/node-pty/package.json'));
  const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
  assert.equal(pkg.name, 'node-pty');
  if (process.platform !== 'darwin') return { version: pkg.version, platform: process.platform, arch: process.arch };
  // Resolve exactly as node-pty's UnixTerminal does, including a possible local build.
  const require = createRequire(packageFile), utils = require('./lib/utils.js');
  const native = utils.loadNativeModule('pty');
  const file = await confinedFile(root, resolve(dirname(packageFile), 'lib', native.dir, 'spawn-helper'));
  const info = await lstat(file);
  return { version: pkg.version, platform: process.platform, arch: process.arch, file, relativeHelper: relative(root, file), sha256: await fileHash(file), mode: info.mode & 0o777, uid: info.uid, nlink: info.nlink };
}
export async function verifyPtyCapability(root, state, { inherited = {}, evidence = join(state, 'logs', 'pty-capability.json'), invoke = run } = {}) {
  let helper;
  try { helper = await helperInfo(root); }
  catch (error) {
    await mkdir(dirname(evidence), { recursive: true, mode: 0o700 });
    await writeFile(evidence, JSON.stringify({ capability: 'real zero-provider printf PTY', ok: false, stage: 'inspect-confined-helper', platform: process.platform, arch: process.arch, error: { name: error.name, code: error.code ?? null } }, null, 2) + '\n', { mode: 0o600 }); throw error;
  }
  const { file, ...selected } = helper;
  const proof = { capability: 'real zero-provider printf PTY', helper: selected, attempts: [], repair: null, ok: false };
  const home = join(state, 'pty-capability'); await mkdir(home, { recursive: true, mode: 0o700 });
  const probe = async () => {
    let output = '';
    try {
      const text = await invoke(process.execPath, [self, '--probe', root, home], { cwd: root, env: { PATH: inherited.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: home, TMPDIR: home, LANG: 'en_US.UTF-8', TERM: 'xterm-256color' }, timeout: 15000, output: chunk => { output = (output + chunk).slice(-4096); } });
      const result = JSON.parse(text.trim());
      assert.equal(result.capability, 'node-pty-printf'); assert.equal(result.ok, true);
      proof.attempts.push({ ok: true, result }); return true;
    } catch { proof.attempts.push({ ok: false, diagnostic: output.slice(-4096) }); return false; }
  };
  try {
    if (!await probe()) {
      // Only the exact published 1.1.0 helper-mode defect is eligible. The actual
      // failed spawn is retained first; an unrelated failure never triggers chmod.
      if (!knownHelperRepair(helper) || !/posix_spawnp failed/.test(proof.attempts[0].diagnostic)) throw new Error('Real printf PTY capability failed; selected helper metadata and typed error retained.');
      await confinedFile(root, file);
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        const { createHash } = await import('node:crypto');
        const sha256 = createHash('sha256').update(await handle.readFile()).digest('hex');
        if (!knownHelperRepair({ ...helper, sha256, mode: info.mode & 0o777, uid: info.uid, nlink: info.nlink })) throw new Error('PTY helper changed; refusing repair.');
        await confinedFile(root, file); await handle.chmod(0o755);
      } finally { await handle.close(); }
      proof.repair = { reason: 'Actual posix_spawnp failure and exact pinned private helper0644', before: helper.mode, after: (await lstat(file)).mode & 0o777, bytesUnchanged: await fileHash(file) === helper.sha256 };
      assert.equal(proof.repair.bytesUnchanged, true);
      if (!await probe()) throw new Error('Real printf PTY still fails after the bounded helper permission correction.');
    }
    proof.ok = true; return proof;
  } finally { await mkdir(dirname(evidence), { recursive: true, mode: 0o700 }); await writeFile(evidence, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 }); }
}

if (process.argv[1] && resolve(process.argv[1]) === self && process.argv[2] === '--probe') {
  const root = resolve(process.argv[3]), home = resolve(process.argv[4]);
  try {
    const require = createRequire(join(root, 'package.json')), pty = require('node-pty');
    const term = pty.spawn('/bin/sh', ['-c', `printf '${marker}'`], { name: 'xterm-256color', cols: 80, rows: 24, cwd: home, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, TERM: 'xterm-256color' } });
    let output = '';
    await new Promise((done, reject) => {
      const timer = setTimeout(() => { term.kill(); reject(new Error('Synthetic PTY timed out.')); }, 10000);
      term.onData(data => { output += data; });
      term.onExit(({ exitCode }) => { clearTimeout(timer); if (exitCode === 0 && output === marker) done(); else reject(new Error('Synthetic PTY output/exit mismatch.')); });
    });
    console.log(JSON.stringify({ capability: 'node-pty-printf', ok: true, exitCode: 0, exactOutput: true, modelInference: false }));
  } catch (error) {
    console.log(JSON.stringify({ capability: 'node-pty-printf', ok: false, error: { name: error.name, message: error.message.slice(0, 500) } })); process.exitCode = 1;
  }
}
