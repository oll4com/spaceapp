/** SmartCrusher configuration. Defaults match Headroom `smart_crusher/config.rs` (Apache-2.0, Headroom Contributors). */
export interface SmartCrusherConfig {
  /** Arrays (and objects, by key count) smaller than this are not analyzed. */
  minItemsToAnalyze: number;
  /** Objects whose estimated tokens fall below this keep every key. */
  minTokensToCrush: number;
  /** Standard deviations from the mean that count as an outlier or change point. */
  varianceThreshold: number;
  /** Target maximum number of items kept per array. */
  maxItemsAfterCrush: number;
  preserveChangePoints: boolean;
  /** Strip all-row constant fields into a leading `{"_constant_fields": {...}}` sentinel. */
  factorOutConstants: boolean;
  /** Drop content-identical items before sampling. */
  dedupIdenticalItems: boolean;
  /** Share of the adaptive budget kept from the start / end of an array. */
  firstFraction: number;
  lastFraction: number;
  /** Relevance score at or above which a query-matching item is pinned. */
  relevanceThreshold: number;
  /** Emit `<<ccr:HASH ...>>` markers for dropped rows and opaque blobs. */
  enableCcrMarker: boolean;
  /** Never emit a marker: arrays that would lose rows stay uncompacted. */
  losslessOnly: boolean;
  // Accepted for config compatibility; upstream's crusher does not read these either.
  enabled: boolean;
  uniquenessThreshold: number;
  similarityThreshold: number;
  includeSummaries: boolean;
  useFeedbackHints: boolean;
  toinConfidenceThreshold: number;
}

export const DEFAULT_SMART_CRUSHER_CONFIG: Readonly<SmartCrusherConfig> = Object.freeze({
  minItemsToAnalyze: 5,
  minTokensToCrush: 200,
  varianceThreshold: 2.0,
  maxItemsAfterCrush: 15,
  preserveChangePoints: true,
  factorOutConstants: false,
  dedupIdenticalItems: true,
  firstFraction: 0.3,
  lastFraction: 0.15,
  relevanceThreshold: 0.3,
  enableCcrMarker: true,
  losslessOnly: false,
  enabled: true,
  uniquenessThreshold: 0.1,
  similarityThreshold: 0.8,
  includeSummaries: false,
  useFeedbackHints: true,
  toinConfidenceThreshold: 0.5
});
