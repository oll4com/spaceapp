import { useEffect } from "react";
import { siteSigninDomain } from "@space/contracts";

// Plan clipboard:1NF6u6gcCwtj step 14: only private values are hidden (addresses, internal hosts, secrets, one-time codes), never the prose around them.
const INTERNAL_DOMAIN_SUFFIX =
  "(?:local|internal|lan|home|corp|intranet|localhost|home\\.arpa)";
const HOST_END = "(?=[:/?#\\s\"'<>),;]|$)";
const PRIVATE_VALUE_PATTERNS: RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|198\.(?:1[89])\.\d{1,3}\.\d{1,3})\b/g,
  /\b(?:fc|fd)[0-9a-fA-F]{2}:[0-9a-fA-F:]+|\bfe80:[0-9a-fA-F:]*|(?<![0-9a-fA-F:])::1(?![0-9a-fA-F:])/g,
  // An internal host in a URL (not a path word such as /home), or a whole text that is one (a bare "Home" or "Local" is a name, not a host).
  new RegExp(`https?://(?:[^\\s/@"'<>]*@)?(?:[A-Za-z0-9-]+\\.)*${INTERNAL_DOMAIN_SUFFIX}${HOST_END}[^\\s"'<>]*|\\bwww\\.(?:[A-Za-z0-9-]+\\.)*${INTERNAL_DOMAIN_SUFFIX}\\b`, "gi"),
  new RegExp(`(?<=^\\s*)(?:[A-Za-z0-9-]+\\.)+${INTERNAL_DOMAIN_SUFFIX}(?=\\s*$)`, "gi"),
  // Provider keys and tokens.
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|spacecontrol\.v\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /SPACEAPP-PAIR:[^\s"'<>]+/g,
  // The value after a secret's label ("password: hunter2", "api_key=...").
  /(?<=\b(?:api[_ -]?key|secret|token|password|passwd)\s*[:=]\s*)[^\s,;]+/gi,
  // A one-time code after its label ("Your code is 482913", "OTP: 1234", "κωδικός 556677"); a date or version after "code" is not one.
  /(?<=(?:\b(?:code|otp|passcode|pin)|κωδικ(?:ός|ό|ος|ο)?(?:\s+σας|\s+σου)?)\s*(?:is|:|=|-)?\s*)\d{4,8}\b(?![-/.:]\d)/gi
];

const MASK_ATTRIBUTE = "data-sensitive-masked";

export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** The registrable domain this instance is served from (EXP-001: no build names one); null for localhost and IPs. */
export function instanceDomain(host: string): string | null {
  try { return siteSigninDomain(host); } catch { return null; }
}

const ownDomainPatterns = new Map<string, RegExp>();
function ownDomainPattern(domain: string): RegExp {
  let pattern = ownDomainPatterns.get(domain);
  if (!pattern) {
    const name = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern = new RegExp(`(?<=^|[\\s/@"'<>(])(?:[A-Za-z0-9-]+\\.)*${name}\\b(?::\\d+)?(?:/[^\\s"'<>]*)?`, "gi");
    ownDomainPatterns.set(domain, pattern);
  }
  return pattern;
}

const pageDomain = typeof location === "undefined" ? null : instanceDomain(location.hostname);

/** Where the private values are in a text, as merged [start, end) offsets. */
export function sensitiveSpans(text: string, ownDomain: string | null = pageDomain): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const patterns = ownDomain ? [...PRIVATE_VALUE_PATTERNS, ownDomainPattern(ownDomain)] : PRIVATE_VALUE_PATTERNS;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) if (match[0].length > 0) spans.push([match.index, match.index + match[0].length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push(span);
  }
  return merged;
}

export function hasSensitiveText(text: string, ownDomain: string | null = pageDomain): boolean {
  const normalized = normalizeText(text);
  return normalized.length >= 2 && sensitiveSpans(normalized, ownDomain).length > 0;
}

export function shouldIgnore(element: Element | null): boolean {
  if (!element) return true;
  return Boolean(
    element.closest('script, style, svg, noscript, [data-sensitive-ignore], [data-sensitive-masked="text"], [data-sensitive-masked="block"]')
  );
}

const MASKABLE_INPUT_SELECTOR =
  'input[type="text"], input[type="tel"], input[type="email"], input[type="url"], input[type="search"], input:not([type]), textarea';

const HIGHLIGHT_NAME = "space-sensitive";

// The CSS Custom Highlight API blurs only the value's own characters; without it (jsdom, old browsers) the value's element is marked whole.
function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function" ? CSS.highlights : null;
}

/** The text offset as a point in the run of sibling text nodes it falls in. */
function pointAt(run: Text[], offset: number): [Text, number] {
  for (const node of run) {
    if (offset <= node.data.length) return [node, offset];
    offset -= node.data.length;
  }
  const last = run[run.length - 1]!;
  return [last, last.data.length];
}

function applyMaskMarkers(): void {
  if (!document.body) return;
  const registry = highlightRegistry();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return shouldIgnore(node.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
  // Sibling text nodes are read as one text: React renders "Your code is {code}" as two of them.
  const runs: Text[][] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const run = runs.at(-1);
    if (run && node.previousSibling === run[run.length - 1]) run.push(node);
    else runs.push([node]);
  }
  const ranges: Range[] = [];
  const flagged: Element[] = [];
  for (const run of runs) {
    const text = run.map((node) => node.data).join("");
    if (text.trim().length < 2) continue;
    const spans = sensitiveSpans(text);
    if (spans.length === 0) continue;
    if (!registry) {
      if (run[0]!.parentElement) flagged.push(run[0]!.parentElement);
      continue;
    }
    for (const [start, end] of spans) {
      const range = document.createRange();
      range.setStart(...pointAt(run, start));
      range.setEnd(...pointAt(run, end));
      ranges.push(range);
    }
  }
  if (registry) registry.set(HIGHLIGHT_NAME, new Highlight(...ranges));
  for (const element of flagged) {
    element.setAttribute(MASK_ATTRIBUTE, "text");
  }
  for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(MASKABLE_INPUT_SELECTOR)) {
    if (shouldIgnore(input)) continue;
    // A field's value cannot carry a highlight, so the field is hidden whole. An empty one shows its placeholder (Space Gateway's Alias field shows the account's e-mail there).
    const value = input.value || input.placeholder || "";
    if (value.trim().length >= 2 && hasSensitiveText(value)) {
      input.setAttribute(MASK_ATTRIBUTE, "text");
    }
  }
}

function removeMaskMarkers(): void {
  highlightRegistry()?.delete(HIGHLIGHT_NAME);
  // Only this component's own markers: React does not put a removed manual marker back, so the next toggle would show it.
  document.querySelectorAll(`[${MASK_ATTRIBUTE}="text"]`).forEach((element) => {
    element.removeAttribute(MASK_ATTRIBUTE);
  });
}

export function SensitiveDataMask({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!enabled) {
      document.documentElement.removeAttribute("data-sensitive-mode");
      removeMaskMarkers();
      return;
    }
    document.documentElement.setAttribute("data-sensitive-mode", "hidden");
    let microtaskPending = false;
    applyMaskMarkers();
    const observer = new MutationObserver(() => {
      if (microtaskPending) return;
      microtaskPending = true;
      queueMicrotask(() => {
        microtaskPending = false;
        applyMaskMarkers();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      document.documentElement.removeAttribute("data-sensitive-mode");
      removeMaskMarkers();
    };
  }, [enabled]);
  return null;
}
