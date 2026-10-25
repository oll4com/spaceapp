import type { TokenCounter } from "./engine.js";

/**
 * Waste signals, after Headroom 0.37 `detect_waste_signals` (Apache-2.0, Headroom Contributors): tokens in a tool
 * output that carry little for the model. Detection only; nothing is removed here. Counts are tokens of the
 * request's tokenizer.
 */
export interface WasteSignals {
  json_bloat: number;
  html_noise: number;
  base64: number;
  whitespace: number;
}

export const wasteSignalNames = ["json_bloat", "html_noise", "base64", "whitespace", "reread"] as const;
export type WasteSignalName = (typeof wasteSignalNames)[number];

/**
 * Every category of Headroom 0.37's `WasteSignals.to_dict()`, in its order, as `/stats` reports them. Its detector never
 * sets dynamic_date or repetition, and reread_compressed needs CCR retrieval markers (CCR is off), so like Headroom
 * these three stay 0.
 */
export const headroomWasteSignalNames = ["json_bloat", "html_noise", "base64", "whitespace", "dynamic_date", "repetition", "reread",
  "reread_compressed"] as const;

const HTML_TAG = /<[^>]+>/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const BASE64 = /[A-Za-z0-9+/]{50,}={0,2}/g;
const WHITESPACE = /[ \t]{4,}|\n{3,}/g;
const JSON_BLOCK = /\{[\s\S]{500,}\}/g;

const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[0]);

export function detectWasteSignals(text: string, tokens: TokenCounter): WasteSignals {
  const signals: WasteSignals = { json_bloat: 0, html_noise: 0, base64: 0, whitespace: 0 };
  if (!text) return signals;
  const html = [...all(text, HTML_TAG), ...all(text, HTML_COMMENT)];
  if (html.length) signals.html_noise = tokens.count(html.join(""));
  const base64 = all(text, BASE64);
  if (base64.length) signals.base64 = tokens.count(base64.join(""));
  const whitespace = all(text, WHITESPACE);
  if (whitespace.length) signals.whitespace = Math.max(0, tokens.count(whitespace.join("")) - tokens.count(whitespace.join(" ")));
  for (const block of all(text, JSON_BLOCK)) {
    const count = tokens.count(block);
    if (count > 500) signals.json_bloat += count;
  }
  return signals;
}

/** Headroom re-read rule: the same tool result (50+ tokens) served again more than three positions after the last time. */
export const REREAD_MIN_TOKENS = 50;
export const REREAD_ADJACENT_GAP = 3;
