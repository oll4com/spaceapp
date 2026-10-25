#!/usr/bin/env node
// Writes one CLI's login, sent by a Space configuration import through the CLI host, where this
// container's CLI reads it. It prints one line: IMPORTED [backup=<path>], SKIPPED <reason> or FAILED <reason>.
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The only files an import may write, relative to the home public-cli-wrapper.sh gives each CLI.
const allowlist = {
  codex: { dir: '.', files: ['auth.json'] },
  claude: { dir: '.', files: ['.credentials.json'] },
  gemini: { dir: '.gemini', files: ['oauth_creds.json', 'google_accounts.json'] },
  opencode: { dir: 'data/opencode', files: ['auth.json'] }
};
const maxFileBytes = 64 * 1024;
export const maxPayloadBytes = 512 * 1024;

function decode(name, base64) {
  if (typeof base64 !== 'string') return null;
  const content = Buffer.from(base64, 'base64');
  if (!content.length || content.length > maxFileBytes) return null;
  if (name.endsWith('.json')) {
    try { JSON.parse(content.toString('utf8')); } catch { return null; }
  }
  return content;
}

export async function installLogin(runtime, stateRoot, payloadText) {
  const spec = Object.hasOwn(allowlist, runtime) ? allowlist[runtime] : null;
  if (!spec) return 'FAILED not-supported-on-target';
  let payload;
  try { payload = JSON.parse(payloadText); } catch { return 'FAILED unreadable-login-file'; }
  const conflict = payload?.conflict ?? 'backup-and-replace';
  if (conflict !== 'backup-and-replace' && conflict !== 'skip-if-logged-in') return 'FAILED bad-request';
  const files = payload?.files && typeof payload.files === 'object' ? payload.files : {};
  const names = Object.keys(files);
  if (!names.length || names.some((name) => !spec.files.includes(name))) return 'FAILED rejected-file-name';
  const contents = names.map((name) => [name, decode(name, files[name])]);
  if (contents.some(([, content]) => !content)) return 'FAILED unreadable-login-file';

  const home = join(stateRoot, spec.dir);
  const existing = await Promise.all(names.map((name) => lstat(join(home, name)).catch(() => null)));
  if (existing.some((info) => info && !info.isFile())) return 'FAILED not-a-regular-file';
  if (conflict === 'skip-if-logged-in' && existing.some((info) => info && info.size > 0)) return 'SKIPPED already-logged-in';
  await mkdir(home, { recursive: true, mode: 0o700 });
  let backup = null;
  const stamp = Date.now();
  for (const [index, [name, content]] of contents.entries()) {
    const target = join(home, name);
    if (existing[index]) {
      backup = `${target}.bak-${stamp}`;
      await writeFile(backup, await readFile(target), { mode: 0o600, flag: 'wx' });
    }
    const temporary = `${target}.tmp-${randomBytes(6).toString('hex')}`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target).catch(async (error) => {
      await rm(temporary, { force: true });
      throw error;
    });
  }
  // Interactive Claude Code reruns its first-run onboarding, login screen included, until its settings say it ran.
  if (runtime === 'claude') await markOnboarded(join(home, '.claude.json'));
  return backup ? `IMPORTED backup=${backup}` : 'IMPORTED';
}

async function markOnboarded(path) {
  const current = await readFile(path, 'utf8').then((text) => JSON.parse(text), (error) => {
    if (error.code === 'ENOENT') return {};
    throw error;
  });
  if (current.hasCompletedOnboarding === true) return;
  const temporary = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(temporary, JSON.stringify({ ...current, hasCompletedOnboarding: true }, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function main() {
  const [runtime, stateRoot] = process.argv.slice(2);
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxPayloadBytes) return 'FAILED bad-request';
    chunks.push(chunk);
  }
  return installLogin(runtime, stateRoot, Buffer.concat(chunks).toString('utf8'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (line) => { process.stdout.write(`${line}\n`); process.exitCode = line.startsWith('FAILED') ? 1 : 0; },
    () => { process.stdout.write('FAILED write-failed\n'); process.exitCode = 1; }
  );
}
