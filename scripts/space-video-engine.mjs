#!/usr/bin/env node
// Space Video pane engine (Phase 2 of the Video pane plan), run by the API with ONE JSON job on stdin:
//   node scripts/space-video-engine.mjs --stdin < job.json
// It prints progress lines {"progress":0-100,"message":"..."} on stdout and ends with one {"result":{...}} line (exit 0),
// or {"error":"..."} on stderr (exit 1). Results are file paths inside the job's work directory, never bytes.
// Every path a job names must be the work directory, a file inside it, or one of the job's allowlisted sources;
// anything else is refused. ffmpeg, ffprobe, yt-dlp and the Python worker run with argument arrays only (no shell),
// under nice -n 10, and each op has its own deadline (the child is SIGKILLed when it passes). At start the engine
// marks its work directory with .space-video-job and removes sibling directories that carry that marker and were
// last changed more than 24 hours ago (finished jobs the API no longer serves); other directories are left alone.
import { childProcessEnv } from "../packages/runtime/dist/child-process-env.js";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const WORKER = join(scriptsDir, "space-video-worker.py");
export const MANIFEST = JSON.parse(await readFile(join(scriptsDir, "video-tools/manifest.json"), "utf8"));
export const DEFAULT_TOOLS_DIR = "/opt/spaceapp/var/models/video";
const FFMPEG = "/usr/bin/ffmpeg", FFPROBE = "/usr/bin/ffprobe", YTDLP = "/usr/local/bin/yt-dlp", NICE = "/usr/bin/nice";
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const MARKER = ".space-video-job";
export const TIMEOUTS_MS = { probe: 30e3, fetch: 1800e3, captions: 60e3, proxy: 600e3, transcribe: 1200e3, analyze: 900e3, assemble: 1800e3, tts: 300e3, music_search: 20e3, music_fetch: 60e3 };
export const TRANSITIONS = ["auto", "cut", "fade", "dissolve", "fadeblack", "fadewhite", "wipeleft", "wiperight", "slideup", "slidedown", "circleopen", "smoothleft", "zoomin"];
export const FILTERS = {
  none: "", warm: "colorbalance=rs=.08:gs=.02:bs=-.08,eq=saturation=1.1", cool: "colorbalance=rs=-.08:bs=.08,eq=saturation=1.05",
  vivid: "eq=saturation=1.4:contrast=1.1", cinematic: "curves=m='0/0 0.25/0.2 0.75/0.8 1/1',colorbalance=bs=.06:rh=.06,eq=saturation=.9", bw: "hue=s=0", stabilize: null
};
export const CAPTION_STYLES = ["none", "karaoke", "bold-center", "lower-third"];
export const OVERLAY_POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right", "center", "full"];
const REFRAMES = ["OFF", "CENTER", "FACE"];
const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp"], AUDIO_EXT = [".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"];
const CAP = { shots: 500, silences: 500, candidates: 20 };
const MAX_MUSIC_BYTES = 50 * 1024 * 1024;
// YouTube asks the server's own address to sign in ("not a bot"); the CLI VPN routes' SOCKS5 proxies get through (the same
// addresses as FREELANCE_EGRESS_PROXIES in contracts; Mullvad left out, its account does not handshake). Tried in order after direct.
export const FETCH_PROXIES = ["socks5://10.254.241.2:1080", "socks5://10.254.242.2:1080", "socks5://10.254.244.2:1080"];
const BOT_CHECK = /not a bot|HTTP Error 429/i;
/** yt-dlp's format: the best video up to `maxHeight` (0: the best the site has, the full resolution) with the best audio. */
export const ytdlpFormat = (maxHeight) => maxHeight ? `bv*[height<=${maxHeight}]+ba/b` : "bv*+ba/b";
/** yt-dlp direct, then through each VPN route: direct fails for good unless the site asked for a sign-in; a route that is down passes to the next. */
async function ytdlp(args) {
  let failure = null;
  for (const proxy of [null, ...FETCH_PROXIES]) {
    try { return await run(YTDLP, proxy ? ["--proxy", proxy, ...args] : args); } catch (error) {
      failure = error;
      if (!proxy && !BOT_CHECK.test(error.message)) break;
      progress(5, "Trying a VPN route");
    }
  }
  throw failure;
}
const H264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-threads", "8"];

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function fail(message) { throw new Error(message); }
function onlyKeys(value, allowed, label) {
  if (value === undefined) return {};
  if (!isObject(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}.${key} is not allowed`);
  return value;
}
function num(value, min, max, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be a number from ${min} to ${max}`);
  return value;
}
function int(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} must be a whole number from ${min} to ${max}`);
  return value;
}
function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} must be one of ${allowed.join(", ")}`);
  return value;
}
function str(value, max, label, pattern = null) {
  if (typeof value !== "string" || !value.trim() || value.length > max || (pattern && !pattern.test(value))) fail(`${label} must be text of at most ${max} characters${pattern ? ` matching ${pattern}` : ""}`);
  return value;
}
function absPath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value.includes("\0")) fail(`${label} must be a normalized absolute path`);
  return value;
}
function httpsUrl(value, label) {
  const url = typeof value === "string" && value.length <= 2048 ? URL.parse(value) : null;
  if (url?.protocol !== "https:") fail(`${label} must be an https URL`);
  return url.href;
}
const isFile = async (path) => (await stat(path).catch(() => null))?.isFile() ?? false;
const r3 = (value) => Math.round(value * 1000) / 1000;
const progress = (pct, message) => process.stdout.write(`${JSON.stringify({ progress: Math.round(pct), message })}\n`);
/** A path inside a filter graph: option-level escapes (\ ' :), then graph-level ones (\ ' [ ] , ;). */
const fe = (value) => String(value).replace(/[\\':]/g, (c) => `\\${c}`).replace(/[\\'[\],;]/g, (c) => `\\${c}`);
const sha256File = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

let deadline = Infinity, opName = "";
/** Runs a command under nice -n 10 with argument arrays only; SIGKILL at the op's deadline. */
function run(command, args, { input, onLine, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NICE, ["-n", "10", command, ...args], { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: childProcessEnv(env) });
    let out = "", err = "", killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, Math.max(1, deadline - Date.now()));
    if (onLine) createInterface({ input: child.stdout }).on("line", onLine); else child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) reject(new Error(`${basename(command)} exceeded the ${opName} time limit of ${TIMEOUTS_MS[opName] / 1000} s.`));
      else if (code !== 0) reject(new Error(`${basename(command)} failed (${code}): ${err.trim().slice(-400)}`));
      else resolve({ stdout: out, stderr: err });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}
const ffmpeg = (args, { log = "error", ...rest } = {}) => run(FFMPEG, ["-y", "-loglevel", log, "-nostats", "-nostdin", "-threads", "8", ...args], rest);

/** What ffprobe knows about a media file (the probe op's result). */
export async function probeInfo(path) {
  const info = JSON.parse((await run(FFPROBE, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path])).stdout);
  const video = info.streams?.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1), audio = info.streams?.find((s) => s.codec_type === "audio");
  if (!video && !audio) fail(`${basename(path)} has no video or audio stream`);
  const [n, d] = (video?.r_frame_rate ?? "0/1").split("/").map(Number);
  return { durationSec: r3(Number(info.format?.duration ?? 0)), width: video?.width ?? 0, height: video?.height ?? 0, fps: d ? r3(n / d) : 0, hasVideo: Boolean(video),
    hasAudio: Boolean(audio), videoCodec: video?.codec_name ?? null, audioCodec: audio?.codec_name ?? null, byteSize: Number(info.format?.size ?? 0) };
}

/** The job's directories and sources, with the checks every path goes through. */
async function jobContext(raw) {
  const workDir = absPath(raw.workDir, "workDir");
  if (!(await stat(workDir).catch(() => null))?.isDirectory()) fail("workDir must be an existing directory");
  const realWork = await realpath(workDir);
  const toolsDir = raw.toolsDir === undefined ? DEFAULT_TOOLS_DIR : absPath(raw.toolsDir, "toolsDir");
  if (raw.sources !== undefined && !Array.isArray(raw.sources)) fail("sources must be a list");
  const sources = [];
  for (const [i, entry] of (raw.sources ?? []).entries()) {
    const path = absPath(onlyKeys(entry, ["path"], `sources[${i}]`).path, `sources[${i}].path`);
    if (!(await isFile(path))) fail(`sources[${i}].path is not a file`);
    sources.push({ path });
  }
  const inside = (path) => path === workDir || path.startsWith(workDir + sep);
  return {
    workDir, toolsDir, sources, inside,
    sourceIndex(index) { return int(index, 0, Math.max(0, sources.length - 1), "sourceIndex"); },
    source(index) { if (!sources.length) fail("the job names no sources"); return sources[this.sourceIndex(index)].path; },
    /** An input file the job may read: one of the sources, or a real file inside the work directory (no symlink out of it). */
    async allowedFile(value, label, extensions = null) {
      const path = absPath(value, label);
      if (!sources.some((s) => s.path === path)) {
        const real = inside(path) ? await realpath(path).catch(() => null) : null;
        if (!real || !(real === realWork || real.startsWith(realWork + sep))) fail(`${label} must be a file inside the work directory or one of the sources`);
      }
      if (!(await isFile(path))) fail(`${label} is not a file`);
      if (extensions && !extensions.includes(extname(path).toLowerCase())) fail(`${label} must be a ${extensions.join("/")} file`);
      return path;
    },
    tool(name, file = "") { return join(toolsDir, name, MANIFEST.tools[name].version, file); }
  };
}

/** Removes sibling job directories (marker older than 24 h); best effort, never the current one. */
async function sweepSiblings(workDir) {
  const parent = dirname(workDir), cutoff = Date.now() - 24 * 3600e3;
  for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name === basename(workDir) || !/^[A-Za-z0-9][\w.-]*$/.test(entry.name)) continue;
    const dir = join(parent, entry.name);
    const [marker, info] = await Promise.all([stat(join(dir, MARKER)).catch(() => null), stat(dir).catch(() => null)]);
    if (marker && info && marker.mtimeMs < cutoff && info.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** One request to the Python worker in the tools venv; its progress is mapped onto [from, to]. */
async function worker(ctx, request, from, to) {
  const python = join(ctx.toolsDir, "venv/bin/python");
  if (!existsSync(python)) fail("VIDEO_TOOLS_MISSING: run node scripts/space-video-tools-setup.mjs");
  let result = null, error = null;
  const env = { PATH: "/usr/bin:/bin", HOME: ctx.workDir, HF_HOME: join(ctx.toolsDir, "hf-cache"), OMP_NUM_THREADS: "8", TOKENIZERS_PARALLELISM: "false" };
  try {
    await run(python, ["-I", WORKER], { input: `${JSON.stringify(request)}\n`, env, onLine: (line) => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (typeof message.progress === "number") progress(from + (to - from) * Math.min(100, Math.max(0, message.progress)) / 100, String(message.message ?? ""));
      if (message.result !== undefined) result = message.result;
      if (typeof message.error === "string") error = message.error;
    } });
  } catch (cause) {
    if (error) fail(error);
    throw cause;
  }
  if (error) fail(error);
  if (result === null) fail("the video worker answered nothing");
  return result;
}

async function probeOp(job, ctx) {
  const { hasVideo, ...info } = await probeInfo(ctx.source(job.sourceIndex));
  return info;
}

async function fetchOp(job, ctx) {
  const url = httpsUrl(job.url, "url");
  const max = int(job.maxDurationSec ?? 3600, 1, 86400, "maxDurationSec");
  const maxHeight = int(job.maxHeight ?? 1080, 0, 4320, "maxHeight");
  progress(5, "Downloading");
  // "<=?" also passes a video whose duration the site does not tell (a direct file); the probe below checks it then.
  const args = ["--no-playlist", "--no-warnings", "--no-progress", "--restrict-filenames", "--socket-timeout", "30", "-f", ytdlpFormat(maxHeight), "--max-filesize", "4G",
    "--match-filter", `duration<=?${max}`, "--merge-output-format", "mp4", "--print", "after_move:filepath", "-o", join(ctx.workDir, "source-%(id)s.%(ext)s"), url];
  const { stdout } = await ytdlp(args);
  const path = stdout.trim().split("\n").pop() ?? "";
  if (!ctx.inside(path) || !(await isFile(path))) fail(`yt-dlp downloaded nothing (the video may be longer than ${max} s or larger than 4 GB)`);
  const { durationSec, width, height } = await probeInfo(path);
  if (durationSec > max) { await rm(path, { force: true }); fail(`the video is ${durationSec} s, longer than maxDurationSec ${max}`); }
  return { path, durationSec, width, height };
}

/** The video's own captions in the language it is spoken (YouTube's "-orig" speech track) as json3, or null when it has none. */
async function captionsOp(job, ctx) {
  const url = httpsUrl(job.url, "url");
  progress(5, "Reading the captions");
  await ytdlp(["--no-playlist", "--no-warnings", "--no-progress", "--socket-timeout", "30", "--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", ".*-orig",
    "--sub-format", "json3", "-o", join(ctx.workDir, "captions.%(ext)s"), url]);
  const name = (await readdir(ctx.workDir)).find((entry) => entry.startsWith("captions.") && entry.endsWith(".json3"));
  return { path: name ? join(ctx.workDir, name) : null };
}

async function proxyOp(job, ctx) {
  const src = ctx.source(job.sourceIndex);
  const info = await probeInfo(src);
  if (!info.hasVideo) fail("the source has no video stream");
  const proxyPath = join(ctx.workDir, "proxy.mp4"), contactPath = join(ctx.workDir, "contact.png"), frameDir = join(ctx.workDir, "frames");
  progress(5, "Encoding the proxy");
  await ffmpeg(["-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-vf", `${info.height > 480 ? "scale=-2:480" : "scale=trunc(iw/2)*2:trunc(ih/2)*2"},format=yuv420p`,
    "-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-threads", "8", proxyPath]);
  progress(60, "Contact sheet");
  const duration = Math.max(info.durationSec, 1);
  await ffmpeg(["-i", proxyPath, "-vf", `fps=${(30 / duration).toFixed(6)},scale=320:-1,drawtext=fontfile=${fe(FONT)}:text='%{pts\\:hms}':fontsize=18:fontcolor=white:box=1:boxcolor=black@0.5:x=4:y=4,tile=6x5:padding=2:margin=2`,
    "-frames:v", "1", "-update", "1", contactPath]);
  progress(75, "Frames");
  await rm(frameDir, { recursive: true, force: true });
  await mkdir(frameDir);
  const frameEverySec = Math.max(2, Math.ceil(duration / 300));
  await ffmpeg(["-i", proxyPath, "-vf", `fps=1/${frameEverySec}`, "-frames:v", "300", "-q:v", "4", join(frameDir, "%04d.jpg")]);
  return { proxyPath, contactPath, frameDir, frameCount: (await readdir(frameDir)).length, frameEverySec };
}

const LANG = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
async function transcribeOp(job, ctx) {
  const src = ctx.source(job.sourceIndex);
  // null means absent, like undefined: the API sends null for an unset option.
  const language = job.language == null ? null : str(job.language, 8, "language", LANG);
  const engine = job.engine == null ? "whisper" : oneOf(job.engine, ["whisper", "assemblyai", "cartesia", "livekit"], "engine");
  // faster-whisper opens streams.audio[0] and dies with an IndexError on a silent recording (the first real cut, 2026-10-21).
  if (!(await probeInfo(src)).hasAudio) fail(`source ${job.sourceIndex} has no audio track: nothing to transcribe (no captions; use technique scene or manual)`);
  const reply = engine === "whisper" ? await worker(ctx, { op: "transcribe", path: src, language, modelDir: ctx.tool("whisper-small") }, 5, 95)
    : await cloudTranscribe(engine, ctx, src, language);
  const segments = (reply.segments ?? []).map((s) => ({ start: r3(s.start), end: r3(s.end), text: String(s.text ?? "").trim(),
    words: (s.words ?? []).map((w) => ({ start: r3(w.start), end: r3(w.end), word: String(w.word ?? "").trim() })) }));
  const wordsPath = join(ctx.workDir, "words.json"), transcriptPath = join(ctx.workDir, "transcript.txt");
  await writeFile(wordsPath, JSON.stringify({ sourceIndex: job.sourceIndex, language: reply.language, durationSec: r3(reply.durationSec ?? 0), segments }));
  await writeFile(transcriptPath, `${segments.map((s) => s.text).join("\n")}\n`);
  return { wordsPath, transcriptPath, language: reply.language, durationSec: r3(reply.durationSec ?? 0), wordCount: segments.reduce((n, s) => n + s.words.length, 0) };
}

const complement = (silences, duration) => {
  const speech = []; let cursor = 0;
  for (const s of silences) { if (s.start > cursor + 0.05) speech.push({ start: r3(cursor), end: r3(s.start) }); cursor = Math.max(cursor, s.end); }
  if (duration > cursor + 0.05) speech.push({ start: r3(cursor), end: r3(duration) });
  return speech;
};
const toShots = (times, duration) => {
  const cuts = [...new Set(times.map(r3).filter((t) => t > 0.2 && t < duration - 0.2))].sort((a, b) => a - b);
  return [0, ...cuts].map((start, i, all) => ({ start, end: i + 1 < all.length ? all[i + 1] : r3(duration) }));
};

async function silencesOf(ctx, src, silenceDb, minSilenceSec, duration) {
  const autoEditor = ctx.tool("auto-editor", "auto-editor");
  if (existsSync(autoEditor)) {
    // shortcut: auto-editor applies its own 0.2 s margin instead of minSilenceSec; pass a margin flag once its CLI is pinned to one.
    const out = join(ctx.workDir, "auto-editor.json");
    await run(autoEditor, [src, "--edit", `audio:threshold=${silenceDb}dB`, "--export", "v1", "--quiet", "--no-open", "-o", out]);
    const data = JSON.parse(await readFile(out, "utf8"));
    const [n, d] = String(data.timebase ?? "30/1").split("/").map(Number);
    return (data.chunks ?? []).filter((chunk) => chunk[2] >= 99999).map(([start, end]) => ({ start: r3(start * d / n), end: r3(end * d / n) }));
  }
  const { stderr } = await ffmpeg(["-i", src, "-vn", "-af", `silencedetect=n=${silenceDb}dB:d=${minSilenceSec}`, "-f", "null", "-"], { log: "info" });
  const silences = []; let start = null;
  for (const [, key, value] of stderr.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    if (key === "start") start = Math.max(0, Number(value));
    else if (start !== null) { silences.push({ start: r3(start), end: r3(Number(value)) }); start = null; }
  }
  if (start !== null) silences.push({ start: r3(start), end: r3(duration) });
  return silences;
}

/** Momentary loudness every 100 ms: [{t, m}]. */
async function loudnessOf(ctx, src) {
  const out = join(ctx.workDir, "loudness.txt");
  await ffmpeg(["-i", src, "-vn", "-af", `ebur128=metadata=1,ametadata=print:key=lavfi.r128.M:file=${fe(out)}`, "-f", "null", "-"]);
  return [...(await readFile(out, "utf8")).matchAll(/pts_time:(-?[\d.]+)\s+lavfi\.r128\.M=(-?[\d.]+)/g)].map(([, t, m]) => ({ t: Number(t), m: Math.max(-70, Number(m)) }));
}

/** Segments of 8-45 s ranked by words per second, loudness peak and shot alignment; the top 20, non-overlapping. */
function highlightCandidates(words, loudness, shots) {
  const segments = (words.segments ?? []).filter((s) => s.end > s.start);
  const cuts = shots.map((s) => s.start);
  const raw = [];
  for (let i = 0; i < segments.length; i++) {
    let count = 0;
    for (let j = i; j < segments.length; j++) {
      count += segments[j].words?.length || segments[j].text.split(/\s+/).filter(Boolean).length;
      const start = segments[i].start, end = segments[j].end, duration = end - start;
      if (duration > 45) break;
      if (duration < 8) continue;
      const peak = loudness.filter((l) => l.t >= start && l.t <= end).reduce((max, l) => Math.max(max, l.m), -70);
      raw.push({ start, end, wps: count / duration, peak, align: cuts.some((c) => Math.abs(c - start) <= 0.5) ? 1 : 0, text: segments.slice(i, j + 1).map((s) => s.text.trim()).join(" ").slice(0, 400) });
    }
  }
  const range = (key) => { const values = raw.map((c) => c[key]); const min = Math.min(...values), max = Math.max(...values); return (v) => (max > min ? (v - min) / (max - min) : 0.5); };
  const wps = range("wps"), peak = range("peak");
  const scored = raw.map((c) => ({ start: c.start, end: c.end, score: r3(0.5 * wps(c.wps) + 0.3 * peak(c.peak) + 0.2 * c.align), text: c.text })).sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of scored) if (picked.length < CAP.candidates && !picked.some((p) => c.start < p.end && p.start < c.end)) picked.push(c);
  return picked;
}

async function analyzeOp(job, ctx) {
  const src = ctx.source(job.sourceIndex);
  const technique = oneOf(job.technique ?? "manual", ["silence", "scene", "highlights", "manual"], "technique");
  const reframe = oneOf(job.reframe ?? "OFF", REFRAMES, "reframe");
  const silenceDb = num(job.silenceDb ?? -30, -90, 0, "silenceDb"), minSilenceSec = num(job.minSilenceSec ?? 0.5, 0.1, 30, "minSilenceSec");
  const sceneThreshold = num(job.sceneThreshold ?? 27, 1, 100, "sceneThreshold");
  const wordsPath = job.wordsPath == null ? null : await ctx.allowedFile(job.wordsPath, "wordsPath", [".json"]);
  if (technique === "highlights" && !wordsPath) fail("technique highlights needs wordsPath (run transcribe first)");
  const info = await probeInfo(src), duration = info.durationSec;
  progress(5, "Shots");
  let shots;
  if (!info.hasVideo) shots = [{ start: 0, end: duration }];
  else if (technique === "scene") shots = toShots((await worker(ctx, { op: "scenes", path: src, threshold: sceneThreshold }, 5, 35)).scenes.map((s) => s.start), duration);
  else {
    const out = join(ctx.workDir, "scdet.txt");
    // shortcut: scdet's 0-100 score is scaled from PySceneDetect's threshold (10 ~ 27); use technique scene for the real detector.
    await ffmpeg(["-i", src, "-an", "-vf", `scale=320:-2,scdet=threshold=${(sceneThreshold * 10 / 27).toFixed(2)},metadata=print:key=lavfi.scd.time:file=${fe(out)}`, "-f", "null", "-"]);
    shots = toShots([...(await readFile(out, "utf8")).matchAll(/lavfi\.scd\.time=([\d.]+)/g)].map((m) => Number(m[1])), duration);
  }
  shots = shots.slice(0, CAP.shots);
  progress(40, "Silences");
  const silences = (info.hasAudio ? await silencesOf(ctx, src, silenceDb, minSilenceSec, duration) : []).slice(0, CAP.silences);
  const speech = complement(silences, duration);
  let candidates = [];
  if (technique === "highlights") {
    progress(55, "Highlights");
    candidates = highlightCandidates(JSON.parse(await readFile(wordsPath, "utf8")), info.hasAudio ? await loudnessOf(ctx, src) : [], shots);
  }
  let track = [];
  if (reframe === "FACE" && info.hasVideo) {
    const proxy = join(ctx.workDir, "proxy.mp4");
    const faces = await worker(ctx, { op: "faces", path: existsSync(proxy) ? proxy : src, shots, modelPath: ctx.tool("yunet", "face_detection_yunet_2023mar.onnx") }, 70, 95);
    track = faces.map((f) => ({ start: r3(f.start), end: r3(f.end), cx: r3(f.cx), cy: r3(f.cy) }));
  }
  const analysisPath = join(ctx.workDir, "analysis.json");
  const analysis = { technique, durationSec: duration, shots, silences, speech, candidates, reframe: track };
  await writeFile(analysisPath, JSON.stringify(analysis));
  return { analysisPath, ...analysis };
}

const SAFE_SIDES = ["top", "right", "bottom", "left"];
export function validateOutputs(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 10) fail("outputs must list 1 to 10 formats");
  const seen = new Set();
  return raw.map((entry, i) => {
    const o = onlyKeys(entry, ["formatId", "width", "height", "safeArea", "maxDurationSec", "label"], `outputs[${i}]`);
    const formatId = str(o.formatId, 40, `outputs[${i}].formatId`, /^[a-z0-9][a-z0-9-]*$/);
    if (seen.has(formatId)) fail(`outputs[${i}].formatId repeats ${formatId}`);
    seen.add(formatId);
    const width = int(o.width, 64, 4096, `outputs[${i}].width`), height = int(o.height, 64, 4096, `outputs[${i}].height`);
    if (width % 2 || height % 2) fail(`outputs[${i}] must have even width and height`);
    const safe = onlyKeys(o.safeArea, SAFE_SIDES, `outputs[${i}].safeArea`);
    const safeArea = Object.fromEntries(SAFE_SIDES.map((side) => [side, safe[side] === undefined ? 0
      : int(safe[side], 0, Math.floor((side === "top" || side === "bottom" ? height : width) / 2) - 1, `outputs[${i}].safeArea.${side}`)]));
    const maxDurationSec = o.maxDurationSec === undefined || o.maxDurationSec === null ? null : num(o.maxDurationSec, 1, 86400, `outputs[${i}].maxDurationSec`);
    return { formatId, width, height, safeArea, maxDurationSec, label: o.label === undefined ? formatId : str(o.label, 80, `outputs[${i}].label`) };
  });
}

export async function validateTimeline(raw, ctx) {
  const t = onlyKeys(raw, ["clips", "transition", "transitionSec", "filter", "reframe", "captions", "overlays", "narration", "music"], "timeline");
  if (!Array.isArray(t.clips) || !t.clips.length || t.clips.length > 200) fail("timeline.clips must list 1 to 200 clips");
  const clips = t.clips.map((entry, i) => {
    const c = onlyKeys(entry, ["sourceIndex", "inSec", "outSec", "speed"], `clips[${i}]`);
    const clip = { sourceIndex: ctx.sourceIndex(c.sourceIndex), inSec: num(c.inSec, 0, 86400, `clips[${i}].inSec`), outSec: num(c.outSec, 0, 86400, `clips[${i}].outSec`), speed: num(c.speed ?? 1, 0.5, 4, `clips[${i}].speed`) };
    if (clip.outSec - clip.inSec < 0.2) fail(`clips[${i}] must be at least 0.2 s long`);
    return clip;
  });
  const captions = onlyKeys(t.captions, ["style", "language", "position"], "timeline.captions");
  const overlays = [];
  if (t.overlays !== undefined && !Array.isArray(t.overlays)) fail("timeline.overlays must be a list");
  if ((t.overlays ?? []).length > 20) fail("timeline.overlays must list at most 20 overlays");
  for (const [i, entry] of (t.overlays ?? []).entries()) {
    const o = onlyKeys(entry, ["path", "fromSec", "toSec", "position", "opacity"], `overlays[${i}]`);
    const overlay = { path: await ctx.allowedFile(o.path, `overlays[${i}].path`, IMAGE_EXT), fromSec: num(o.fromSec ?? 0, 0, 86400, `overlays[${i}].fromSec`),
      toSec: num(o.toSec ?? 86400, 0, 86400, `overlays[${i}].toSec`), position: oneOf(o.position ?? "top-right", OVERLAY_POSITIONS, `overlays[${i}].position`), opacity: num(o.opacity ?? 1, 0, 1, `overlays[${i}].opacity`) };
    if (overlay.toSec <= overlay.fromSec) fail(`overlays[${i}].toSec must be after fromSec`);
    overlays.push(overlay);
  }
  let narration = null;
  if (t.narration !== undefined && t.narration !== null) {
    const n = onlyKeys(t.narration, ["path", "volumeDb"], "timeline.narration");
    narration = { path: await ctx.allowedFile(n.path, "timeline.narration.path", AUDIO_EXT), volumeDb: num(n.volumeDb ?? 0, -60, 20, "timeline.narration.volumeDb") };
  }
  let music = null;
  if (t.music !== undefined && t.music !== null) {
    const m = onlyKeys(t.music, ["path", "volumeDb", "duckDb", "fadeOutSec"], "timeline.music");
    music = { path: await ctx.allowedFile(m.path, "timeline.music.path", AUDIO_EXT), volumeDb: num(m.volumeDb ?? -18, -60, 20, "timeline.music.volumeDb"),
      duckDb: num(m.duckDb ?? -12, -60, 0, "timeline.music.duckDb"), fadeOutSec: num(m.fadeOutSec ?? 2, 0, 30, "timeline.music.fadeOutSec") };
  }
  return { clips, transition: oneOf(t.transition ?? "auto", TRANSITIONS, "timeline.transition"), transitionSec: num(t.transitionSec ?? 0.4, 0.1, 3, "timeline.transitionSec"),
    filter: oneOf(t.filter ?? "none", Object.keys(FILTERS), "timeline.filter"), reframe: oneOf(t.reframe ?? "OFF", REFRAMES, "timeline.reframe"),
    captions: { style: oneOf(captions.style ?? "none", CAPTION_STYLES, "timeline.captions.style"), position: oneOf(captions.position ?? "BOTTOM", ["TOP", "BOTTOM"], "timeline.captions.position"),
      language: captions.language == null ? null : str(captions.language, 8, "timeline.captions.language", LANG) },
    overlays, narration, music };
}

/** Clips grouped for the chain: "cut" joins everything, "auto" joins runs of one source and fades between them, else one group per clip. */
export function groupClips(timeline) {
  const groups = [];
  for (const [i, clip] of timeline.clips.entries()) {
    const last = groups.at(-1);
    if (last && (timeline.transition === "cut" || (timeline.transition === "auto" && last.sourceIndex === clip.sourceIndex))) last.clips.push(i);
    else groups.push({ sourceIndex: clip.sourceIndex, clips: [i] });
  }
  return groups;
}

/** The video part of a clip's intermediate: from [0:v] to [rf] at the output size. */
function reframeChain(mode, info, W, H, clip, analysis) {
  const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase`;
  if (mode === "OFF") return `[0:v]split[bg][fg];[bg]${cover},crop=${W}:${H},gblur=sigma=24:steps=1[bgb];[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2[rf]`;
  const mid = (clip.inSec + clip.outSec) / 2;
  const face = mode === "FACE" ? (analysis?.reframe ?? []).find((f) => f.start <= mid && mid < f.end) : null;
  if (!face || !info.width || !info.height) return `[0:v]${cover},crop=${W}:${H}[rf]`;
  // shortcut: one face center per clip (the shot under its middle); per-shot panning needs sendcmd on crop.
  const scale = Math.max(W / info.width, H / info.height), sw = Math.ceil(info.width * scale / 2) * 2, sh = Math.ceil(info.height * scale / 2) * 2;
  const x = Math.min(Math.max(Math.round(sw * face.cx - W / 2), 0), sw - W), y = Math.min(Math.max(Math.round(sh * face.cy - H / 2), 0), sh - H);
  return `[0:v]scale=${sw}:${sh},crop=${W}:${H}:${x}:${y}[rf]`;
}

const assTime = (sec) => { const cs = Math.max(0, Math.round(sec * 100)); const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60; return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`; };
const assText = (text) => text.replace(/[{}]/g, (c) => (c === "{" ? "(" : ")")).replace(/\\/g, "/").replace(/\s+/g, " ");
/** Words re-timed onto the timeline (only clips of the words' source) as an ASS file in the format's safe area. */
export function captionsAss(words, layout, captions, output) {
  const { width: W, height: H, safeArea } = output;
  const timed = [];
  for (const clip of layout.filter((c) => c.sourceIndex === (words.sourceIndex ?? 0))) {
    for (const seg of words.segments ?? []) for (const w of seg.words ?? []) {
      if (!(w.start >= clip.inSec && w.start < clip.outSec) || !String(w.word).trim()) continue;
      timed.push({ start: clip.start + (w.start - clip.inSec) / clip.speed, end: clip.start + (Math.min(w.end, clip.outSec) - clip.inSec) / clip.speed, word: assText(String(w.word).trim()) });
    }
  }
  timed.sort((a, b) => a.start - b.start);
  const style = captions.style, maxWords = style === "bold-center" ? 4 : style === "karaoke" ? 5 : 8, maxSpan = style === "lower-third" ? 4 : 2.5;
  const lines = [];
  for (const w of timed) {
    const line = lines.at(-1);
    if (line && line.length < maxWords && w.start - line[0].start < maxSpan && w.start - line.at(-1).end < 0.8) line.push(w); else lines.push([w]);
  }
  const fontSize = Math.round(H * (style === "bold-center" ? 0.065 : 0.045));
  const alignment = captions.position === "TOP" ? 8 : 2, marginV = captions.position === "TOP" ? safeArea.top : safeArea.bottom;
  const colours = style === "karaoke" ? "&H0000FFFF,&H00FFFFFF" : "&H00FFFFFF,&H00FFFFFF";
  const border = style === "lower-third" ? "3,2,0" : `1,${style === "bold-center" ? 4 : 3},0`;
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n`
    + `Style: Default,DejaVu Sans,${fontSize},${colours},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,${border},${alignment},${safeArea.left},${safeArea.right},${marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const events = lines.map((line) => {
    const start = line[0].start, end = Math.max(line.at(-1).end, start + 0.3);
    const text = style === "karaoke" ? line.map((w, i) => `{\\k${Math.max(1, Math.round(((i + 1 < line.length ? line[i + 1].start : end) - w.start) * 100))}}${w.word}`).join(" ") : line.map((w) => w.word).join(" ");
    return `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`;
  });
  return `${header}${events.join("\n")}\n`;
}

async function concatCopy(ff, files, out, dir) {
  const list = join(dir, `${basename(out, ".mp4")}.txt`);
  await writeFile(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'\n`).join(""));
  await ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
}

async function renderOutput(ctx, timeline, output, groups, infos, words, analysis, [p0, p1]) {
  const { formatId, width: W, height: H, safeArea } = output;
  const logPath = join(ctx.workDir, `assemble-${formatId}.log`);
  await writeFile(logPath, "");
  const ff = async (args, opts) => {
    const script = args[args.indexOf("-filter_complex_script") + 1];
    await appendFile(logPath, `ffmpeg ${args.join(" ")}\n${script && args.includes("-filter_complex_script") ? `  graph: ${(await readFile(script, "utf8")).replace(/\n/g, " ")}\n` : ""}`);
    return ffmpeg(args, opts);
  };
  const tmp = join(ctx.workDir, `assemble-${formatId}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp);
  const step = (fraction, message) => progress(p0 + (p1 - p0) * fraction, `${output.label}: ${message}`);
  const T = timeline.transition === "cut" ? 0 : timeline.transitionSec;
  // 1. one intermediate per clip at the output size
  const clipFiles = [];
  for (const [i, clip] of timeline.clips.entries()) {
    step(0.5 * i / timeline.clips.length, `clip ${i + 1} of ${timeline.clips.length}`);
    const info = infos[clip.sourceIndex], file = join(tmp, `clip-${i}.mp4`), length = (clip.outSec - clip.inSec) / clip.speed;
    const audio = info.hasAudio ? `[0:a]atempo=${clip.speed},aformat=sample_rates=48000:channel_layouts=stereo[a]` : `anullsrc=r=48000:cl=stereo,atrim=duration=${length.toFixed(3)}[a]`;
    // Identical size, rate, format and SAR on every intermediate: concat -c copy and xfade need uniform streams.
    const graph = `${reframeChain(timeline.reframe, info, W, H, clip, analysis)};[rf]setpts=PTS/${clip.speed},fps=30,format=yuv420p,setsar=1[v];${audio}`;
    await writeFile(join(tmp, `clip-${i}.graph`), graph);
    await ff(["-ss", String(clip.inSec), "-t", String(clip.outSec - clip.inSec), "-i", ctx.sources[clip.sourceIndex].path, "-filter_complex_script", join(tmp, `clip-${i}.graph`),
      "-map", "[v]", "-map", "[a]", ...H264, "-crf", "18", "-preset", "veryfast", "-b:a", "192k", file]);
    clipFiles.push(file);
  }
  // 2. the chain: same-source runs by concat, the rest by xfade/acrossfade
  step(0.5, "joining");
  const groupFiles = [];
  for (const [g, group] of groups.entries()) {
    if (group.clips.length === 1) { groupFiles.push(clipFiles[group.clips[0]]); continue; }
    const file = join(tmp, `group-${g}.mp4`);
    await concatCopy(ff, group.clips.map((i) => clipFiles[i]), file, tmp);
    groupFiles.push(file);
  }
  let chain = groupFiles[0];
  const layout = [];
  if (groupFiles.length > 1) {
    const durations = [];
    for (const file of groupFiles) durations.push((await probeInfo(file)).durationSec);
    durations.forEach((d, i) => { if (d <= T) fail(`${output.label}: clip ${groups[i].clips[0] + 1} (${d} s) is shorter than the ${T} s transition`); });
    const transition = timeline.transition === "auto" ? "fade" : timeline.transition;
    let graph = "", offset = 0, v = "[0:v]", a = "[0:a]";
    for (let i = 1; i < groupFiles.length; i++) {
      offset += durations[i - 1] - T;
      const vo = i === groupFiles.length - 1 ? "[v]" : `[v${i}]`, ao = i === groupFiles.length - 1 ? "[a]" : `[a${i}]`;
      graph += `${v}[${i}:v]xfade=transition=${transition}:duration=${T}:offset=${offset.toFixed(3)}${vo};${a}[${i}:a]acrossfade=d=${T}:c1=tri:c2=tri${ao};`;
      v = vo; a = ao;
    }
    chain = join(tmp, "chain.mp4");
    await writeFile(join(tmp, "chain.graph"), graph);
    await ff([...groupFiles.flatMap((f) => ["-i", f]), "-filter_complex_script", join(tmp, "chain.graph"), "-map", "[v]", "-map", "[a]", ...H264, "-crf", "18", "-preset", "veryfast", "-b:a", "192k", chain]);
  }
  let cursor = 0;
  for (const [g, group] of groups.entries()) {
    if (g > 0) cursor -= T;
    for (const i of group.clips) { const clip = timeline.clips[i]; layout.push({ ...clip, start: cursor }); cursor += (clip.outSec - clip.inSec) / clip.speed; }
  }
  const D = cursor;
  // 3-6. the final pass: filter preset, captions, overlays, audio mix
  step(0.7, "finishing");
  const inputs = ["-i", chain];
  const graph = [], video = [];
  if (timeline.filter === "stabilize") {
    const trf = join(tmp, "stab.trf");
    await ff(["-i", chain, "-an", "-vf", `vidstabdetect=result=${fe(trf)}:shakiness=5`, "-f", "null", "-"]);
    video.push(`vidstabtransform=input=${fe(trf)}:smoothing=30:zoom=2,unsharp=5:5:0.8:3:3:0.4`);
  } else if (FILTERS[timeline.filter]) video.push(FILTERS[timeline.filter]);
  if (timeline.captions.style !== "none" && words) {
    const assPath = join(tmp, "captions.ass");
    await writeFile(assPath, captionsAss(words, layout, timeline.captions, output));
    video.push(`ass=${fe(assPath)}`);
  }
  graph.push(`[0:v]${video.length ? video.join(",") : "null"}[v0]`);
  let v = "[v0]";
  for (const [k, overlay] of timeline.overlays.entries()) {
    const idx = inputs.length / 2;
    inputs.push("-i", overlay.path);
    const pre = `${overlay.position === "full" ? `scale=${W}:${H},` : ""}format=rgba${overlay.opacity < 1 ? `,colorchannelmixer=aa=${overlay.opacity}` : ""}`;
    const pos = { "top-left": `${safeArea.left}:${safeArea.top}`, "top-right": `W-w-${safeArea.right}:${safeArea.top}`, "bottom-left": `${safeArea.left}:H-h-${safeArea.bottom}`,
      "bottom-right": `W-w-${safeArea.right}:H-h-${safeArea.bottom}`, center: "(W-w)/2:(H-h)/2", full: "0:0" }[overlay.position];
    graph.push(`[${idx}:v]${pre}[ov${k}]`, `${v}[ov${k}]overlay=${pos}:enable='between(t,${overlay.fromSec},${overlay.toSec})'[v${k + 1}]`);
    v = `[v${k + 1}]`;
  }
  const mixIn = ["[0:a]"];
  if (timeline.narration) {
    const idx = inputs.length / 2;
    inputs.push("-i", timeline.narration.path);
    graph.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${timeline.narration.volumeDb}dB[nar]`);
    mixIn.push("[nar]");
  }
  const mix = (ins, out) => (ins.length === 1 ? `${ins[0]}anull${out}` : `${ins.join("")}amix=inputs=${ins.length}:duration=first:normalize=0${out}`);
  let audio = mixIn;
  if (timeline.music) {
    const m = timeline.music, idx = inputs.length / 2, fade = Math.min(m.fadeOutSec, D);
    inputs.push("-stream_loop", "-1", "-i", m.path);
    const music = `[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${D.toFixed(3)},asetpts=N/SR/TB,volume=${m.volumeDb}dB${fade > 0 ? `,afade=t=out:st=${(D - fade).toFixed(3)}:d=${fade}` : ""}`;
    if (m.duckDb < 0) {
      // shortcut: the ratio assumes speech 20 dB over the threshold; measure the key's loudness for an exact duck.
      const ratio = Math.min(20, Math.max(1, 20 / Math.max(0.5, 20 - Math.abs(m.duckDb)))).toFixed(2);
      graph.push(mix(mixIn, ",asplit[key][spk]"), `${music}[mus0]`, `[mus0][key]sidechaincompress=threshold=0.03:ratio=${ratio}:attack=50:release=600:level_sc=1[mus]`);
      audio = ["[spk]", "[mus]"];
    } else { graph.push(`${music}[mus]`); audio = [...mixIn, "[mus]"]; }
  }
  graph.push(mix(audio, ",loudnorm=I=-16:TP=-1.5:LRA=11[a]"));
  const out = join(ctx.workDir, `output-${formatId}.mp4`);
  await writeFile(join(tmp, "final.graph"), graph.join(";\n"));
  await ff([...inputs, "-filter_complex_script", join(tmp, "final.graph"), "-map", v, "-map", "[a]", ...H264, "-crf", "20", "-preset", "medium", "-b:a", "160k", "-t", D.toFixed(3), out]);
  // 8. thumbnail and the result
  step(0.95, "thumbnail");
  const thumbnailPath = join(ctx.workDir, `thumb-${formatId}.png`);
  await ff(["-ss", "0", "-t", "3", "-i", out, "-vf", "thumbnail=90", "-frames:v", "1", "-update", "1", thumbnailPath]);
  const info = await probeInfo(out);
  if (output.maxDurationSec !== null && info.durationSec > output.maxDurationSec + 0.5) fail(`${output.label}: the output is ${info.durationSec} s, longer than the format's ${output.maxDurationSec} s`);
  await rm(tmp, { recursive: true, force: true });
  return { formatId, path: out, width: info.width, height: info.height, durationSec: info.durationSec, sha256: await sha256File(out), thumbnailPath };
}

async function assembleOp(job, ctx) {
  const timeline = await validateTimeline(job.timeline, ctx);
  const outputs = validateOutputs(job.outputs);
  const words = job.wordsPath == null ? null : JSON.parse(await readFile(await ctx.allowedFile(job.wordsPath, "wordsPath", [".json"]), "utf8"));
  const analysis = job.analysisPath == null ? null : JSON.parse(await readFile(await ctx.allowedFile(job.analysisPath, "analysisPath", [".json"]), "utf8"));
  if (timeline.captions.style !== "none" && !words) fail("captions need wordsPath (run transcribe first)");
  const infos = [];
  for (const source of ctx.sources) infos.push(await probeInfo(source.path));
  for (const [i, clip] of timeline.clips.entries()) {
    if (!infos[clip.sourceIndex].hasVideo) fail(`clips[${i}]: the source has no video stream`);
    if (clip.outSec > infos[clip.sourceIndex].durationSec + 0.05) fail(`clips[${i}].outSec is past the end of the source (${infos[clip.sourceIndex].durationSec} s)`);
  }
  const groups = groupClips(timeline);
  const T = timeline.transition === "cut" ? 0 : timeline.transitionSec;
  const total = timeline.clips.reduce((sum, c) => sum + (c.outSec - c.inSec) / c.speed, 0) - T * (groups.length - 1);
  for (const output of outputs) if (output.maxDurationSec !== null && total > output.maxDurationSec + 0.01) fail(`${output.label}: the timeline is ${r3(total)} s, longer than the format's ${output.maxDurationSec} s`);
  const results = [];
  for (const [k, output] of outputs.entries()) results.push(await renderOutput(ctx, timeline, output, groups, infos, words, analysis, [5 + 90 * k / outputs.length, 5 + 90 * (k + 1) / outputs.length]));
  return { outputs: results };
}

async function ttsOp(job, ctx) {
  const engine = oneOf(job.engine ?? "kokoro", ["kokoro", "chatterbox", "murf", "cartesia", "fish", "livekit"], "engine");
  const text = str(job.text, 5000, "text"), voice = str(job.voice ?? "af_sarah", 40, "voice", /^[a-z0-9_-]+$/i), language = str(job.language ?? "en", 8, "language", LANG);
  const out = str(job.out ?? "narration.wav", 64, "out", /^[\w-]+\.wav$/);
  const path = join(ctx.workDir, out);
  if (engine === "murf") await murfSpeak(text, voice, language, path);
  else if (engine === "cartesia") await cartesiaSpeak(text, voice, language, path);
  else if (engine === "fish") await fishSpeak(text, voice, path);
  else if (engine === "livekit") await livekitSpeak(text, voice, language, path);
  else await worker(ctx, { op: "tts", engine, text, voice, language, out: path, modelDir: engine === "kokoro" ? ctx.tool("kokoro") : join(ctx.toolsDir, "hf-cache") }, 5, 95);
  return { path, durationSec: (await probeInfo(path)).durationSec };
}

/** Murf's Gen2 voice per base language, used when the job names no Murf voice (the pane default af_heart is Kokoro's). ASCII ids only. */
export const MURF_VOICES = Object.freeze({ bn: "bn-IN-anwesha", de: "de-DE-josephine", el: "el-GR-stavros", en: "en-US-natalie", es: "es-ES-carla", fr: "fr-FR-justine",
  hi: "hi-IN-shweta", hr: "hr-HR-marija", it: "it-IT-greta", ja: "ja-JP-kimi", ko: "ko-KR-jangmi", nl: "nl-NL-famke", pl: "pl-PL-kasia", pt: "pt-BR-isadora",
  sk: "sk-SK-nina", ta: "ta-IN-iniya", zh: "zh-CN-wei" });
/** A voice grant's key, read as apps/api/src/voice-grants.ts reads it: the file the env names (only that one), else /opt/spaceapp/secrets
 * (the Vault installs it there, readable by the space group), else the agent user's ~/.config/space (where the grant signups saved it). */
async function grantKey(fileEnv, secret, home, label, code = "TTS_ENGINE_MISSING") {
  const paths = process.env[fileEnv] ? [process.env[fileEnv]] : [`/opt/spaceapp/secrets/${secret}`, `${process.env.SPACE_AGENT_HOME || "/var/lib/spaceapp-user"}/.config/space/${home}`];
  for (const path of paths) { const text = (await readFile(path, "utf8").catch(() => "")).trim(); if (text) return text; }
  return fail(`${code}: no ${label} key at ${paths.join(" or ")} (install it from the Vault)`);
}
const livekitKeys = async (code) => {
  const text = await grantKey("SPACE_LIVEKIT_ENV_FILE", "space-livekit.env", "livekit.key", "LiveKit", code);
  const values = Object.fromEntries([...text.matchAll(/(LIVEKIT_[A-Z_]+)=["']?([^\s"']+)/g)].map((match) => [match[1], match[2]]));
  return values.LIVEKIT_API_KEY && values.LIVEKIT_API_SECRET ? values : fail(`${code}: the LiveKit key file has no LIVEKIT_API_KEY and LIVEKIT_API_SECRET`);
};
/** LiveKit Inference token (HS256, issuer = API key, `inference.perform`), as liveKitInferenceToken in apps/api/src/voice-grants.ts. */
function livekitToken(values, now = Math.floor(Date.now() / 1000)) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = `${part({ alg: "HS256", typ: "JWT" })}.${part({ iss: values.LIVEKIT_API_KEY, sub: "space-video", nbf: now - 5, exp: now + 3600, inference: { perform: true } })}`;
  return `${head}.${createHmac("sha256", values.LIVEKIT_API_SECRET).update(head).digest("base64url")}`;
}
const LIVEKIT_INFERENCE_WS = "wss://agent-gateway.livekit.cloud/v1";
const CARTESIA_VERSION = "2025-04-16";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Cartesia Sonic 3's default voice (the Live pane's first Sonic voice); a job's voice is used when it is a Cartesia voice id. */
const SONIC_VOICE = "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc";
/** 16-bit mono PCM in a 44-byte RIFF header. */
export function wavOf(pcm, rate) {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVEfmt ", 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}
const jsonOf = (data) => { try { return JSON.parse(String(data)); } catch { return {}; } };
/** A cloud answer that is not OK fails with its HTTP status and at most 300 characters of its text; never a key. */
async function okOrFail(response, label) {
  if (!response.ok) fail(`${label} answered HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
  return response;
}

/** Cartesia Sonic 3 (cloud, the Cartesia grant): one POST, WAV back. */
async function cartesiaSpeak(text, voice, language, path) {
  const key = await grantKey("SPACE_CARTESIA_KEY_FILE", "space-cartesia.key", "cartesia.key", "Cartesia");
  progress(5, "Cartesia Sonic 3");
  // shortcut: built from Cartesia's published API without a key to test against; check it once the Cartesia key is installed.
  const response = await okOrFail(await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST", signal: AbortSignal.timeout(TIMEOUTS_MS.tts - 5000), headers: { ...UA, "content-type": "application/json", "X-API-Key": key, "Cartesia-Version": CARTESIA_VERSION },
    body: JSON.stringify({ model_id: "sonic-3", transcript: text, voice: { mode: "id", id: UUID.test(voice) ? voice : SONIC_VOICE }, language: language.split("-")[0],
      output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: 24000 } })
  }), "Cartesia");
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}
/** Fish Audio S1 (cloud): one POST, WAV back; a 32-hex voice is a Fish voice model (reference_id), else Fish's default voice. */
async function fishSpeak(text, voice, path) {
  const key = await grantKey("SPACE_FISH_AUDIO_KEY_FILE", "space-fish-audio.key", "fish.key", "Fish Audio");
  progress(5, "Fish Audio S1");
  // shortcut: built from Fish's published API without a key to test against; check it once the Fish Audio key is installed.
  const response = await okOrFail(await fetch("https://api.fish.audio/v1/tts", {
    method: "POST", signal: AbortSignal.timeout(TIMEOUTS_MS.tts - 5000), headers: { ...UA, "content-type": "application/json", authorization: `Bearer ${key}`, model: "s1" },
    body: JSON.stringify({ text, format: "wav", sample_rate: 24000, ...(/^[0-9a-f]{32}$/.test(voice) ? { reference_id: voice } : {}) })
  }), "Fish Audio");
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}
/** LiveKit Inference TTS (Cartesia Sonic 3 through the LiveKit grant): 24 kHz PCM frames over the gateway's WebSocket, saved as WAV. */
async function livekitSpeak(text, voice, language, path) {
  const values = await livekitKeys("TTS_ENGINE_MISSING");
  progress(5, "LiveKit Inference (Sonic 3)");
  const { WebSocket } = await import("ws");
  const model = "cartesia/sonic-3", config = { model, voice: UUID.test(voice) ? voice : SONIC_VOICE, language: language.split("-")[0] };
  const frames = [];
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${LIVEKIT_INFERENCE_WS}/tts?model=${encodeURIComponent(model)}`, { headers: { ...UA, Authorization: `Bearer ${livekitToken(values)}` }, handshakeTimeout: 15_000 });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("LiveKit Inference did not finish speaking in time")); }, TIMEOUTS_MS.tts - 5000);
    const end = (error) => { clearTimeout(timer); if (socket.readyState < 2) socket.close(); if (error) reject(error); else resolve(); };
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "session.create", sample_rate: "24000", encoding: "pcm_s16le", ...config, extra: {} }));
      socket.send(JSON.stringify({ type: "input_transcript", transcript: `${text} `, generation_config: config, extra: {} }));
      socket.send(JSON.stringify({ type: "session.flush" }));
    });
    socket.on("message", (data) => {
      const message = jsonOf(data);
      if (message.type === "output_audio" && typeof message.audio === "string") frames.push(Buffer.from(message.audio, "base64"));
      else if (message.type === "done") end();
      else if (message.type === "error") end(new Error("LiveKit Inference refused the speech request"));
    });
    // ws says "Unexpected server response: 401"; only that status leaves, never the token.
    socket.on("error", (error) => end(new Error(`LiveKit Inference: ${/Unexpected server response: \d{3}/.exec(error.message)?.[0] ?? "unreachable"}`)));
    socket.on("close", () => end(frames.length ? undefined : new Error("LiveKit Inference closed without audio")));
  });
  await writeFile(path, wavOf(Buffer.concat(frames), 24000));
}

/** Words with times in seconds → faster-whisper's segments: a new one after a sentence end (. ? ! or the Greek ;) or a pause over 1 s. */
export function segmentsOf(words) {
  const segments = [];
  for (const word of words) {
    const last = segments.at(-1);
    if (!last || /[.?!;]$/.test(last.words.at(-1).word) || word.start - last.end > 1) segments.push({ start: word.start, end: word.end, words: [] });
    segments.at(-1).words.push(word);
    segments.at(-1).end = word.end;
  }
  return segments.map((segment) => ({ ...segment, text: segment.words.map((word) => word.word).join(" ") }));
}
/** A cloud transcription grant (AssemblyAI, Cartesia Ink, LiveKit Inference's Deepgram Nova 3) in faster-whisper's reply shape. */
async function cloudTranscribe(engine, ctx, src, language) {
  const code = "STT_ENGINE_MISSING";
  const keyOf = { assemblyai: () => grantKey("SPACE_ASSEMBLYAI_KEY_FILE", "space-assemblyai.key", "assemblyai.key", "AssemblyAI", code),
    cartesia: () => grantKey("SPACE_CARTESIA_KEY_FILE", "space-cartesia.key", "cartesia.key", "Cartesia", code), livekit: () => livekitKeys(code) };
  const key = await keyOf[engine]();
  const audioPath = join(ctx.workDir, engine === "livekit" ? "speech.pcm" : "speech.wav");
  progress(5, "Extracting the speech");
  await ffmpeg(["-i", src, "-map", "0:a:0", "-ac", "1", "-ar", "16000", ...(engine === "livekit" ? ["-f", "s16le"] : ["-c:a", "pcm_s16le"]), audioPath]);
  const audio = await readFile(audioPath);
  const durationSec = (engine === "livekit" ? audio.length : audio.length - 44) / 32000;
  const signal = AbortSignal.timeout(TIMEOUTS_MS.transcribe - 10_000);
  let words, detected = language;
  if (engine === "assemblyai") {
    const headers = { ...UA, authorization: key };
    progress(15, "Uploading to AssemblyAI");
    const upload = await (await okOrFail(await fetch("https://api.assemblyai.com/v2/upload", { method: "POST", signal, headers, body: audio }), "AssemblyAI")).json();
    const created = await (await okOrFail(await fetch("https://api.assemblyai.com/v2/transcript", { method: "POST", signal, headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ audio_url: upload.upload_url, speech_models: ["universal-3-5-pro", "universal-2"], ...(language ? { language_code: language.split("-")[0] } : { language_detection: true }) }) }), "AssemblyAI")).json();
    let answer = created;
    // AssemblyAI transcribes in the background: ask every 3 s until it is done (the job's own timeout bounds the wait).
    while (answer.status !== "completed" && answer.status !== "error") {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      answer = await (await okOrFail(await fetch(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(created.id)}`, { signal, headers }), "AssemblyAI")).json();
      progress(30, `AssemblyAI: ${answer.status}`);
    }
    if (answer.status === "error") fail(`AssemblyAI could not transcribe: ${String(answer.error ?? "").slice(0, 300)}`);
    words = (answer.words ?? []).map((word) => ({ word: word.text, start: word.start / 1000, end: word.end / 1000 }));
    detected = answer.language_code?.split("_")[0] ?? language; // "en_us" → faster-whisper's "en"
  } else if (engine === "cartesia") {
    progress(15, "Cartesia Ink");
    // shortcut: built from Cartesia's published batch STT API without a key to test against; check it once the Cartesia key is installed.
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/wav" }), "speech.wav");
    form.append("model", "ink-whisper");
    if (language) form.append("language", language.split("-")[0]);
    form.append("timestamp_granularities[]", "word");
    const answer = await (await okOrFail(await fetch("https://api.cartesia.ai/stt", { method: "POST", signal, headers: { ...UA, "X-API-Key": key, "Cartesia-Version": CARTESIA_VERSION }, body: form }), "Cartesia")).json();
    words = answer.words ?? [];
    detected = answer.language ?? language;
  } else words = await livekitTranscribe(key, audio, language, signal);
  return { language: detected ?? "und", durationSec, segments: segmentsOf(words.filter((word) => String(word.word ?? "").trim())) };
}
/** LiveKit Inference STT (Deepgram Nova 3): streams the 16 kHz PCM faster than real time and keeps every final transcript's words. */
async function livekitTranscribe(values, pcm, language, signal) {
  const { WebSocket } = await import("ws");
  const model = "deepgram/nova-3", words = [];
  // The gateway does not close after session.close; the last final transcript is followed by quiet. 4 s of it ends the session.
  const QUIET_MS = 4000, CHUNK = 32_000;
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${LIVEKIT_INFERENCE_WS}/stt?model=${encodeURIComponent(model)}`, { headers: { ...UA, Authorization: `Bearer ${livekitToken(values)}` }, handshakeTimeout: 15_000 });
    let quiet = null, sent = false;
    const end = (error) => { clearTimeout(quiet); signal.removeEventListener("abort", aborted); if (socket.readyState < 2) socket.close(); if (error) reject(error); else resolve(); };
    const aborted = () => end(new Error("LiveKit Inference did not finish transcribing in time"));
    signal.addEventListener("abort", aborted);
    const idle = () => { if (sent) { clearTimeout(quiet); quiet = setTimeout(() => end(), QUIET_MS); } };
    socket.on("open", async () => {
      socket.send(JSON.stringify({ type: "session.create", model, settings: { sample_rate: "16000", encoding: "pcm_s16le", ...(language ? { language: language.split("-")[0] } : {}), extra: {} } }));
      // Two seconds of silence after the speech let the last turn end.
      const all = Buffer.concat([pcm, Buffer.alloc(64_000)]);
      for (let at = 0; at < all.length && socket.readyState === 1; at += CHUNK) {
        socket.send(JSON.stringify({ type: "input_audio", audio: all.subarray(at, at + CHUNK).toString("base64") }));
        while (socket.bufferedAmount > 1024 * 1024 && socket.readyState === 1) await new Promise((resolve) => setTimeout(resolve, 20));
        if (at % (CHUNK * 50) === 0) progress(10 + Math.round(80 * at / all.length), "LiveKit Inference");
      }
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: "session.close" }));
      sent = true; idle();
    });
    socket.on("message", (data) => {
      const message = jsonOf(data);
      if (message.type === "final_transcript") words.push(...(message.words ?? []).map((word) => ({ word: word.word, start: word.start, end: word.end })));
      else if (message.type === "error") return end(new Error("LiveKit Inference refused the transcription"));
      idle();
    });
    socket.on("error", (error) => end(new Error(`LiveKit Inference: ${/Unexpected server response: \d{3}/.exec(error.message)?.[0] ?? "unreachable"}`)));
    socket.on("close", () => end(sent ? undefined : new Error("LiveKit Inference closed the transcription early")));
  });
  return words;
}
/** Murf text to speech (cloud, paid per character from the Murf API credits): WAV comes back base64, so Murf keeps no copy of the audio. */
async function murfSpeak(text, voice, language, path) {
  const base = language.split("-")[0].toLowerCase();
  const fallback = MURF_VOICES[base] ?? fail(`language ${language} is not available in murf (one of ${Object.keys(MURF_VOICES).join(", ")})`);
  const voiceId = /^[a-z]{2}-[A-Z]{2,5}-[a-z-]+$/.test(voice) ? voice : fallback;
  const key = await grantKey("SPACE_MURF_KEY_FILE", "space-murf.key", "murf.key", "Murf API");
  progress(5, `Murf ${voiceId}`);
  const response = await fetch("https://api.murf.ai/v1/speech/generate", {
    method: "POST", signal: AbortSignal.timeout(TIMEOUTS_MS.tts - 5000), headers: { ...UA, "content-type": "application/json", "api-key": key },
    // A voice of another language speaks this one through `locale` (Gen2 voices are multilingual).
    body: JSON.stringify({ text, voiceId, modelVersion: "GEN2", format: "WAV", encodeAsBase64: true, ...(voiceId.split("-")[0] === base ? {} : { locale: fallback.split("-").slice(0, 2).join("-") }) })
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok || typeof answer.encodedAudio !== "string" || !answer.encodedAudio) fail(`Murf answered HTTP ${response.status}: ${String(answer.errorMessage ?? answer.message ?? "no audio").slice(0, 300)}`);
  await writeFile(path, Buffer.from(answer.encodedAudio, "base64"));
}

/** Network seam: SPACE_VIDEO_ENGINE_FETCH_MOCK names a JSON file {json, file} answering every fetch (tests only). */
async function mock() {
  return process.env.SPACE_VIDEO_ENGINE_FETCH_MOCK ? JSON.parse(await readFile(process.env.SPACE_VIDEO_ENGINE_FETCH_MOCK, "utf8")) : null;
}
const UA = { "user-agent": "SpaceApp video engine (https://spaceapp.dev)" };

async function musicSearchOp(job) {
  const query = str(job.query, 100, "query").replace(/[^\w\s-]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!query.length) fail("query must contain letters or numbers");
  const limit = int(job.limit ?? 20, 1, 50, "limit");
  const results = [], seen = new Set(); let error = null;
  const mocked = await mock();
  for (const param of [`tags=${encodeURIComponent(query.join(","))}`, `search=${encodeURIComponent(query.join(" "))}`]) {
    if (results.length >= limit) break;
    let rows;
    try {
      rows = mocked ? mocked.json : await (await fetch(`https://ccmixter.org/api/query?f=json&lic=by&limit=${limit}&${param}`, { signal: AbortSignal.timeout(TIMEOUTS_MS.music_search - 1000), headers: UA })).json();
    } catch (cause) { error = `ccMixter: ${cause instanceof Error ? cause.message : String(cause)}`; continue; }
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = String(row.upload_id ?? ""), file = (row.files ?? []).find((f) => /^https:\/\/ccmixter\.org\/.*\.mp3$/i.test(f?.download_url ?? ""));
      if (!id || seen.has(id) || !file || !/\/licenses\/by\//.test(String(row.license_url ?? "")) || results.length >= limit) continue;
      seen.add(id);
      const title = String(row.upload_name ?? "").slice(0, 120), artist = String(row.user_real_name || row.user_name || "").slice(0, 80);
      results.push({ id, title, artist, url: file.download_url, pageUrl: /^https:\/\/ccmixter\.org\//.test(String(row.file_page_url ?? "")) ? row.file_page_url : null, license: "CC BY",
        attribution: `${title} by ${artist} (ccMixter, CC BY)` });
    }
  }
  return { results, error: results.length ? null : error };
}

async function musicFetchOp(job, ctx) {
  const url = httpsUrl(job.url, "url");
  const path = join(ctx.workDir, `music-${createHash("sha256").update(url).digest("hex").slice(0, 16)}.mp3`);
  const mocked = await mock();
  if (mocked) await writeFile(path, await readFile(mocked.file));
  else {
    // ccMixter answers 403 to a download without a referer (hotlink protection; 2026-10-22 every music_fetch failed).
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUTS_MS.music_fetch - 1000), headers: { ...UA, referer: `${new URL(url).origin}/` } });
    if (!response.ok || !response.body) fail(`the download answered HTTP ${response.status}`);
    if (Number(response.headers.get("content-length") ?? 0) > MAX_MUSIC_BYTES) fail("the file is larger than 50 MB");
    let bytes = 0;
    const file = createWriteStream(path);
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > MAX_MUSIC_BYTES) fail("the file is larger than 50 MB");
        if (!file.write(chunk)) await new Promise((resolve) => file.once("drain", resolve));
      }
      await new Promise((resolve, reject) => file.end((err) => (err ? reject(err) : resolve())));
    } catch (cause) { file.destroy(); await rm(path, { force: true }); throw cause; }
  }
  const info = await probeInfo(path).catch(() => null);
  if (!info?.hasAudio) { await rm(path, { force: true }); fail("the download is not an audio file"); }
  return { path, durationSec: info.durationSec };
}

export const OPS = {
  probe: { run: probeOp, keys: ["sourceIndex"] },
  fetch: { run: fetchOp, keys: ["url", "maxDurationSec", "maxHeight"] },
  captions: { run: captionsOp, keys: ["url"] },
  proxy: { run: proxyOp, keys: ["sourceIndex"] },
  transcribe: { run: transcribeOp, keys: ["sourceIndex", "language", "engine"] },
  analyze: { run: analyzeOp, keys: ["sourceIndex", "technique", "reframe", "silenceDb", "minSilenceSec", "sceneThreshold", "wordsPath"] },
  assemble: { run: assembleOp, keys: ["timeline", "outputs", "wordsPath", "analysisPath"] },
  tts: { run: ttsOp, keys: ["text", "engine", "voice", "language", "out"] },
  music_search: { run: musicSearchOp, keys: ["query", "limit"] },
  music_fetch: { run: musicFetchOp, keys: ["url"] }
};

/** Runs one validated job; the result is what the final {"result":...} line carries. */
export async function runJob(raw) {
  if (!isObject(raw)) fail("the job must be a JSON object");
  const op = OPS[raw.op];
  if (!op) fail(`op must be one of ${Object.keys(OPS).join(", ")}`);
  onlyKeys(raw, ["op", "workDir", "toolsDir", "sources", ...op.keys], "job");
  const ctx = await jobContext(raw);
  opName = raw.op;
  deadline = Date.now() + TIMEOUTS_MS[raw.op];
  await writeFile(join(ctx.workDir, MARKER), `${new Date().toISOString()}\n`);
  await sweepSiblings(ctx.workDir);
  const result = await op.run(raw, ctx);
  progress(100, "Done");
  return result;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    if (process.argv[2] !== "--stdin" || process.argv.length !== 3) throw new Error("Usage: space-video-engine.mjs --stdin < job.json");
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return runJob(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  })().then((result) => {
    process.stdout.write(`${JSON.stringify({ result })}\n`);
  }, (error) => {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exit(1);
  });
}
