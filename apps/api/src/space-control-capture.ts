import { spawn } from "./safe-child-process.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthUser, CreateArtifactInput, SpaceInstance } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import { signSessionWithTtl } from "./auth.js";

// The Media Studio capture engine (skill space-media-studio); the same path from src/ and dist/.
const runner = new URL("../../../scripts/space-media-capture.mjs", import.meta.url).pathname;

type CaptureParams = { format?: string; quality?: number; maxWidth?: number; maxHeight?: number; viewport?: string };

export interface ControlScreenshotCaptureOptions {
  instance: SpaceInstance;
  cookieName: string;
  sessionSecret: string;
  /** Where browser evidence lives (config.browserEvidenceArtifactRoot); the artifact URI resolves under it. */
  artifactRoot: string;
  resolveUser(actorId: string): Promise<AuthUser>;
  createArtifact(input: CreateArtifactInput): Promise<{ artifact: { id: string } }>;
  /** Test seam: runs the engine with the JSON request on stdin and returns its stdout. */
  run?(request: string, timeoutMs: number): Promise<string>;
  timeoutMs?: number;
}

/** Runs the engine in its own process group so a timeout also ends the Chrome it started. */
function runCapture(request: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, "--stdin"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let size = 0;
    let err = "";
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { kill(); reject(new SpaceConflictError("The Space screenshot timed out.")); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) { kill(); return; }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { err = (err + chunk.toString("utf8")).slice(-600); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new SpaceConflictError(`The Space screenshot failed: ${err.trim().split("\n").at(-1)?.slice(0, 300) || `exit ${code}`}`));
    });
    child.stdin.end(request);
  });
}

/**
 * Space Control's authenticated APP capture (space_screenshot): the actor's own account, read-only (terminals attach as
 * observers and the capture browser fails every API write), one capture at a time, stored as a room SCREENSHOT artifact.
 */
export function createControlScreenshotCapture(options: ControlScreenshotCaptureOptions) {
  let busy = false;
  return async (actor: { id: string }, roomId: string, params: CaptureParams = {}): Promise<Record<string, unknown>> => {
    if (busy) throw new SpaceConflictError("Another Space screenshot is being captured; try again in a moment.");
    busy = true;
    try {
      const user = await options.resolveUser(actor.id);
      const cookieValue = signSessionWithTtl({ ...user, proofScope: "READ_ONLY" }, options.sessionSecret, 120);
      const stdout = await (options.run ?? runCapture)(JSON.stringify({
        instance: options.instance, cookieName: options.cookieName, cookieValue, room: roomId, viewport: params.viewport ?? "desktop",
        format: params.format ?? "jpeg", quality: params.quality, maxWidth: params.maxWidth, maxHeight: params.maxHeight
      }), options.timeoutMs ?? 90_000);
      const report = JSON.parse(stdout) as { room?: string; shots?: Array<{ viewport: string; format: string; width: number; height: number; base64: string }>; blockedWrites?: number; version?: string | null };
      const shot = report.shots?.[0];
      if (report.room !== roomId || !shot?.base64) throw new SpaceConflictError("The Space screenshot returned no image of this room.");
      const bytes = Buffer.from(shot.base64, "base64");
      const segment = `space-control-${randomUUID()}`;
      const filename = `screenshot.${shot.format === "jpeg" ? "jpg" : shot.format}`;
      const directory = join(options.artifactRoot, "browser-evidence", segment);
      await mkdir(directory, { recursive: true, mode: 0o750 });
      await writeFile(join(directory, filename), bytes, { mode: 0o640 });
      const record = await options.createArtifact({
        roomId,
        kind: "SCREENSHOT",
        mimeType: `image/${shot.format}`,
        storageUri: `space-artifact://browser-evidence/${segment}/${encodeURIComponent(filename)}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.length,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        metadata: { source: "SPACE_CONTROL_SCREENSHOT", viewport: shot.viewport, width: shot.width, height: shot.height, filename }
      });
      return { roomId, authenticated: true, captureSource: "AUTHENTICATED_APP", artifactId: record.artifact.id, viewport: shot.viewport,
        width: shot.width, height: shot.height, format: shot.format, byteSize: bytes.length, blockedWrites: report.blockedWrites ?? 0, version: report.version ?? null };
    } finally {
      busy = false;
    }
  };
}
