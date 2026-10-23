// Invoked only by the generated, checkout-local opencode-vscode-parity wrapper.
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

const [state, ...args] = process.argv.slice(2);
const { ports } = JSON.parse(await readFile(join(state, 'owner.json'), 'utf8'));
const command = join(state, 'vendor/node_modules/.bin/opencode');
if (args[0] === '--run-inner') args.shift();
if (args[0] === 'credential-smoke') {
  console.error('This contributor stack verifies the OpenCode terminal only; no provider inference check is configured.');
  process.exit(1);
}
if (['credential-status', 'credential-observation'].includes(args[0])) {
  await access(command, constants.X_OK);
  console.log(args[0] === 'credential-observation' ? 'OBSERVATION:dev-opencode-installed' : 'READY');
  process.exit(0);
}
const provider = join(state, 'providers/opencode');
const env = {
  PATH: process.env.PATH, TERM: process.env.TERM || 'xterm-256color', LANG: process.env.LANG || 'C.UTF-8',
  HOME: provider, TMPDIR: join(provider, 'tmp'), XDG_CONFIG_HOME: join(provider, 'config'),
  XDG_DATA_HOME: join(provider, 'data'), XDG_CACHE_HOME: join(provider, 'cache'), XDG_STATE_HOME: join(provider, 'state'),
  OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_SERVER_USERNAME: 'opencode',
  OPENCODE_SERVER_PASSWORD: await readFile(join(state, 'secrets/opencode-password'), 'utf8')
};
const terminal = !args.length || ['--continue', '-c', '--session', '-s'].includes(args[0]);
const child = spawn(command, terminal ? ['--server', `http://127.0.0.1:${ports.opencode}`, ...args, process.cwd()] : [...args, '--standalone'], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.once('error', () => { console.error('OpenCode could not start; run dev:stack again.'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
