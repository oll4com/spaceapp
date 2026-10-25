import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { codeAwareReady, compressCode, initCodeAware } from "./code-aware/index.js";
import { compressDiff } from "./diff-compressor/index.js";
import type { Compressors, TokenCounter } from "./engine.js";
import { compressLog } from "./log-compressor/index.js";
import { compressSearchResults } from "./search-compressor/index.js";
import { smartCrush } from "./smart-crusher/index.js";
import { isProtectedLine } from "./test-output.js";
import { crushText } from "./text-crusher/index.js";
import { createTokenCounter } from "./tokenizer.js";

/**
 * The compressors Space Gateway runs. Each Headroom transform joins this map once its TypeScript port matches
 * Headroom's parity fixtures; until then its content type passes through unchanged. Retrieval markers (CCR) stay
 * off, as Headroom ran in production (`--no-ccr`): clients have no tool to fetch the dropped original back.
 */
export function createCompressors(): Compressors {
  return {
    // Neutral bias (1.0): Headroom's live-zone dispatcher passes 0.0, which as a multiplier always shrinks arrays
    // to the minimum keep count; the library default keeps the adaptive count.
    smartCrusher: (text) => {
      const result = smartCrush({ content: text, bias: 1.0 }, { enableCcrMarker: false });
      return result.wasModified ? result.compressed : null;
    },
    // Test failures, assertions and counts are kept whatever the caps say (log compressor and TextCrusher below).
    logCompressor: (text) => {
      const result = compressLog(text, { config: { enableCcr: false }, protect: isProtectedLine });
      return result.compressed === text ? null : result.compressed;
    },
    searchCompressor: (text) => {
      const { result } = compressSearchResults(text, "", 1.0);
      return result.compressed === text ? null : result.compressed;
    },
    diffCompressor: (text) => {
      const result = compressDiff(text, "", { enable_ccr: false });
      return result.compressed === text ? null : result.compressed;
    },
    // No query: a result that depended on the latest prompt would change between turns and break the prompt cache.
    codeAware: (text, language) => {
      if (!codeAwareReady()) return null;
      const result = compressCode(text, { language: language ?? null });
      return result.compressed === text ? null : result.compressed;
    },
    textCrusher: (text) => {
      const result = crushText(text, "", null, undefined, { pin: isProtectedLine });
      return result.compressed === text ? null : result.compressed;
    }
  };
}

/**
 * Loads the tree-sitter grammars for CodeAware: `grammars/` next to the bundle's `dist/`, or the package's from
 * the sources. Without them source code passes through unchanged.
 */
export async function initCompressors(): Promise<void> {
  const directory = [new URL("../grammars/", import.meta.url), new URL("../../grammars/", import.meta.url)]
    .map((url) => fileURLToPath(url)).find((path) => existsSync(`${path}tree-sitter-python.wasm`));
  if (!directory) return;
  try {
    await initCodeAware(directory);
  } catch {
    // CodeAware stays off; every other compressor works without it.
  }
}

/** OpenAI-model token counting (tiktoken o200k), as Headroom counts Codex traffic. */
export const tokenCounter: TokenCounter = createTokenCounter("o200k");
