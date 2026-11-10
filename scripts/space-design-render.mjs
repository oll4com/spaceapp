#!/usr/bin/env node
// Design pane template renderer (plan clipboard:URdc3U314lUH, P3), run by the API (apps/api/src/design/render.ts) with one
// JSON request on stdin:
//   {templateId, width, height, format png|jpeg|webp, quality?, params, imagePaths {background?, screenshot?, logo?}, brandKit?, safeArea?}
// Every value is validated here: template ids come from the allowlist, text params are length-capped and HTML-escaped,
// colours are hex, image files (paths the API resolved from the owner's artifacts) are checked by type and size and
// inlined as data: URLs. Chrome renders with no script and no network, so a param can never load or run anything.
// Prints {templateId, width, height, format, mimeType, bytes, sha256, fit, overflow, base64}: fit < 1 when the text was shrunk to
// fit the safe box, overflow true when even the smallest step did not fit.
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHtml, startChrome } from "./lib/space-chrome-render.mjs";
import { frameHtml } from "./space-media-capture.mjs";

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), "design-templates");
/** Inter 4.1 (SIL OFL 1.1, fonts/Inter-LICENSE.txt): web/InterVariable.woff2 of rsms/inter's release Inter-4.1.zip (zip sha256 9883fdd4...b11e). */
const INTER_SHA256 = "693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3";
export const DESIGN_TEMPLATES = ["photo-headline", "gradient-headline", "quote-card", "release-announcement", "screenshot-frame", "wide-banner", "bold-thumbnail", "logo"];
export const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** Text params and their length caps. */
const TEXT_PARAMS = { headline: 140, subline: 280, cta: 40, quote: 400, author: 80, badge: 40, version: 24, url: 80 };
const COLOR_KEYS = ["background", "surface", "primary", "accent", "text"];
const IMAGE_SLOTS = ["background", "screenshot", "logo"];
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };
/** The built-in SpaceApp kit (SPACEAPP_BRAND_KIT in packages/contracts/src/design.ts), used for anything a brand kit leaves out. */
const DEFAULT_BRAND = { colors: { background: "#0a0e24", surface: "#121a3a", primary: "#67d9f5", accent: "#93e9fa", text: "#ffffff" }, fonts: { heading: "Inter", body: "Inter" } };

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function fail(message) { throw new Error(`Invalid render request: ${message}.`); }
function intIn(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} must be a whole number from ${min} to ${max}`);
  return value;
}
function onlyKeys(value, allowed, label) {
  if (value === undefined) return {};
  if (!isObject(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}.${key} is not allowed`);
  return value;
}
function color(value, label) {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) fail(`${label} must be a #rrggbb colour`);
  return value.toLowerCase();
}
function fontName(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9 -]{1,60}$/.test(value)) fail(`${label} must be a font family name`);
  return value;
}

/** Checks a whole request; throws on the first problem. */
export function validateRequest(raw) {
  const request = onlyKeys(raw, ["templateId", "width", "height", "format", "quality", "params", "imagePaths", "brandKit", "safeArea"], "request");
  if (!DESIGN_TEMPLATES.includes(request.templateId)) fail(`templateId must be one of ${DESIGN_TEMPLATES.join(", ")}`);
  const width = intIn(request.width, 64, 4096, "width");
  const height = intIn(request.height, 64, 4096, "height");
  const format = request.format ?? "png";
  if (!["png", "jpeg", "webp"].includes(format)) fail("format must be png, jpeg or webp");
  const quality = request.quality === undefined ? undefined : intIn(request.quality, 1, 100, "quality");
  const rawParams = onlyKeys(request.params, [...Object.keys(TEXT_PARAMS), "colors", "focalX", "focalY", "overlay"], "params");
  const params = {};
  for (const [key, max] of Object.entries(TEXT_PARAMS)) {
    const value = rawParams[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > max) fail(`params.${key} must be text of at most ${max} characters`);
    params[key] = value.trim();
  }
  const colors = {};
  for (const [key, value] of Object.entries(onlyKeys(rawParams.colors, COLOR_KEYS, "params.colors"))) colors[key] = color(value, `params.colors.${key}`);
  params.colors = colors;
  params.focalX = rawParams.focalX === undefined ? 50 : intIn(rawParams.focalX, 0, 100, "params.focalX");
  params.focalY = rawParams.focalY === undefined ? 50 : intIn(rawParams.focalY, 0, 100, "params.focalY");
  params.overlay = rawParams.overlay === undefined ? 45 : intIn(rawParams.overlay, 0, 90, "params.overlay");
  const imagePaths = {};
  for (const [slot, path] of Object.entries(onlyKeys(request.imagePaths, IMAGE_SLOTS, "imagePaths"))) {
    if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || !IMAGE_TYPES[extname(path).toLowerCase()]) fail(`imagePaths.${slot} must be an absolute image file path`);
    imagePaths[slot] = path;
  }
  const kit = onlyKeys(request.brandKit, ["name", "colors", "fonts"], "brandKit");
  const brand = { colors: { ...DEFAULT_BRAND.colors }, fonts: { ...DEFAULT_BRAND.fonts } };
  for (const [key, value] of Object.entries(onlyKeys(kit.colors, COLOR_KEYS, "brandKit.colors"))) brand.colors[key] = color(value, `brandKit.colors.${key}`);
  for (const [key, value] of Object.entries(onlyKeys(kit.fonts, ["heading", "body"], "brandKit.fonts"))) brand.fonts[key] = fontName(value, `brandKit.fonts.${key}`);
  const safe = onlyKeys(request.safeArea, ["top", "right", "bottom", "left"], "safeArea");
  const safeArea = Object.fromEntries(["top", "right", "bottom", "left"].map((side) => [side, safe[side] === undefined ? 0
    : intIn(safe[side], 0, Math.floor((side === "top" || side === "bottom" ? height : width) / 2) - 1, `safeArea.${side}`)]));
  return { templateId: request.templateId, width, height, format, quality, params, imagePaths, brand, safeArea };
}

/** An image file as a data: URL, after its type (by its first bytes) and size are checked. */
export async function imageDataUrl(path) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.size === 0 || info.size > MAX_IMAGE_BYTES) fail(`${path} is not a readable image of at most 25 MB`);
  const bytes = await readFile(path);
  const type = IMAGE_TYPES[extname(path).toLowerCase()];
  const head = bytes.subarray(0, 12);
  const matches = type === "image/png" ? head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    : type === "image/jpeg" ? head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      : type === "image/webp" ? head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP"
        : type === "image/gif" ? head.toString("latin1", 0, 4) === "GIF8"
          : /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(bytes.subarray(0, 4096).toString("utf8"));
  if (!matches) fail(`${path} is not a ${type} file`);
  return `data:${type};base64,${bytes.toString("base64")}`;
}

/** The render Chrome has no Inter and no network (Design pane 2026-10-24: headlines came out in DejaVu Sans), so every document carries it inline. */
async function interFontFace() {
  const font = await readFile(join(templatesDir, "fonts", "InterVariable.woff2"));
  if (createHash("sha256").update(font).digest("hex") !== INTER_SHA256) throw new Error("The bundled Inter font does not match its pinned SHA-256.");
  return `<style>@font-face{font-family:"Inter";src:url(data:font/woff2;base64,${font.toString("base64")}) format("woff2");font-weight:100 900;font-style:normal;font-display:block}</style>`;
}

/** The document for a validated request: the template with escaped text, the brand's colours and fonts, inlined images, and Inter. */
export async function buildHtml(input) {
  const fontFace = await interFontFace();
  return (await templateHtml(input)).replace('<meta charset="utf-8">', (meta) => `${meta}${fontFace}`);
}

async function templateHtml(input) {
  const images = {};
  for (const [slot, path] of Object.entries(input.imagePaths)) images[slot] = await imageDataUrl(path);
  const { width, height, params, brand, safeArea } = input;
  const colors = { ...brand.colors, ...params.colors };
  if (input.templateId === "screenshot-frame") {
    if (!images.screenshot) fail("screenshot-frame needs imagePaths.screenshot");
    return frameHtml({ size: [width, height], imageDataUrl: images.screenshot, headline: params.headline ?? "", subline: params.subline ?? "", colors });
  }
  const headline = params.headline ?? "";
  // CSS cannot fit text to a box: longer headlines start smaller.
  const headlineScale = headline.length <= 20 ? 1 : headline.length <= 40 ? 0.82 : headline.length <= 70 ? 0.66 : 0.52;
  // Sizes follow the safe box (a banner's visible middle), scaled down by --fit when the text still does not fit it.
  const unit = Math.min(width - safeArea.left - safeArea.right, height - safeArea.top - safeArea.bottom) / 100;
  const style = `<style>:root{--w:${width}px;--h:${height}px;--fit:1;--u:calc(${unit}px * var(--fit));--bg:${colors.background};--primary:${colors.primary};`
    + `--accent:${colors.accent};--surface:${colors.surface};--text:${colors.text};--font-heading:"${brand.fonts.heading}";--font-body:"${brand.fonts.body}";--headline-scale:${headlineScale};`
    + `--focal:${params.focalX}% ${params.focalY}%;--overlay:${params.overlay / 100};--safe-top:${safeArea.top}px;--safe-right:${safeArea.right}px;`
    + `--safe-bottom:${safeArea.bottom}px;--safe-left:${safeArea.left}px;${images.background ? `--bg-image:url("${images.background}");` : ""}}</style>`;
  const base = await readFile(join(templatesDir, "base.css"), "utf8");
  const template = await readFile(join(templatesDir, `${input.templateId}.html`), "utf8");
  const values = { ...Object.fromEntries(Object.keys(TEXT_PARAMS).map((key) => [key, escapeHtml(params[key] ?? "")])),
    logo: images.logo ? `<img class="logo" src="${images.logo}" alt="">` : "", screenshot: images.screenshot ? `<img class="screenshot" src="${images.screenshot}" alt="">` : "",
    "has-background": images.background ? "has-background" : "" };
  const body = template.replace(/\{\{([a-z-]+)\}\}/g, (_match, key) => values[key] ?? "");
  return `<!doctype html><html><head><meta charset="utf-8">${style}<style>${base}</style></head>${body}</html>`;
}

/** Renders one validated request in a fresh Chrome profile, removed afterwards. */
export async function render(input) {
  const html = await buildHtml(input);
  const profileDir = await mkdtemp(join(tmpdir(), "design-render-chrome-"));
  let chrome = null;
  try {
    chrome = await startChrome(profileDir);
    const { image, fit, overflow } = await renderHtml(chrome, { html, width: input.width, height: input.height, format: input.format, quality: input.quality, isolated: true,
      fitWithin: input.templateId === "screenshot-frame" ? null : ".safe" });
    if (image.length > MAX_OUTPUT_BYTES) throw new Error("The rendered image is larger than 25 MB.");
    return { templateId: input.templateId, width: input.width, height: input.height, format: input.format, mimeType: `image/${input.format}`,
      bytes: image.length, sha256: createHash("sha256").update(image).digest("hex"), fit, overflow, base64: image.toString("base64") };
  } finally {
    await chrome?.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    if (process.argv[2] !== "--stdin" || process.argv.length !== 3) throw new Error("Usage: space-design-render.mjs --stdin");
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return render(validateRequest(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
  })().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
