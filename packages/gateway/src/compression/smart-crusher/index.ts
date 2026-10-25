/**
 * SmartCrusher — TypeScript port of Headroom's statistical JSON crusher (Apache-2.0, Headroom Contributors).
 * Entry point: `smartCrush({ content, query, bias }, config)`.
 */
export { DEFAULT_SMART_CRUSHER_CONFIG, type SmartCrusherConfig } from "./config.js";
export { SmartCrusher, smartCrush, type CcrStore, type SmartCrushInput, type SmartCrushResult, type SmartCrusherOptions } from "./crusher.js";
export type { Constraint } from "./outliers.js";
export { bm25HybridScorer, type RelevanceScorer } from "./relevance.js";
