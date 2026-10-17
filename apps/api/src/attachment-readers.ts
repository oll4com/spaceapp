import { execFile } from "./safe-child-process.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { attachmentCoverageSchema, imageArtifactMimeTypeSchema, type AttachmentCoverage } from "@space/contracts";

const execFileAsync = promisify(execFile);

/**
 * Space Dots Stage 5: readers with recorded coverage.
 *
 * Before a Dot turn, each attached file is read into the Dot's workspace and
 * the turn receives where the text is and how much of the file it covers:
 * FULL, PARTIAL (with the reason) or UNAVAILABLE (with the reason). Nothing is
 * claimed as read that was not read. Extraction runs in a separate,
 * memory-limited process with a timeout.
 */
export type AttachmentReaderKind = "TEXT" | "PDF" | "DOCX" | "XLSX" | "PPTX" | "IMAGE" | "AUDIO" | "VIDEO" | "OTHER";
export interface AttachmentReadInput {
  artifactId: string;
  sourcePath: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}
export interface AttachmentReadResult { artifactId: string; coverage: AttachmentCoverage; outputPath: string | null }

const textExtensions = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".xml", ".html", ".htm", ".css",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh",
  ".sql", ".toml", ".ini", ".log", ".svg", ".tex", ".srt", ".vtt"]);
export function classifyAttachment(mimeType: string, filename: string): AttachmentReaderKind {
  const mime = mimeType.toLowerCase();
  const extension = extname(filename).toLowerCase();
  if (mime === "application/pdf" || extension === ".pdf") return "PDF";
  if (extension === ".docx" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "DOCX";
  if (extension === ".xlsx" || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "XLSX";
  if (extension === ".pptx" || mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "PPTX";
  if (mime === "image/svg+xml" || textExtensions.has(extension) || mime.startsWith("text/") || mime === "application/json") return "TEXT";
  if (mime.startsWith("image/")) return "IMAGE";
  if (mime.startsWith("audio/")) return "AUDIO";
  if (mime.startsWith("video/")) return "VIDEO";
  return "OTHER";
}

const coverage = (value: AttachmentCoverage) => attachmentCoverageSchema.parse(value);
const unavailable = (method: string, reason: string) => coverage({ status: "UNAVAILABLE", method, chars: null, pages: null, truncated: false, reason });
function safeName(filename: string): string {
  return filename.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "file";
}

export interface AttachmentReaderOptions {
  outputDir: string;
  maxChars?: number;
  timeoutMs?: number;
  maxBytes?: number;
  workerPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Where read results are remembered; outside the Dot's writable workspace so a Dot cannot forge its own coverage. */
  cacheDir?: string;
  /** Hard data-memory limit of the reader process (bytes); covers buffers outside the JavaScript heap. */
  memoryLimitBytes?: number;
}
type ReadOutcome = Omit<AttachmentReadResult, "artifactId"> & { transient?: boolean };

/** Reads one attachment into `outputDir`, reusing an earlier read of the same content (never a timeout or crash). */
export async function readAttachment(input: AttachmentReadInput, options: AttachmentReaderOptions): Promise<AttachmentReadResult> {
  const kind = classifyAttachment(input.mimeType, input.filename);
  const base = `${input.sha256.slice(0, 16)}-${safeName(input.filename)}`;
  const cacheDir = options.cacheDir ?? join(options.outputDir, ".coverage");
  const sidecar = join(cacheDir, `${input.sha256}-${kind.toLowerCase()}.json`);
  const cached = await readFile(sidecar, "utf8").then((text) => JSON.parse(text) as { coverage: unknown; outputPath: string | null }).catch(() => null);
  const parsed = cached ? attachmentCoverageSchema.safeParse(cached.coverage) : null;
  if (cached && parsed?.success) {
    // A cached text file that is gone (the Dot cleaned its workspace) is read again.
    const present = cached.outputPath === null || await readFile(cached.outputPath).then(() => true, () => readdir(cached.outputPath!).then(() => true, () => false));
    if (present) return { artifactId: input.artifactId, coverage: parsed.data, outputPath: cached.outputPath };
  }
  const { transient, ...result } = await readUncached(kind, input, base, options);
  if (!transient) {
    await mkdir(cacheDir, { recursive: true, mode: 0o770 }).catch(() => undefined);
    await writeFile(sidecar, JSON.stringify({ coverage: result.coverage, outputPath: result.outputPath }), { mode: 0o640 }).catch(() => undefined);
  }
  return { artifactId: input.artifactId, ...result };
}

async function readUncached(kind: AttachmentReaderKind, input: AttachmentReadInput, base: string, options: AttachmentReaderOptions): Promise<ReadOutcome> {
  const timeout = options.timeoutMs ?? 20_000;
  if (kind === "IMAGE") {
    return imageArtifactMimeTypeSchema.safeParse(input.mimeType).success
      ? { coverage: coverage({ status: "FULL", method: "vision", chars: null, pages: null, truncated: false, reason: null }), outputPath: null }
      : { coverage: unavailable("vision", `${input.mimeType} images are not sent to the model; convert to PNG, JPEG or WebP.`), outputPath: null };
  }
  if (kind === "OTHER") return { coverage: unavailable("none", `No reader for ${input.mimeType} files.`), outputPath: null };
  if (input.byteSize > (options.maxBytes ?? 50 * 1024 * 1024)) {
    return { coverage: unavailable(kind.toLowerCase(), "The file is too large to read before the task starts."), outputPath: null };
  }
  await mkdir(options.outputDir, { recursive: true, mode: 0o770 });
  if (kind === "AUDIO") {
    const seconds = await mediaSeconds(input.sourcePath, options.ffprobePath, timeout);
    return { coverage: unavailable("audio", `No transcription service for files is configured${seconds ? ` (${Math.round(seconds)} s of audio)` : ""}.`), outputPath: null };
  }
  if (kind === "VIDEO") return readVideo(input, base, options, timeout);
  const outputPath = join(options.outputDir, `${base}.txt`);
  try {
    const worker = options.workerPath ?? fileURLToPath(new URL("./attachment-reader-worker.js", import.meta.url));
    const args = ["--max-old-space-size=256", worker, kind, input.sourcePath, outputPath, String(options.maxChars ?? 400_000)];
    // A hard data limit also bounds decompressed buffers outside the JavaScript heap (zip and PDF bombs).
    const limit = String(options.memoryLimitBytes ?? 1024 * 1024 * 1024);
    const { stdout } = existsSync("/usr/bin/prlimit")
      ? await execFileAsync("/usr/bin/prlimit", [`--data=${limit}`, "--", process.execPath, ...args], { encoding: "utf8", timeout, maxBuffer: 64 * 1024 })
      : await execFileAsync(process.execPath, args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024 });
    const result = coverage(JSON.parse(stdout) as AttachmentCoverage);
    return { coverage: result, outputPath: result.status === "UNAVAILABLE" ? null : outputPath };
  } catch (error) {
    const timedOut = (error as { killed?: boolean; signal?: string }).killed || (error as { signal?: string }).signal === "SIGTERM";
    return { coverage: unavailable(kind.toLowerCase(), timedOut ? "Reading the file timed out." : "The file could not be read."), outputPath: null, transient: true };
  }
}

async function mediaSeconds(path: string, ffprobe = "/usr/bin/ffprobe", timeout = 10_000): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
      { encoding: "utf8", timeout });
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

/** Samples up to six frames so the Dot can look at a video; the audio track is not transcribed. */
async function readVideo(input: AttachmentReadInput, base: string, options: AttachmentReaderOptions, timeout: number):
  Promise<Omit<AttachmentReadResult, "artifactId">> {
  const seconds = await mediaSeconds(input.sourcePath, options.ffprobePath, timeout);
  if (!seconds) return { coverage: unavailable("video-frames", "The video could not be opened."), outputPath: null };
  const folder = join(options.outputDir, `${base}-frames`);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true, mode: 0o770 });
  const frames = 6;
  try {
    await execFileAsync(options.ffmpegPath ?? "/usr/bin/ffmpeg", ["-v", "error", "-nostdin", "-i", input.sourcePath, "-vf",
      `fps=${(frames / seconds).toFixed(6)},scale='min(960,iw)':-2`, "-frames:v", String(frames), join(folder, "frame-%02d.jpg")], { timeout });
  } catch {
    return { coverage: unavailable("video-frames", "Frames could not be extracted from the video."), outputPath: null };
  }
  const written = (await readdir(folder).catch(() => [])).filter((name) => name.endsWith(".jpg")).length;
  if (!written) return { coverage: unavailable("video-frames", "Frames could not be extracted from the video."), outputPath: null };
  return { coverage: coverage({ status: "PARTIAL", method: "video-frames", chars: null, pages: written, truncated: false,
    reason: `Sampled ${written} frames across ${Math.round(seconds)} s; the audio track is not transcribed.` }), outputPath: folder };
}

/** Reads a turn's attachments within one overall time budget. */
export async function readAttachments(inputs: AttachmentReadInput[], options: AttachmentReaderOptions & { budgetMs?: number }): Promise<AttachmentReadResult[]> {
  const deadline = Date.now() + (options.budgetMs ?? 45_000);
  const results: AttachmentReadResult[] = [];
  for (const input of inputs) {
    const left = deadline - Date.now();
    results.push(left < 1000
      ? { artifactId: input.artifactId, coverage: unavailable(classifyAttachment(input.mimeType, input.filename).toLowerCase(), "Not read: the time to read attachments ran out."), outputPath: null }
      : await readAttachment(input, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 20_000, left) }));
  }
  return results;
}

/** The line a turn receives for one read attachment. */
export function describeCoverage(result: AttachmentReadResult): string {
  const { coverage: value } = result;
  const size = [value.pages !== null ? `${value.pages} ${value.method === "video-frames" ? "frames" : value.method === "pptx-text" ? "slides" : value.method === "xlsx-cells" ? "sheets" : "pages"}` : null,
    value.chars !== null && value.chars > 0 ? `${value.chars.toLocaleString("en-US")} characters` : null].filter(Boolean).join(", ");
  const where = result.outputPath ? `; ${value.method === "video-frames" ? "frames in" : "text at"} ${result.outputPath}` : "";
  return `read ${value.status}${size ? ` (${size})` : ""}${value.reason ? ` — ${value.reason}` : ""}${where}`;
}
