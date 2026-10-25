import { canvasFrame, clamp, type Rect, type SnipFrame } from "./snip-image.js";

/**
 * Permission-free capture of SpaceApp's own page: the live DOM is cloned, the app's
 * stylesheets are embedded, and the result is rasterised through an SVG foreignObject.
 * Content a document cannot redraw (other origins' frames, video, WebGL, protected
 * canvases or images) raises SnipDomUnsupportedError so the caller can fall back to
 * screen sharing for that snip only.
 */
export class SnipDomUnsupportedError extends Error {
  constructor(readonly reason: string) {
    super(`This area contains ${reason}, which needs screen sharing.`);
    this.name = "SnipDomUnsupportedError";
  }
}

export interface DomCaptureOptions {
  /** Area to capture, in viewport CSS pixels. */
  region: Rect;
  signal?: AbortSignal;
  /** Output pixels per CSS pixel; defaults to devicePixelRatio, matching a screen capture. */
  scale?: number;
  exclude?: (element: Element) => boolean;
}

const XHTML = "http://www.w3.org/1999/xhtml";
const EMPTY_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
// Characters XML 1.0 forbids; one stray control character would otherwise break the whole image.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const SKIPPED_TAGS = new Set(["SCRIPT", "NOSCRIPT", "TEMPLATE", "LINK", "STYLE", "META", "TITLE", "BASE"]);
const FRAME_TAGS = new Set(["IFRAME", "EMBED", "OBJECT", "PORTAL", "FRAME"]);
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const KEEP_CHILDREN_TAGS = new Set(["SELECT", "VIDEO", "AUDIO", "OBJECT", "PICTURE", "TABLE", "TBODY", "THEAD", "TR"]);
const PRUNABLE_DISPLAY = /^(block|flex|grid|inline-block|inline-flex|inline-grid|flow-root|list-item)$/;

/** A top-level rule plus the class names it needs; null needs means "always keep". */
type CompiledRule = { text: string; needs: string[][] | null; children?: CompiledRule[]; header?: string };
type SheetInfo = { length: number; rules: CompiledRule[]; media: string | null; urls: { selector: string; url: string }[]; hasArgs: string[] };
const sheetCache = new WeakMap<CSSStyleSheet, SheetInfo>();
const validSelectors = new Map<string, boolean>();
const resourceCache = new Map<string, Promise<string>>();
const imageCache = new Map<string, string>();

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Capture cancelled", "AbortError");
}
function cache<T>(map: Map<string, T>, key: string, value: T, limit = 64): T {
  if (map.size >= limit) map.delete(map.keys().next().value!);
  map.set(key, value);
  return value;
}
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read a resource."));
    reader.readAsDataURL(blob);
  });
}
function fetchAsDataUrl(url: string): Promise<string> {
  const pending = resourceCache.get(url);
  if (pending) return pending;
  const request = fetch(url, { credentials: "same-origin" }).then(response => {
    if (!response.ok) throw new Error(`Resource ${response.status}`);
    return response.blob();
  }).then(async blob => {
    // A snapshot shows one frame: a large animated GIF becomes a far smaller static PNG.
    if (blob.type === "image/gif" && typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      bitmap.close();
      return canvas.toDataURL("image/png");
    }
    return blobToDataUrl(blob);
  });
  request.catch(() => resourceCache.delete(url));
  return cache(resourceCache, url, request, 32);
}

const DYNAMIC_PSEUDO = /:(hover|active|focus|focus-visible|focus-within)\b/;

/** Splits a selector list on top-level commas. */
function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote = "", start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) { parts.push(list.slice(start, i)); start = i + 1; }
  }
  parts.push(list.slice(start));
  return parts;
}
/** Arguments of every :has(...) in a selector (balanced parentheses, quotes respected). */
function hasArguments(selector: string): string[] {
  const out: string[] = [];
  for (let at = selector.indexOf(":has("); at !== -1; at = selector.indexOf(":has(", at + 5)) {
    let depth = 0, quote = "";
    for (let i = at + 4; i < selector.length; i++) {
      const c = selector[i]!;
      if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) { out.push(...splitSelectors(selector.slice(at + 5, i)).map(part => part.trim())); break; }
    }
  }
  return out;
}
/** Removes attribute selectors and functional pseudo-class arguments, which never require a class. */
function stripArguments(selector: string): string {
  let out = "", depth = 0, quote = "";
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!;
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (depth && (c === '"' || c === "'")) { quote = c; continue; }
    if (c === "(" || c === "[") { depth++; continue; }
    if (c === ")" || c === "]") { depth--; continue; }
    if (!depth) out += c;
  }
  return out;
}
/**
 * Class names every element-matching selector in the list requires, or null when the rule
 * must be kept unconditionally. A selector that can only match a hovered/focused element
 * never matches a static snapshot and is dropped.
 */
export function compileNeeds(selectorText: string): string[][] | null {
  if (selectorText.includes("\\")) return null;
  const needs: string[][] = [];
  for (const selector of splitSelectors(selectorText)) {
    const bare = stripArguments(selector);
    if (DYNAMIC_PSEUDO.test(bare)) continue;
    const classes = Array.from(bare.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g), m => m[1]!);
    if (!classes.length) return null;
    needs.push(classes);
  }
  return needs;
}
function compileRule(rule: CSSRule): CompiledRule {
  const text = rule.cssText.replace(/:root\b/g, "html");
  if ("selectorText" in rule) {
    // Nested style rules are kept whole when their parent survives.
    return { text, needs: compileNeeds((rule as CSSStyleRule).selectorText) };
  }
  const group = (rule as CSSGroupingRule).cssRules;
  if (group && !(rule instanceof CSSKeyframesRule)) {
    return { text, needs: null, header: text.slice(0, text.indexOf("{")), children: Array.from(group, compileRule) };
  }
  return { text, needs: null };
}
function keepRule(rule: CompiledRule, classes: Set<string>): string {
  if (rule.children) {
    let inner = "";
    for (const child of rule.children) inner += keepRule(child, classes);
    return inner ? `${rule.header}{${inner}}\n` : "";
  }
  if (rule.needs && !rule.needs.some(list => list.every(name => classes.has(name)))) return "";
  return rule.text + "\n";
}

/** Compiles one stylesheet once (until it changes) and records url() references that may need inlining. */
function readSheet(sheet: CSSStyleSheet): SheetInfo | null {
  let rules: CSSRuleList;
  try { rules = sheet.cssRules; } catch { return null; }
  const cached = sheetCache.get(sheet);
  if (cached && cached.length === rules.length) return cached;
  const base = sheet.href || document.baseURI;
  const urls: SheetInfo["urls"] = [];
  const visit = (list: CSSRuleList) => {
    for (let i = 0; i < list.length; i++) {
      const rule = list[i]!;
      if ("selectorText" in rule && rule.cssText.includes("url(")) {
        for (const match of rule.cssText.matchAll(CSS_URL)) {
          const raw = match[2]!.trim();
          if (raw.startsWith("data:") || raw.startsWith("#")) continue;
          try { urls.push({ selector: (rule as CSSStyleRule).selectorText, url: new URL(raw, base).href }); } catch {}
        }
      }
      if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules) visit((rule as CSSGroupingRule).cssRules);
    }
  };
  visit(rules);
  const compiled = Array.from(rules, rule => {
    const item = compileRule(rule);
    // Resolve relative references once so later string replacement matches absolute URLs.
    const absolute = (text: string) => text.replace(CSS_URL, (whole, _quote, raw: string) => {
      if (raw.startsWith("data:") || raw.startsWith("#")) return whole;
      try { return `url("${new URL(raw.trim(), base).href}")`; } catch { return whole; }
    });
    const fix = (r: CompiledRule) => { if (r.text.includes("url(")) r.text = absolute(r.text); r.children?.forEach(fix); };
    fix(item);
    return item;
  });
  const hasArgs = new Set<string>();
  const collect = (list: CSSRuleList) => {
    for (let i = 0; i < list.length; i++) {
      const rule = list[i]!;
      if ("selectorText" in rule && (rule as CSSStyleRule).selectorText.includes(":has(")) hasArguments((rule as CSSStyleRule).selectorText).forEach(arg => hasArgs.add(arg));
      if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules) collect((rule as CSSGroupingRule).cssRules);
    }
  };
  collect(rules);
  const media = sheet.media?.mediaText;
  const info = { length: rules.length, rules: compiled, media: media && media !== "all" ? media : null, urls, hasArgs: Array.from(hasArgs) };
  sheetCache.set(sheet, info);
  return info;
}

/** Compiles the app's stylesheets ahead of the first snip (call when the Snip Tool opens). */
export function prepareDomCapture() {
  for (const sheet of Array.from(document.styleSheets)) if (!sheet.disabled) readSheet(sheet);
}

const PSEUDO_ELEMENT = /::?(before|after|marker|placeholder|selection|backdrop|first-line|first-letter|file-selector-button|-webkit-[\w-]+|-moz-[\w-]+)(\([^)]*\))?/g;
// The snapshot is one frozen moment: animations must not restart from their first keyframe.
const FREEZE_CSS = "*,*::before,*::after{animation:none!important;transition:none!important}";

export async function captureDomFrame({ region, signal, scale, exclude }: DomCaptureOptions): Promise<SnipFrame> {
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const x = clamp(Math.floor(region.x), 0, vw - 1), y = clamp(Math.floor(region.y), 0, vh - 1);
  const area = { x, y, width: clamp(Math.ceil(region.width), 1, vw - x), height: clamp(Math.ceil(region.height), 1, vh - y) };
  const ratio = scale ?? (window.devicePixelRatio || 1);
  const visible = (box: DOMRect) => box.width > 0 && box.height > 0 && box.right > area.x && box.left < area.x + area.width && box.bottom > area.y && box.top < area.y + area.height;
  const pending: Promise<unknown>[] = [];

  /** Paints captured pixels behind an element that cannot render them itself, keeping its tag, rules and box. */
  const paint = (source: Element, clone: HTMLElement, data: string) => {
    const fit = getComputedStyle(source).objectFit;
    clone.style.backgroundImage = `url("${data}")`;
    clone.style.backgroundRepeat = "no-repeat";
    clone.style.backgroundPosition = "center";
    clone.style.backgroundSize = fit === "fill" ? "100% 100%" : fit === "cover" ? "cover" : fit === "none" ? "auto" : "contain";
    clone.style.backgroundOrigin = "content-box";
    clone.style.backgroundClip = "content-box";
  };
  /** Pins an element's exact layout box so swapping its content cannot shift anything inside the snip. */
  const pin = (source: HTMLElement, clone: HTMLElement, computed = getComputedStyle(source)) => {
    const width = computed.width.endsWith("px") ? computed.width : `${source.offsetWidth}px`;
    const height = computed.height.endsWith("px") ? computed.height : `${source.offsetHeight}px`;
    clone.style.setProperty("box-sizing", computed.boxSizing, "important");
    for (const [property, value] of [["width", width], ["min-width", width], ["max-width", width], ["height", height], ["min-height", height], ["max-height", height]]) {
      clone.style.setProperty(property!, value!, "important");
    }
  };
  // Subtrees nowhere near the snip are emptied (box kept), so a small snip of a busy
  // workspace costs about the same as one of an empty room.
  const MARGIN = 32;
  const near = (box: DOMRect) => box.right > area.x - MARGIN && box.left < area.x + area.width + MARGIN && box.bottom > area.y - MARGIN && box.top < area.y + area.height + MARGIN;
  const touchCache = new WeakMap<Element, boolean>();
  /** True when the element or any descendant (e.g. a menu escaping its pane) paints near the snip. */
  const touches = (element: Element): boolean => {
    const known = touchCache.get(element);
    if (known !== undefined) return known;
    let result = near(element.getBoundingClientRect());
    for (let child = element.firstElementChild; !result && child; child = child.nextElementSibling) result = touches(child);
    touchCache.set(element, result);
    return result;
  };
  /** Inline-style url() images (e.g. avatars, wallpapers) cannot load inside the snapshot; embed them. */
  const inlineCssUrls = (element: HTMLElement, style: string) => {
    for (const match of style.matchAll(CSS_URL)) {
      const raw = match[2]!.trim();
      if (raw.startsWith("data:") || raw.startsWith("#")) continue;
      let absolute: string;
      try { absolute = new URL(raw, document.baseURI).href; } catch { continue; }
      pending.push(fetchAsDataUrl(absolute).then(data => {
        element.setAttribute("style", (element.getAttribute("style") || "").split(match[0]).join(`url("${data}")`));
      }, () => { throw new SnipDomUnsupportedError("an image from another site"); }));
    }
  };
  const special = (source: Element, clone: Element): Element | null => {
    const tag = source.tagName;
    if (FRAME_TAGS.has(tag)) {
      if (visible(source.getBoundingClientRect())) throw new SnipDomUnsupportedError("an embedded page");
      for (const name of ["src", "srcdoc", "data"]) clone.removeAttribute(name);
      return clone;
    }
    if (tag === "CANVAS") {
      const canvas = source as HTMLCanvasElement;
      if (!canvas.width || !canvas.height || !visible(canvas.getBoundingClientRect())) return clone;
      let context: RenderingContext | null = null;
      try { context = canvas.getContext("2d"); } catch {}
      if (!context) throw new SnipDomUnsupportedError("a 3D view");
      let data: string;
      try { data = canvas.toDataURL(); } catch { throw new SnipDomUnsupportedError("protected canvas content"); }
      paint(source, clone as HTMLElement, data);
      return clone;
    }
    if (tag === "VIDEO") {
      const video = source as HTMLVideoElement, target = clone as HTMLVideoElement;
      target.removeAttribute("src"); target.removeAttribute("poster"); target.removeAttribute("controls"); target.replaceChildren();
      if (!visible(video.getBoundingClientRect())) return clone;
      // Native controls and posters live outside the page's DOM; only a bare, decoded frame can be redrawn.
      if (video.controls || video.readyState < 2 || !video.videoWidth) throw new SnipDomUnsupportedError("a video");
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        canvas.getContext("2d")!.drawImage(video, 0, 0);
        paint(source, target, canvas.toDataURL());
      } catch { throw new SnipDomUnsupportedError("a protected video"); }
      return clone;
    }
    if (tag === "AUDIO") return null;
    if (tag === "IMG") {
      const img = source as HTMLImageElement, target = clone as HTMLImageElement;
      const src = img.currentSrc || img.src;
      target.removeAttribute("srcset"); target.removeAttribute("sizes"); target.removeAttribute("loading");
      if (!src || src.startsWith("data:")) { if (src) target.src = src; return clone; }
      const box = img.getBoundingClientRect();
      if (!visible(box) || !img.complete || !img.naturalWidth) {
        // Never loaded inside the snapshot; keep its box so neighbours do not move.
        pin(img, target);
        target.src = EMPTY_IMAGE;
        return clone;
      }
      // Rasterise at the displayed resolution: enough for the snip without encoding the full source.
      const fit = Math.min(1, Math.max((box.width * ratio) / img.naturalWidth, (box.height * ratio) / img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * fit)), h = Math.max(1, Math.round(img.naturalHeight * fit));
      if (fit < 1) pin(img, target);
      const key = `${src}|${w}x${h}`;
      const known = imageCache.get(key);
      if (known) { target.src = known; return clone; }
      try {
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
        target.src = cache(imageCache, key, canvas.toDataURL());
      } catch {
        pending.push(fetchAsDataUrl(src).then(data => { target.src = data; }, () => { throw new SnipDomUnsupportedError("an image from another site"); }));
      }
      return clone;
    }
    if (tag === "INPUT") {
      const input = source as HTMLInputElement;
      if (input.type === "checkbox" || input.type === "radio") input.checked ? clone.setAttribute("checked", "") : clone.removeAttribute("checked");
      // Same number of masked dots, without placing the secret itself in the snapshot markup.
      else if (input.type === "password") clone.setAttribute("value", "x".repeat(input.value.length));
      else if (input.type !== "file") clone.setAttribute("value", input.value);
      return clone;
    }
    if (tag === "TEXTAREA") { clone.textContent = (source as HTMLTextAreaElement).value; return clone; }
    if (tag === "SELECT") {
      const options = (source as HTMLSelectElement).options, copies = (clone as HTMLSelectElement).querySelectorAll("option");
      for (let i = 0; i < options.length; i++) options[i]!.selected ? copies[i]?.setAttribute("selected", "") : copies[i]?.removeAttribute("selected");
      return clone;
    }
    return clone;
  };

  // :has(<descendant>) rules depend on content deep inside a subtree; such subtrees are never emptied.
  // Child/sibling arguments ("> svg", "+ .x") only look at nodes that are always kept.
  const guarded = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.disabled) continue;
    for (const arg of readSheet(sheet)?.hasArgs ?? []) {
      if (/^[>+~]\s*[^\s>+~]+$/.test(arg)) continue;
      const selector = arg.replace(/^[>+~]\s*/, "");
      let valid = validSelectors.get(selector);
      if (valid === undefined) {
        try { document.createDocumentFragment().querySelector(selector); valid = true; } catch { valid = false; }
        validSelectors.set(selector, valid);
      }
      if (valid) guarded.add(selector);
    }
  }
  const guardSelector = Array.from(guarded).join(",");
  const cloneOf = new Map<Element, HTMLElement>();
  const shifted = new WeakSet<HTMLElement>();
  const patch = (source: Element, clone: Element) => {
    const sources = Array.from(source.children), clones = Array.from(clone.children);
    const sx = source.scrollLeft, sy = source.scrollTop;
    for (let i = 0; i < sources.length; i++) {
      const a = sources[i]!, b = clones[i];
      if (!b) break;
      if (SKIPPED_TAGS.has(a.tagName) || a.classList.contains("snip-ui") || exclude?.(a)) { b.remove(); continue; }
      if (a instanceof HTMLElement && b instanceof HTMLElement && a.childElementCount && !KEEP_CHILDREN_TAGS.has(a.tagName) && !touches(a)
        && !(guardSelector && a.querySelector(guardSelector))) {
        const computed = getComputedStyle(a);
        if (PRUNABLE_DISPLAY.test(computed.display)) {
          b.replaceChildren();
          pin(a, b, computed);
          continue;
        }
      }
      const next = special(a, b);
      if (next !== b) { if (next) b.replaceWith(next); else b.remove(); }
      if (!next) continue;
      if (next instanceof HTMLElement) cloneOf.set(a, next);
      if (next === b && a.childElementCount) patch(a, b);
      const style = next.getAttribute("style");
      if (style?.includes("url(") && next instanceof HTMLElement && visible(a.getBoundingClientRect())) inlineCssUrls(next, style);
      if ((sx || sy) && next instanceof HTMLElement) {
        // A clone renders unscrolled; shift the content the way the live scroll position does.
        const computed = getComputedStyle(a);
        if (computed.position !== "fixed") {
          next.style.transform = `translate(${-sx}px, ${-sy}px)${computed.transform && computed.transform !== "none" ? ` ${computed.transform}` : ""}`;
          shifted.add(next);
        }
      }
    }
  };

  const body = document.body.cloneNode(true) as HTMLElement;
  patch(document.body, body);
  checkAbort(signal);
  // Animations are frozen in the snapshot, so carry over what each animated element shows right now.
  const animations = typeof document.getAnimations === "function" ? document.getAnimations() : [];
  for (const animation of animations) {
    const effect = animation.effect as KeyframeEffect | null;
    const target = effect?.target;
    const clone = effect && target && !effect.pseudoElement ? cloneOf.get(target) : undefined;
    if (!effect || !clone) continue;
    const computed = getComputedStyle(target!);
    for (const keyframe of effect.getKeyframes()) {
      for (const key of Object.keys(keyframe)) {
        if (key === "offset" || key === "computedOffset" || key === "easing" || key === "composite") continue;
        const property = key === "cssFloat" ? "float" : key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
        if (property === "transform" && shifted.has(clone)) continue;
        clone.style.setProperty(property, computed.getPropertyValue(property));
      }
    }
  }

  // Only rules that can match the snapshot are embedded; the snapshot parses far less CSS.
  const classes = new Set<string>();
  for (const name of Array.from(document.documentElement.classList)) classes.add(name);
  for (const name of Array.from(body.classList)) classes.add(name);
  for (const element of Array.from(body.getElementsByTagName("*"))) {
    const list = element.classList;
    for (let i = 0; i < list.length; i++) classes.add(list[i]!);
  }
  let css = "";
  const neededUrls = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.disabled) continue;
    const info = readSheet(sheet);
    if (!info) continue;
    let text = "";
    for (const rule of info.rules) text += keepRule(rule, classes);
    css += info.media ? `@media ${info.media}{${text}}` : text;
    for (const { selector, url } of info.urls) {
      if (neededUrls.has(url)) continue;
      // Only inline CSS images that actually paint inside the snip (e.g. a room background);
      // a ::before image paints within its element, so query the element itself.
      for (const part of splitSelectors(selector)) {
        try {
          const owners = Array.from(document.querySelectorAll(part.replace(PSEUDO_ELEMENT, "") || "*"));
          if (owners.some(element => !element.closest(".snip-ui") && visible(element.getBoundingClientRect()))) { neededUrls.add(url); break; }
        } catch { /* Unqueryable selector: the image is omitted. */ }
      }
    }
  }
  const inlined = await Promise.all(Array.from(neededUrls, url => fetchAsDataUrl(url).then(data => [url, data] as const, () => null)));
  for (const entry of inlined) if (entry) css = css.split(`url("${entry[0]}")`).join(`url("${entry[1]}")`);
  await Promise.all(pending);
  checkAbort(signal);

  const root = document.createElementNS(XHTML, "html");
  for (const attr of Array.from(document.documentElement.attributes)) root.setAttribute(attr.name, attr.value);
  root.setAttribute("style", `${root.getAttribute("style") ?? ""};width:${vw}px;height:${vh}px;margin:0;overflow:hidden;`);
  const head = document.createElementNS(XHTML, "head"), style = document.createElementNS(XHTML, "style");
  style.textContent = css + FREEZE_CSS;
  head.append(style);
  root.append(head, body);
  const xhtml = new XMLSerializer().serializeToString(root).replace(INVALID_XML, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="0 0 ${vw} ${vh}"><foreignObject x="0" y="0" width="${vw}" height="${vh}">${xhtml}</foreignObject></svg>`;

  // A data: URL, not a blob: URL: Chrome taints canvases drawn from blob-loaded foreignObject SVGs.
  const image = new Image();
  image.decoding = "async";
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try { await image.decode(); } catch { throw new SnipDomUnsupportedError("content the page could not redraw"); }
  checkAbort(signal);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(area.width * ratio));
  canvas.height = Math.max(1, Math.round(area.height * ratio));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Screen capture is unavailable.");
  context.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
  // Reading one pixel proves the canvas is exportable before the user sees the result.
  try { context.getImageData(0, 0, 1, 1); } catch { throw new SnipDomUnsupportedError("content the page could not redraw"); }
  return canvasFrame(canvas);
}
