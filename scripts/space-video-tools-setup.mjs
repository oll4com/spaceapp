#!/usr/bin/env node
// Installs the Video pane's tools once, outside the repository, the way scripts/space-local-embeddings-setup.mjs does:
// the model files and the auto-editor binary pinned by URL, SHA-256 and size in scripts/video-tools/manifest.json under
// <toolsDir>/<name>/<version>/, and a Python environment at <toolsDir>/venv (the host's python3) with the wheels pinned in
// scripts/video-tools/requirements.txt (--with-chatterbox: requirements-chatterbox.txt instead). No root; rerunning
// fetches only what is missing or wrong. toolsDir is /opt/spaceapp/var/models/video or SPACE_VIDEO_TOOLS_DIR.
//   node scripts/space-video-tools-setup.mjs --status                      JSON: what is installed and what is missing
//   node scripts/space-video-tools-setup.mjs --install [--with-chatterbox]
//   node scripts/space-video-tools-setup.mjs --smoke                       kokoro says "hello", faster-whisper transcribes it
import { childProcessEnv } from "../packages/runtime/dist/child-process-env.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const toolsRoot = join(scriptsDir, "video-tools");
export const DEFAULT_TOOLS_DIR = "/opt/spaceapp/var/models/video";
export const MANIFEST = JSON.parse(readFileSync(join(toolsRoot, "manifest.json"), "utf8"));
export const PACKAGES = ["faster-whisper", "ctranslate2", "scenedetect", "opencv-python-headless", "kokoro-onnx", "soundfile", "onnxruntime"];

const sha256 = (path) => new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
});
const run = (command, args) => {
  if (spawnSync(command, args, { env: childProcessEnv(), stdio: "inherit" }).status !== 0) throw new Error(`${command} ${args.join(" ")} failed.`);
};
export const filePath = (dir, name, file) => join(dir, name, MANIFEST.tools[name].version, file.path);

/** Installed package versions in the venv (null when absent), read by one Python call. */
function packageVersions(python, names) {
  const code = "import importlib.metadata as m, json, sys\nout = {}\nfor n in sys.argv[1:]:\n    try: out[n] = m.version(n)\n    except m.PackageNotFoundError: out[n] = None\nprint(json.dumps(out))";
  const result = spawnSync(python, ["-I", "-c", code, ...names], { env: childProcessEnv(), encoding: "utf8" });
  if (result.status !== 0) return Object.fromEntries(names.map((name) => [name, null]));
  return JSON.parse(result.stdout);
}

export async function status(dir) {
  const python = join(dir, "venv/bin/python");
  const venv = existsSync(python);
  const packages = venv ? packageVersions(python, [...PACKAGES, "chatterbox-tts"]) : Object.fromEntries([...PACKAGES, "chatterbox-tts"].map((name) => [name, null]));
  const chatterbox = Boolean(packages["chatterbox-tts"]);
  delete packages["chatterbox-tts"];
  const models = {};
  for (const [name, spec] of Object.entries(MANIFEST.tools)) {
    let present = true;
    for (const file of spec.files) present &&= (await stat(filePath(dir, name, file)).catch(() => null))?.size === file.size;
    models[name] = { present, path: join(dir, name, spec.version) };
  }
  const autoEditor = models["auto-editor"].present;
  const missing = [...(venv ? [] : ["venv"]), ...PACKAGES.filter((name) => !packages[name]), ...Object.keys(models).filter((name) => !models[name].present)];
  return { ok: missing.length === 0, toolsDir: dir, python: venv ? python : null, venv, packages, models, autoEditor, chatterbox, missing };
}

export async function install(dir, { withChatterbox = false } = {}) {
  for (const [name, spec] of Object.entries(MANIFEST.tools)) {
    for (const file of spec.files) {
      const target = filePath(dir, name, file);
      if (existsSync(target) && await sha256(target) === file.sha256) { console.log(`ok ${name} ${file.path}`); continue; }
      await mkdir(dirname(target), { recursive: true });
      const response = await fetch(file.url, { redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`${name} ${file.path}: HTTP ${response.status}.`);
      const partial = `${target}.partial`;
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      const actual = await sha256(partial), size = (await stat(partial)).size;
      if (actual !== file.sha256 || size !== file.size) {
        await rm(partial);
        throw new Error(`${name} ${file.path}: SHA-256 ${actual} (${size} bytes) is not the pinned ${file.sha256} (${file.size} bytes).`);
      }
      await rename(partial, target);
      if (file.mode) await chmod(target, file.mode);
      console.log(`downloaded ${name} ${file.path}`);
    }
  }
  const python = join(dir, "venv/bin/python");
  if (!existsSync(python)) run("python3", ["-m", "venv", join(dir, "venv")]);
  run(join(dir, "venv/bin/pip"), ["install", "--quiet", "--disable-pip-version-check", "--require-hashes", "--no-deps", "--only-binary", ":all:",
    "-r", join(toolsRoot, withChatterbox ? "requirements-chatterbox.txt" : "requirements.txt")]);
  console.log(JSON.stringify(await status(dir)));
}

/** kokoro says "hello" through the engine, faster-whisper transcribes it; prints the text. */
export async function smoke(dir) {
  const { runJob } = await import("./space-video-engine.mjs");
  const workDir = join(dir, "smoke");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const spoken = await runJob({ op: "tts", workDir, toolsDir: dir, text: "Hello from Space.", engine: "kokoro", voice: "af_sarah", language: "en", out: "hello.wav" });
  const heard = await runJob({ op: "transcribe", workDir, toolsDir: dir, sources: [{ path: spoken.path }], sourceIndex: 0, language: "en" });
  const text = (await readFile(heard.transcriptPath, "utf8")).trim();
  console.log(`kokoro spoke ${spoken.durationSec} s; faster-whisper heard: ${text}`);
  if (!/hello/i.test(text)) throw new Error("The smoke check did not hear \"hello\".");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = new Set(process.argv.slice(2));
  const dir = process.env.SPACE_VIDEO_TOOLS_DIR || DEFAULT_TOOLS_DIR;
  (async () => {
    if (args.has("--status")) console.log(JSON.stringify(await status(dir), null, 2));
    else if (args.has("--install")) await install(dir, { withChatterbox: args.has("--with-chatterbox") });
    else if (args.has("--smoke")) await smoke(dir);
    else throw new Error("Usage: space-video-tools-setup.mjs --status | --install [--with-chatterbox] | --smoke");
  })().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
