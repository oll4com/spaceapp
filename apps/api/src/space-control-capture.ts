import { spawn } from "./safe-child-process.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthUser, CreateArtifactInput, CreateAuditEventInput, SpaceInstance } from "@space/contracts";
import { makeSpaceId, SpaceConflictError } from "@space/runtime";
import { z } from "zod";
import { signSessionWithTtl } from "./auth.js";

// The Media Studio capture engine (skill space-media-studio); the same path from src/ and dist/.
const runner = new URL("../../../scripts/space-media-capture.mjs", import.meta.url).pathname;

/** The space_screenshot action (packages/contracts/src/space-control.ts): size, what is shown, and an optional recorded tour. */
export type ControlCaptureParams = {
  format?: string; quality?: number; maxWidth?: number; maxHeight?: number; viewport?: string;
  paneId?: string; crop?: string; dock?: string; settings?: string; health?: string;
  video?: { steps: Array<{ dock?: string; settings?: string; health?: string; dwellMs: number }> };
  fitTerminals?: boolean;
};

type CaptureActor = { id: string; dotId?: string };
type FitRequest = (panes: unknown) => Promise<number>;
type TerminalFit = { paneId: string; before: string | null; after: string };

export interface ControlScreenshotCaptureOptions {
  instance: SpaceInstance;
  cookieName: string;
  sessionSecret: string;
  /** Where browser evidence lives (config.browserEvidenceArtifactRoot); the artifact URI resolves under it. */
  artifactRoot: string;
  resolveUser(actorId: string): Promise<AuthUser>;
  createArtifact(input: CreateArtifactInput): Promise<{ artifact: { id: string } }>;
  /** fitTerminals: resizes the captured room's CLI PTYs to the grids the capture shows (createCaptureTerminalFit). */
  fitTerminals?(actor: CaptureActor, roomId: string, panes: unknown): Promise<TerminalFit[]>;
  /** Test seam: runs the engine with the JSON request on stdin and returns its stdout. */
  run?(request: string, timeoutMs: number, onFit?: FitRequest): Promise<string>;
  timeoutMs?: number;
}

/**
 * Runs the engine in its own process group so a timeout also ends the Chrome it started. With onFit the engine's first
 * stdout line may be `SPACE_FIT {panes}`: the API fits those terminals and answers `{fitted}` on stdin.
 */
function runCapture(request: string, timeoutMs: number, onFit?: FitRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, "--stdin"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let size = 0;
    let err = "";
    let fitAsked = false;
    let fitError: unknown = null;
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { kill(); reject(new SpaceConflictError("The Space screenshot timed out.")); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) { kill(); return; }
      out.push(chunk);
      if (!onFit || fitAsked) return;
      const text = Buffer.concat(out).toString("utf8");
      const end = text.indexOf("\n");
      if (!text.startsWith("SPACE_FIT ") || end < 0) return;
      fitAsked = true;
      void Promise.resolve().then(() => onFit(JSON.parse(text.slice(10, end)))).then(
        (fitted) => child.stdin.end(`${JSON.stringify({ fitted })}\n`),
        (error) => { fitError = error; kill(); });
    });
    child.stderr.on("data", (chunk: Buffer) => { err = (err + chunk.toString("utf8")).slice(-600); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString("utf8");
      if (fitError) reject(fitError);
      else if (code === 0) resolve(fitAsked ? text.slice(text.indexOf("\n") + 1) : text);
      else reject(new SpaceConflictError(`The Space screenshot failed: ${err.trim().split("\n").at(-1)?.slice(0, 300) || `exit ${code}`}`));
    });
    if (onFit) child.stdin.write(`${request}\n`);
    else child.stdin.end(request);
  });
}

const fitPanesSchema = z.array(z.object({ paneId: z.string().min(1).max(200), cols: z.number().finite(), rows: z.number().finite() })).max(16);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

/**
 * space_screenshot's opt-in fitTerminals (Nous Warm approval 2026-10-23): only the room owner's own capture (never a Dot),
 * only the captured room's own CLI panes, grids clamped to 20-400 columns and 5-200 rows, each fit audited with its
 * before/after size. The capture browser stays read-only: the API resizes for the caller.
 */
export function createCaptureTerminalFit(deps: {
  getRoom(roomId: string): Promise<{ ownerUserId?: string | null }>;
  getPane(paneId: string): Promise<{ id: string; roomId: string; mode: string; ownerUserId?: string | null }>;
  fitPaneTerminal(paneId: string, cols: number, rows: number): Promise<{ sessionId: string; before: string | null; after: string } | null>;
  recordAuditEvent(input: CreateAuditEventInput): Promise<unknown>;
}) {
  return async (actor: CaptureActor, roomId: string, panes: unknown): Promise<TerminalFit[]> => {
    if (actor.dotId) throw new SpaceConflictError("Dots never fit terminals.");
    const room = await deps.getRoom(roomId);
    if (!room.ownerUserId || room.ownerUserId !== actor.id) throw new SpaceConflictError("fitTerminals is only for the room's owner.");
    const fits: TerminalFit[] = [];
    for (const entry of fitPanesSchema.parse(panes)) {
      const pane = await deps.getPane(entry.paneId).catch(() => null);
      if (!pane || pane.roomId !== roomId || pane.mode !== "TERMINAL" || (pane.ownerUserId ?? room.ownerUserId) !== actor.id) continue;
      const result = await deps.fitPaneTerminal(pane.id, clamp(entry.cols, 20, 400), clamp(entry.rows, 5, 200));
      if (!result) continue;
      fits.push({ paneId: pane.id, before: result.before, after: result.after });
      await deps.recordAuditEvent({ actorUserId: actor.id, traceId: makeSpaceId("trace"), action: "space_control.capture.fit_terminal",
        targetType: "pane", targetId: pane.id, metadata: { roomId, sessionId: result.sessionId, before: result.before, after: result.after } });
    }
    return fits;
  };
}

type CaptureReport = {
  room?: string; blockedWrites?: number; version?: string | null; skipped?: string[]; terminalsFitted?: number;
  shots?: Array<{ viewport: string; format: string; width: number; height: number; base64: string }>;
  files?: Array<{ file: string; viewport: string; bytes: number; sha256: string; durationMs?: number }>;
};

/**
 * Space Control's authenticated APP capture (space_screenshot): the actor's own account, read-only (terminals attach as
 * observers and the capture browser fails every API write), one capture at a time, stored as a room SCREENSHOT artifact,
 * or a VIDEO artifact (MP4) when the action carries video steps.
 */
export function createControlScreenshotCapture(options: ControlScreenshotCaptureOptions) {
  let busy = false;
  return async (actor: CaptureActor, roomId: string, params: ControlCaptureParams = {}): Promise<Record<string, unknown>> => {
    if (params.fitTerminals && (!options.fitTerminals || actor.dotId)) throw new SpaceConflictError(actor.dotId ? "Dots never fit terminals." : "fitTerminals is unavailable here.");
    if (busy) throw new SpaceConflictError("Another Space screenshot is being captured; try again in a moment.");
    busy = true;
    const segment = `space-control-${randomUUID()}`;
    const directory = join(options.artifactRoot, "browser-evidence", segment);
    const viewport = params.viewport ?? "desktop";
    let stored = false;
    let terminalFits: TerminalFit[] = [];
    try {
      const user = await options.resolveUser(actor.id);
      const dwellMs = params.video?.steps.reduce((total, step) => total + step.dwellMs, 0) ?? 0;
      // A video plays its steps and then ffmpeg encodes it: the session and the timeout cover both.
      const timeoutMs = options.timeoutMs ?? (params.video ? dwellMs + 360_000 : 90_000);
      const cookieValue = signSessionWithTtl({ ...user, proofScope: "READ_ONLY" }, options.sessionSecret, Math.max(120, Math.ceil(timeoutMs / 1000)));
      // The engine writes a video's frames and MP4 into this artifact directory (the API's /tmp is a tmpfs).
      if (params.video) await mkdir(directory, { recursive: true, mode: 0o750 });
      const stdout = await (options.run ?? runCapture)(JSON.stringify({
        instance: options.instance, cookieName: options.cookieName, cookieValue, room: roomId, pane: params.paneId, crop: params.crop,
        dock: params.dock, settings: params.settings, health: params.health, viewport, format: params.format ?? "jpeg", quality: params.quality,
        maxWidth: params.maxWidth, maxHeight: params.maxHeight, video: params.video, outDir: params.video ? directory : undefined,
        fitTerminals: params.fitTerminals || undefined
      }), timeoutMs, params.fitTerminals ? async (panes) => (terminalFits = await options.fitTerminals!(actor, roomId, panes)).length : undefined);
      const report = JSON.parse(stdout) as CaptureReport;
      const fitted = params.fitTerminals ? { terminalsFitted: report.terminalsFitted ?? 0, terminalFits } : {};
      if (params.video) {
        const filename = `video-${viewport}.mp4`;
        const video = report.files?.[0];
        if (report.room !== roomId || video?.file !== join(directory, filename) || !video.bytes) throw new SpaceConflictError("The Space recording returned no video of this room.");
        const durationMs = video.durationMs ?? dwellMs;
        const record = await options.createArtifact({
          roomId,
          kind: "VIDEO",
          mimeType: "video/mp4",
          storageUri: `space-artifact://browser-evidence/${segment}/${encodeURIComponent(filename)}`,
          sha256: video.sha256,
          byteSize: video.bytes,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          metadata: { source: "SPACE_CONTROL_RECORDING", viewport, durationMs, filename, ...fitted }
        });
        stored = true;
        return { roomId, authenticated: true, captureSource: "AUTHENTICATED_APP", artifactId: record.artifact.id, kind: "VIDEO", viewport, format: "mp4",
          durationMs, byteSize: video.bytes, skipped: report.skipped ?? [], blockedWrites: report.blockedWrites ?? 0, version: report.version ?? null, ...fitted };
      }
      const shot = report.shots?.[0];
      if (report.room !== roomId || !shot?.base64) throw new SpaceConflictError("The Space screenshot returned no image of this room.");
      const bytes = Buffer.from(shot.base64, "base64");
      const filename = `screenshot.${shot.format === "jpeg" ? "jpg" : shot.format}`;
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
        metadata: { source: "SPACE_CONTROL_SCREENSHOT", viewport: shot.viewport, width: shot.width, height: shot.height, filename, ...fitted }
      });
      stored = true;
      return { roomId, authenticated: true, captureSource: "AUTHENTICATED_APP", artifactId: record.artifact.id, viewport: shot.viewport,
        width: shot.width, height: shot.height, format: shot.format, byteSize: bytes.length, skipped: report.skipped ?? [], blockedWrites: report.blockedWrites ?? 0, version: report.version ?? null, ...fitted };
    } finally {
      busy = false;
      if (!stored) await rm(directory, { recursive: true, force: true });
    }
  };
}
