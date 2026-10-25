import { existsSync } from "node:fs";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ProviderUrlPolicy } from "./provider-transport.js";
import { GitControlError } from "./errors.js";

/** Secrets exist only in the child environment/ASKPASS pipe, never argv or Git config. */
export async function createGitEnvironment(policy: ProviderUrlPolicy, root: string, remote: string, token: string, login: string): Promise<NodeJS.ProcessEnv> {
  const normalized = policy.normalize(remote), url = new URL(normalized);
  if (!token || !login || /[\x00-\x1f\x7f]/.test(token + login)) throw new GitControlError("INVALID_TOKEN", "Reconnect this provider.");
  const address = await policy.address(url);
  await mkdir(root, { recursive: true, mode: 0o700 }); const script = join(root, "git-askpass.cjs");
  const temporary = join(root, `git-askpass-${randomUUID()}.tmp`);
  try {
  await writeFile(temporary, `#!/usr/bin/env node
const prompt = process.argv[2] || '';
const match = prompt.match(/'(https?:[^']+)'/);
if (!match) process.exit(1);
let target, expected;
try { target = new URL(match[1]); expected = new URL(process.env.SPACE_GIT_REMOTE); } catch { process.exit(1); }
if (target.origin !== expected.origin || target.pathname.replace(/\\/$/, '') !== expected.pathname.replace(/\\/$/, '') || target.search || target.hash || target.password) process.exit(1);
try { if (target.username && decodeURIComponent(target.username) !== process.env.SPACE_GIT_LOGIN) process.exit(1); } catch { process.exit(1); }
if (/^username/i.test(prompt)) process.stdout.write(process.env.SPACE_GIT_LOGIN || '');
else if (/^password/i.test(prompt)) process.stdout.write(process.env.SPACE_GIT_TOKEN || '');
else process.exit(1);
`, { mode: 0o700, flag: "wx" });
  await rename(temporary, script);
  } finally { await rm(temporary, { force: true }); }
  return { ...networkConfiguration(url, address), HOME: await isolatedHome(root), GIT_ASKPASS: script, SPACE_GIT_TOKEN: token, SPACE_GIT_LOGIN: login, SPACE_GIT_REMOTE: normalized };
}

/** An empty HOME, so ~/.netrc or other per-user files of the service account are never used for network Git. */
async function isolatedHome(root: string): Promise<string> {
  const home = join(root, "git-home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

/** Pinned DNS, no redirects/proxies/extra headers and no hooks for every network Git command. */
function networkConfiguration(url: URL, address: { address: string; family: number }): NodeJS.ProcessEnv {
  const resolveAddress = address.family === 6 ? `[${address.address}]` : address.address;
  const entries = [
    ["http.followRedirects", "false"], ["http.proxy", ""], ["http.curloptResolve", `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}:${resolveAddress}`],
    ["core.hooksPath", "/dev/null"], ["credential.useHttpPath", "true"], ["http.extraHeader", ""], ["http.sslVerify", "true"]
  ];
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value; });
  return env;
}

/** Public HTTPS access: the same network protections, and any credential prompt fails instead of asking. */
export async function createAnonymousGitEnvironment(policy: ProviderUrlPolicy, root: string, remote: string): Promise<NodeJS.ProcessEnv> {
  const url = new URL(policy.normalize(remote));
  const address = await policy.address(url);
  return { ...networkConfiguration(url, address), HOME: await isolatedHome(root), GIT_ASKPASS: existsSync("/bin/false") ? "/bin/false" : "/usr/bin/false" };
}
