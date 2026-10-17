#!/usr/bin/env node
/**
 * Runs ./memory-3d-bench.html on the dev server and prints the measured frame times.
 *
 * The page reports through `requestAnimationFrame`, so it cannot be measured with a headless
 * screenshot: a screenshot fires as soon as the page loads, long before a few hundred frames have
 * been produced, and `--virtual-time-budget` fast-forwards timers without advancing the compositor,
 * so the rAF loop never finishes. Instead this script starts a tiny HTTP listener, opens the page in
 * headless Chrome with real time, waits for the page to POST its result, and prints it.
 *
 * Usage:
 *   npm run dev                     # terminal 1: the dev server on :4911
 *   node scripts/memory-3d-bench.mjs [url] [timeoutMs]
 *
 * Defaults: http://127.0.0.1:4911/memory-3d-bench.html, 300000 ms.
 * Append ?nodes=5000 to the URL for a smaller graph (the layout cost grows quadratically).
 */
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const PORT = Number(process.env.MEMORY_BENCH_PORT ?? 9977);
const TARGET = process.argv[2] ?? 'http://127.0.0.1:4911/memory-3d-bench.html';
const TIMEOUT_MS = Number(process.argv[3] ?? 300000);

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((candidate) => typeof candidate === 'string');
const CHROME = CANDIDATES.find((candidate) => existsSync(candidate));
if (!CHROME) {
  console.error('No Chrome/Edge binary found. Set CHROME_PATH to one.');
  process.exit(2);
}

let cleanup = () => {};
const result = await new Promise((resolve) => {
  let settled = false;
  const settle = (value) => { if (!settled) { settled = true; resolve(value); } };

  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'access-control-allow-origin': '*' });
      response.end('ok');
      try { settle(JSON.parse(body)); } catch { settle({ ok: false, reason: 'unparsable body' }); }
    });
  });

  server.listen(PORT, '127.0.0.1', () => {
    const chrome = spawn(CHROME, [
      '--headless=new',
      '--window-size=1200,800',
      '--hide-scrollbars',
      '--no-first-run',
      '--disable-extensions',
      `--user-data-dir=${process.env.TEMP ?? '/tmp'}/spaceapp-memory-bench`,
      TARGET,
    ], { stdio: 'ignore' });

    const stop = () => {
      try { execFileSync('cmd', ['/c', `taskkill /PID ${chrome.pid} /F`], { stdio: 'ignore' }); }
      catch { try { chrome.kill('SIGKILL'); } catch { /* already gone */ } }
      server.close();
    };
    const timer = setTimeout(() => { settle({ ok: false, reason: `timeout after ${TIMEOUT_MS}ms` }); stop(); }, TIMEOUT_MS);
    // Exposed to the caller so the success path tears Chrome down too. `process.exit` would
    // otherwise leave it running on the fixed profile and the next run would fight it for that dir.
    cleanup = () => { clearTimeout(timer); stop(); };
  });
});
cleanup();

console.log(JSON.stringify(result, null, 1));
process.exit(result.ok ? 0 : 1);
