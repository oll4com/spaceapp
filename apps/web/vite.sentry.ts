import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export function webBuildRelease(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (/^[a-f0-9]{40}$/i.test(env.SENTRY_RELEASE ?? "")) return env.SENTRY_RELEASE;
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return undefined; }
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
  })] };
}
