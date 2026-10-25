import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import type { TokenCounter } from "./engine.js";

/**
 * Token counting as in Headroom's tokenizer registry (Apache-2.0, Headroom Contributors): OpenAI models count
 * with tiktoken `o200k_base`; Claude has no public tokenizer, so it uses Headroom's character estimate
 * (3.5 characters per token, dense scripts at 1.5). Gemini's tokenizer is not public either: the same estimate at
 * 3.8 characters per token, between Google's 4 for English and the denser rate of code.
 */
export type TokenizerKind = "o200k" | "claude" | "gemini";

const CHARS_PER_TOKEN_CJK = 1.5;
/** Above this size an exact count would cost more than the compression; slices of the text are counted instead. */
const EXACT_LIMIT_CHARS = 64 * 1024;
const SAMPLE_SLICES = 8;
const SAMPLE_CHARS = 4 * 1024;

function isDenseScript(code: number): boolean {
  return (code >= 0x3000 && code <= 0x303f) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xff00 && code <= 0xffef) || (code >= 0x20000 && code <= 0x2a6df);
}

/** Headroom `EstimatingCounter.count_text`: characters are Unicode scalars, rounded half up, at least 1. */
export function estimateTokens(text: string, charsPerToken: number): number {
  if (text.length === 0) return 0;
  let dense = 0;
  let total = 0;
  for (const char of text) {
    total += 1;
    if (isDenseScript(char.codePointAt(0)!)) dense += 1;
  }
  return Math.max(1, Math.trunc((total - dense) / charsPerToken + dense / CHARS_PER_TOKEN_CJK + 0.5));
}

let encoder: Tiktoken | null = null;
const o200k = () => (encoder ??= new Tiktoken(o200kBase));

/** Exact o200k count; special-token text counts as ordinary text, as in Headroom. */
export function countO200k(text: string): number {
  return text.length === 0 ? 0 : o200k().encode(text, [], []).length;
}

/** Exact up to 64K characters; above that, evenly spaced slices give the tokens-per-character rate. */
export function countO200kBounded(text: string): number {
  if (text.length <= EXACT_LIMIT_CHARS) return countO200k(text);
  const step = Math.floor((text.length - SAMPLE_CHARS) / (SAMPLE_SLICES - 1));
  let sampledChars = 0;
  let sampledTokens = 0;
  for (let index = 0; index < SAMPLE_SLICES; index += 1) {
    const slice = text.slice(index * step, index * step + SAMPLE_CHARS);
    sampledChars += slice.length;
    sampledTokens += countO200k(slice);
  }
  return Math.max(1, Math.round((sampledTokens / sampledChars) * text.length));
}

export function createTokenCounter(kind: TokenizerKind): TokenCounter {
  if (kind === "claude") return { count: (text) => estimateTokens(text, 3.5) };
  if (kind === "gemini") return { count: (text) => estimateTokens(text, 3.8) };
  return { count: countO200kBounded };
}
