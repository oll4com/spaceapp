// Stamp the exact build SHA once: long-running hosts must not read a newer checkout's HEAD.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const root = new URL("../", import.meta.url);
let release = process.env.SENTRY_RELEASE;
if (!release) {
  try { release = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { /* Source archives can supply SENTRY_RELEASE at build time. */ }
}
writeFileSync(new URL("packages/contracts/dist/sentry-release.json", root), JSON.stringify({ release: /^[a-f0-9]{40}$/i.test(release ?? "") ? release : undefined }) + "\n");
