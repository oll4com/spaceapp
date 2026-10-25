/**
 * Headroom diff compression for Space Gateway: the unified-diff compressor and the parser-based diff detector,
 * TypeScript ports of Headroom v0.37.0 (Apache-2.0, Headroom Contributors).
 */
export {
  compressDiff,
  compressDiffWithStats,
  cjkBigrams,
  md5Hex24,
  DEFAULT_DIFF_COMPRESSOR_CONFIG,
  SCORE_CHANGE_DENSITY_CAP,
  SCORE_CHANGE_DENSITY_WEIGHT,
  SCORE_CONTEXT_MIN_WORD_LEN,
  SCORE_CONTEXT_WORD_WEIGHT,
  SCORE_PRIORITY_PATTERN_BOOST,
  SCORE_TOTAL_CAP
} from "./compressor.js";
export type { CcrStore, DiffCompression, DiffCompressionResult, DiffCompressorConfig, DiffCompressorStats } from "./compressor.js";
export { detectDiff, isDiff } from "./unidiff-detector.js";
