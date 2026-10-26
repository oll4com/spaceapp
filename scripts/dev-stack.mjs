// 龙娘 · 2026-10-26: SpaceApp #65 contributor stack entry; resolve the checkout independently of cwd.
import { fileURLToPath } from 'node:url';
import { runDevStack } from './dev-stack/supervisor.mjs';

const command = process.argv[2] ?? 'up';
if (process.argv.length > 3 || !['up', 'down', 'reset', 'rebuild'].includes(command)) {
  console.error('Usage: npm run dev:stack -- [up|down|reset|rebuild]');
  process.exitCode = 1;
} else {
  try {
    await runDevStack({ repoRoot: fileURLToPath(new URL('../', import.meta.url)), command });
  } catch (error) {
    console.error(`[dev-stack] ${error.message}`);
    process.exitCode = 1;
  }
}
