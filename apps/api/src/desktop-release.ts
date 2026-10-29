import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { parseSemver } from "./app-version.js";

export const desktopReleaseDirectory = fileURLToPath(new URL("../../desktop/release/", import.meta.url));

const targetSchema = z.object({
  platform: z.string().min(1),
  format: z.string().min(1),
  filename: z.string().max(180).regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/).refine((name) => !name.includes(".."))
}).passthrough();
const manifestSchema = z.object({
  version: z.string().refine((value) => !value.startsWith("v") && value === value.trim() && parseSemver(value) !== null),
  name: z.string().trim().min(1),
  builtAt: z.iso.datetime(),
  targets: z.array(targetSchema).min(1).max(64)
});

export async function readDesktopRelease(directory = desktopReleaseDirectory) {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8")));
  const releaseRoot = await realpath(directory);
  const targets = (await Promise.all(manifest.targets.map(async (target) => {
    try {
      const artifact = await realpath(resolve(directory, target.filename));
      if (!artifact.startsWith(releaseRoot + sep)) return null;
      const info = await stat(artifact);
      // The size lets the desktop app tell a partial or stale download from the real file before it runs it.
      return info.isFile() && info.size > 0 ? { ...target, size: info.size } : null;
    } catch {
      return null;
    }
  }))).filter((target) => target !== null);
  if (!targets.length) throw new Error("Desktop release artifacts are unavailable.");
  const url = (platform: string, format: string) => {
    const target = targets.find((item) => item.platform === platform && item.format === format);
    return target ? "/api/desktop/download/" + encodeURIComponent(target.filename) : null;
  };
  return {
    version: manifest.version,
    name: manifest.name,
    builtAt: manifest.builtAt,
    download7zUrl: url("win32", "7z"),
    downloadZipUrl: url("win32", "zip"),
    installerUrl: url("win32", "exe-installer"),
    appImageUrl: url("linux", "AppImage"),
    debUrl: url("linux", "deb"),
    targets
  };
}

export function createDesktopLatestHandler(directory = desktopReleaseDirectory) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    try {
      return await readDesktopRelease(directory);
    } catch {
      request.log.warn({ code: "DESKTOP_RELEASE_UNAVAILABLE" }, "Desktop release metadata is unavailable.");
      return reply.code(503).send({ code: "DESKTOP_RELEASE_UNAVAILABLE", error: "Desktop update information is temporarily unavailable." });
    }
  };
}
