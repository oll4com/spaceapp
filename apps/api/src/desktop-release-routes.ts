import type {} from "./request-context.js";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyReply, RouteShorthandOptions } from "fastify";
import { createDesktopLatestHandler, desktopReleaseDirectory } from "./desktop-release.js";

/**
 * Desktop launcher, update scripts and release downloads; the parent retains authentication, CSRF, errors and rate
 * limits.
 */
/** The release key's detached Ed25519 signature (`<script>.sig`, base64), which the desktop app checks before it runs the script. */
async function signatureHeader(reply: FastifyReply, filePath: string) {
  const signature = (await readFile(`${filePath}.sig`, "utf8").catch(() => "")).trim();
  if (/^[A-Za-z0-9+/]{86}==$/.test(signature)) reply.header("x-space-signature", signature);
}

export function registerDesktopReleaseRoutes(app: FastifyInstance, options: {
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/desktop/latest", defaultRouteRateLimitOptions, createDesktopLatestHandler());
  app.get("/api/desktop/update.ps1", defaultRouteRateLimitOptions, async (_request, reply) => {
    const filePath = resolve(process.cwd(), "apps/desktop/release/update.ps1");
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      return reply.status(404).send({ error: "Update script not found" });
    }
    reply.header("Content-Type", "text/plain; charset=utf-8");
    await signatureHeader(reply, filePath);
    return reply.send(createReadStream(filePath));
  });
  app.get("/api/desktop/update.bat", defaultRouteRateLimitOptions, async (_request, reply) => {
    const filePath = resolve(process.cwd(), "apps/desktop/release/update.bat");
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      return reply.status(404).send({ error: "Update batch file not found" });
    }
    reply.header("Content-Type", "text/plain; charset=utf-8");
    return reply.send(createReadStream(filePath));
  });
  app.get("/api/desktop/install.sh", defaultRouteRateLimitOptions, async (_request, reply) => {
    const filePath = resolve(process.cwd(), "apps/desktop/release/install-linux-spaceapp.sh");
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      return reply.status(404).send({ error: "Install shell script not found" });
    }
    reply.header("Content-Type", "text/x-shellscript; charset=utf-8");
    return reply.send(createReadStream(filePath));
  });
  app.get("/run-spaceapp.tgz", defaultRouteRateLimitOptions, async (_request, reply) => {
    const filePath = resolve(process.cwd(), "apps/desktop/release/run-spaceapp.tgz");
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      return reply.status(404).send({ error: "Launcher package not found" });
    }
    reply.header("Content-Disposition", 'attachment; filename="run-spaceapp.tgz"');
    reply.header("Content-Length", String(fileStat.size));
    reply.header("Content-Type", "application/gzip");
    return reply.send(createReadStream(filePath));
  });
  app.get("/api/desktop/download/:filename", defaultRouteRateLimitOptions, async (request, reply) => {
    const { filename } = request.params as { filename: string };
    if (!/^[a-zA-Z0-9_.-]+$/.test(filename) || filename.includes("..")) {
      return reply.status(400).send({ error: "Invalid filename" });
    }
    const filePath = resolve(desktopReleaseDirectory, filename);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      return reply.status(404).send({ error: "File not found" });
    }
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    reply.header("Content-Length", String(fileStat.size));
    const mimeType = filename.endsWith(".exe")
      ? "application/vnd.microsoft.portable-executable"
      : filename.endsWith(".7z")
      ? "application/x-7z-compressed"
      : filename.endsWith(".ps1")
      ? "text/plain; charset=utf-8"
      : filename.endsWith(".sh")
      ? "text/x-shellscript; charset=utf-8"
      : filename.endsWith(".AppImage")
      ? "application/x-executable"
      : filename.endsWith(".deb")
      ? "application/vnd.debian.binary-package"
      : "application/zip";
    reply.header("Content-Type", mimeType);
    return reply.send(createReadStream(filePath));
  });
}
