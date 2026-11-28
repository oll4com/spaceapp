import { execFileSync } from "node:child_process";
import { glob, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export function webBuildRelease(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (/^[a-f0-9]{40}$/i.test(env.SENTRY_RELEASE ?? "")) return env.SENTRY_RELEASE;
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return undefined; }
}

/**
 * Technical bound on the upload (the plugin's writeBundle): it takes seconds, but a stalled request held a merge-queue build 45 min
 * (q-20261127-223542-a6f7). Late, it ends like a failed upload (logged, the build goes on), the maps are deleted as after an upload,
 * and the stuck request may hold vite open 30 s more at most.
 */
export function boundUpload(plugin: Plugin, { limitMs = 300_000, dist = "dist", exit = (): void => process.exit() } = {}): Plugin {
  const hook = plugin.writeBundle;
  if (typeof hook !== "function") return plugin;
  return { ...plugin, async writeBundle(...args) {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((done) => { timer = setTimeout(done, limitMs, "late"); });
    const outcome = await Promise.race([hook.apply(this, args), late]).finally(() => clearTimeout(timer));
    if (outcome !== "late") return;
    console.warn(`[space-sentry] The source-map upload took over ${limitMs / 1000} s; skipped, the maps are deleted.`);
    for await (const map of glob(join(dist, "**/*.map"))) await rm(map, { force: true });
    setTimeout(exit, 30_000).unref();
  } };
}

export async function sentryWebBuild(env: NodeJS.ProcessEnv, command: string, load: () => Promise<Pick<typeof import("@sentry/node/vite"), "sentryVitePlugin">> = () => import("@sentry/node/vite")) {
  const release = webBuildRelease(env);
  const stamp: Plugin = { name: "space-sentry-build-release", generateBundle() {
    this.emitFile({ type: "asset", fileName: "sentry-build.json", source: JSON.stringify({ release }) });
  } };
  if (command !== "build" || !env.SENTRY_AUTH_TOKEN?.trim()) return { sourcemap: false as const, plugins: [stamp] };
  if (!release || !env.SENTRY_ORG || !env.SENTRY_PROJECT) throw new Error("Sentry source-map upload requires a git SHA, SENTRY_ORG and SENTRY_PROJECT.");
  const { sentryVitePlugin } = await load();
  return { sourcemap: "hidden" as const, plugins: [stamp, ...sentryVitePlugin({
    authToken: env.SENTRY_AUTH_TOKEN, org: env.SENTRY_ORG, project: env.SENTRY_PROJECT,
    telemetry: false, buildTimeInstrumentation: false,
    release: { name: release, inject: false },
    sourcemaps: { assets: ["./dist/assets/**"], filesToDeleteAfterUpload: ["./dist/**/*.map"] }
  }).map((plugin) => boundUpload(plugin))] };
}
