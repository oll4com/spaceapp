import { useEffect } from "react";

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const INTERNAL_DOMAIN_SUFFIX =
  "(?:local|internal|lan|home|corp|intranet|localhost|home\\.arpa|oll4\\.com)";
const INTERNAL_URL_PATTERN = new RegExp(
  `https?://[^\\s"'<>]*\\b(?:[A-Za-z0-9-]+\\.)*${INTERNAL_DOMAIN_SUFFIX}\\b[^\\s"'<>]*|www\\.(?:[A-Za-z0-9-]+\\.)*${INTERNAL_DOMAIN_SUFFIX}\\b`,
  "i"
);
const INTERNAL_DOMAIN_PATTERN = new RegExp(
  `^(?:[A-Za-z0-9-]+\\.)*${INTERNAL_DOMAIN_SUFFIX}$`,
  "i"
);

const IPV4_PRIVATE_PATTERN =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|198\.(?:1[89])\.\d{1,3}\.\d{1,3})\b/;
const IPV6_INTERNAL_PATTERN =
  /\b(?:fc|fd)[0-9a-fA-F]{2}:[0-9a-fA-F:]+|\bfe80:[0-9a-fA-F:]*|(?<![0-9a-fA-F:])::1(?![0-9a-fA-F:])/;

const MASK_ATTRIBUTE = "data-sensitive-masked";

export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function hasSensitiveText(text: string): boolean {
  const normalized = normalizeText(text);
  if (normalized.length < 2) return false;
  if (EMAIL_PATTERN.test(normalized)) return true;
  if (IPV4_PRIVATE_PATTERN.test(normalized)) return true;
  if (IPV6_INTERNAL_PATTERN.test(normalized)) return true;
  if (INTERNAL_URL_PATTERN.test(normalized)) return true;
  if (INTERNAL_DOMAIN_PATTERN.test(normalized)) return true;
  return false;
}

export function shouldIgnore(element: Element | null): boolean {
  if (!element) return true;
  return Boolean(
    element.closest('script, style, svg, noscript, [data-sensitive-ignore], [data-sensitive-masked="text"], [data-sensitive-masked="block"]')
  );
}

const MASKABLE_INPUT_SELECTOR =
  'input[type="text"], input[type="tel"], input[type="email"], input[type="url"], input[type="search"], input:not([type]), textarea';

function applyMaskMarkers(): void {
  if (!document.body) return;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (shouldIgnore(parent)) return NodeFilter.FILTER_REJECT;
      const text = node.textContent ?? "";
      if (text.trim().length < 2) return NodeFilter.FILTER_REJECT;
      return hasSensitiveText(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const flagged: Element[] = [];
  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement;
    if (parent) flagged.push(parent);
  }
  for (const element of flagged) {
    element.setAttribute(MASK_ATTRIBUTE, "text");
  }
  for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(MASKABLE_INPUT_SELECTOR)) {
    if (shouldIgnore(input)) continue;
    const value = input.value ?? "";
    if (value.trim().length >= 2 && hasSensitiveText(value)) {
      input.setAttribute(MASK_ATTRIBUTE, "text");
    }
  }
}

function removeMaskMarkers(): void {
  document.querySelectorAll(`[${MASK_ATTRIBUTE}]`).forEach((element) => {
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
