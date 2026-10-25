import { spawn } from "../safe-child-process.js";
import type { DesignBrandKit, DesignSafeArea, DesignTemplateId } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";

// The Design template renderer (plan clipboard:URdc3U314lUH, P3); the same path from src/design/ and dist/design/.
const runner = new URL("../../../../scripts/space-design-render.mjs", import.meta.url).pathname;
/** A 25 MB image as base64 inside the renderer's JSON answer. */
const MAX_STDOUT_BYTES = 36 * 1024 * 1024;

export type DesignRenderFormat = "png" | "jpeg" | "webp";

export interface DesignRenderInput {
  templateId: DesignTemplateId;
  width: number;
  height: number;
  format?: DesignRenderFormat;
  /** JPEG/WebP quality, 1-100. */
  quality?: number;
  /** Checked by the renderer: headline, subline, cta, quote, author, badge, version, url (text), colors {background, surface, primary, accent, text}, focalX, focalY, overlay. */
  params?: Record<string, unknown> | null;
  /** Image files the caller resolved from the owner's artifacts or the built-in brand files: the background photo, a screenshot, the logo. */
  imagePaths?: { background?: string; screenshot?: string; logo?: string };
  brandKit?: Pick<DesignBrandKit, "name" | "colors" | "fonts"> | null;
  safeArea?: DesignSafeArea;
}

export interface DesignRenderResult {
  bytes: Buffer;
  mimeType: `image/${DesignRenderFormat}`;
  format: DesignRenderFormat;
  width: number;
  height: number;
  sha256: string;
}

export interface DesignRendererOptions {
  /** Test seam: runs the renderer with the JSON request on stdin and returns its stdout. */
  run?(request: string, timeoutMs: number): Promise<string>;
  timeoutMs?: number;
}

/** Runs the renderer in its own process group so a timeout also ends the Chrome it started. */
function runRender(request: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, "--stdin"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let size = 0;
    let err = "";
    let failure: string | null = null;
    const kill = (reason: string) => { failure ??= reason; try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => kill("The design render timed out."), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STDOUT_BYTES) { kill("The rendered image is larger than 25 MB."); return; }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { err = (err + chunk.toString("utf8")).slice(-600); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(new SpaceConflictError(failure));
      else if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new SpaceConflictError(`The design render failed: ${err.trim().split("\n").at(-1)?.slice(0, 300) || `exit ${code}`}`));
    });
    child.stdin.end(request);
  });
}

/**
 * Template renders for the Design pane: an HTML template at the exact format size, with no script or network in Chrome.
 * One render at a time per owner; the result is the image itself, which the caller stores as an artifact.
 */
export function createDesignRenderer(options: DesignRendererOptions = {}) {
  const busy = new Set<string>();
  return async (ownerId: string, input: DesignRenderInput): Promise<DesignRenderResult> => {
    if (busy.has(ownerId)) throw new SpaceConflictError("Another design is being rendered; try again in a moment.");
    busy.add(ownerId);
    try {
      const stdout = await (options.run ?? runRender)(JSON.stringify({
        templateId: input.templateId, width: input.width, height: input.height, format: input.format ?? "png", quality: input.quality,
        params: input.params ?? undefined, imagePaths: input.imagePaths,
        brandKit: input.brandKit ? { name: input.brandKit.name, colors: input.brandKit.colors, fonts: input.brandKit.fonts } : undefined,
        safeArea: input.safeArea
      }), options.timeoutMs ?? 60_000);
      const report = JSON.parse(stdout) as { templateId?: string; width?: number; height?: number; format?: DesignRenderFormat; sha256?: string; base64?: string };
      const bytes = Buffer.from(report.base64 ?? "", "base64");
      if (report.templateId !== input.templateId || report.width !== input.width || report.height !== input.height || !bytes.length || !report.sha256) {
        throw new SpaceConflictError("The design render returned no image of the requested size.");
      }
      const format = report.format ?? "png";
      return { bytes, mimeType: `image/${format}`, format, width: report.width, height: report.height, sha256: report.sha256 };
    } finally {
      busy.delete(ownerId);
    }
  };
}
