import { z } from "zod";

/**
 * Space Dots Stage 7: the release gates for model and routing changes.
 *
 * A candidate (a model, a reasoning level or an Auto policy) may replace the
 * baseline only when, on the holdout split of a frozen dataset run on the
 * real runtime:
 *  - every family reaches the quality floor (95% of cases pass every
 *    critical check);
 *  - the candidate is not worse than the baseline by more than the margin
 *    (2 points) at 95% one-sided confidence, paired by scenario group so
 *    correlated language variants never count as independent samples;
 *  - each family has enough independent groups to detect that margin;
 *  - costs are comparable for every case (an unknown cost blocks the cost
 *    gate) and the candidate costs no more than the baseline;
 *  - the evidence comes from runtime receipts and human calibration is done.
 * Anything else reports `releaseEligible: false` with the reasons.
 */
export const evalGateConfigSchema = z.object({
  qualityFloorPerFamily: z.number().min(0).max(1),
  nonInferiorityMargin: z.number().positive().max(0.5),
  confidence: z.number().min(0.5).max(0.999),
  power: z.number().min(0.5).max(0.99).default(0.8),
  /** Smallest share of groups expected to differ, used to size the sample when few differ so far. */
  planningDiscordance: z.number().positive().max(1).default(0.05)
});
export type EvalGateConfig = z.infer<typeof evalGateConfigSchema>;

export interface EvalCase { id: string; group: string; family: string; split: string }
/** One case's result on the runtime: passed every critical check or not; null when it did not run. */
export interface EvalCaseOutcome {
  caseId: string;
  passed: boolean | null;
  costStatus: "UNKNOWN" | "ESTIMATED" | "ACTUAL";
  costUsd: number | null;
  priceCatalogVersion: string | null;
}

/** Inverse standard normal CDF (Acklam's rational approximation, relative error below 1.2e-9). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError("p must be between 0 and 1.");
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - low) return -normalQuantile(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q
    / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

// One-sided 95% Student t critical values for 1-30 degrees of freedom.
const t95 = [6.3138, 2.92, 2.3534, 2.1318, 2.015, 1.9432, 1.8946, 1.8595, 1.8331, 1.8125, 1.7959, 1.7823, 1.7709, 1.7613, 1.7531,
  1.7459, 1.7396, 1.7341, 1.7291, 1.7247, 1.7207, 1.7171, 1.7139, 1.7109, 1.7081, 1.7056, 1.7033, 1.7011, 1.6991, 1.6973];
/** Student t quantile: exact table at 95% for small samples, otherwise the Cornish-Fisher expansion. */
export function tQuantile(p: number, df: number): number {
  if (df < 1) throw new RangeError("df must be at least 1.");
  if (p === 0.95 && Number.isInteger(df) && df <= 30) return t95[df - 1]!;
  if (df === 1) return Math.tan(Math.PI * (p - 0.5));
  if (df === 2) { const a = 4 * p * (1 - p); return 2 * (p - 0.5) * Math.sqrt(2 / a); }
  const z = normalQuantile(p), z2 = z * z;
  return z + (z * (z2 + 1)) / (4 * df) + (z * ((5 * z2 + 16) * z2 + 3)) / (96 * df * df)
    + (z * (((3 * z2 + 19) * z2 + 17) * z2 - 15)) / (384 * df ** 3);
}

/** One-sided Wilson score lower bound for a pass rate. */
export function wilsonLowerBound(successes: number, n: number, confidence: number): number {
  if (n === 0) return 0;
  const z = normalQuantile(confidence), p = successes / n, z2 = z * z;
  return Math.max(0, (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n));
}

type Verdict = "PASS" | "FAIL" | "INSUFFICIENT";
const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

export function evaluateEvalGates(input: {
  datasetVersion: string;
  cases: EvalCase[];
  baseline: EvalCaseOutcome[];
  candidate: EvalCaseOutcome[];
  config: EvalGateConfig;
  /** Only runtime receipts can make a candidate release-eligible. */
  evidenceKind: "RUNTIME_RECEIPTS" | "OFFLINE_TEXT_REPLAY";
  calibrationComplete: boolean;
  split?: string;
}) {
  const config = evalGateConfigSchema.parse(input.config);
  const split = input.split ?? "holdout";
  const cases = input.cases.filter((item) => item.split === split);
  const index = (outcomes: EvalCaseOutcome[]) => {
    const map = new Map<string, EvalCaseOutcome>();
    for (const outcome of outcomes) {
      if (map.has(outcome.caseId)) throw new Error(`Duplicate outcome for ${outcome.caseId}.`);
      map.set(outcome.caseId, outcome);
    }
    return map;
  };
  const baseline = index(input.baseline), candidate = index(input.candidate);
  const known = new Set(input.cases.map((item) => item.id));
  for (const id of [...baseline.keys(), ...candidate.keys()]) if (!known.has(id)) throw new Error(`Outcome for unknown case ${id}.`);
  const tCritical = (df: number) => tQuantile(config.confidence, df);
  const zSum = normalQuantile(config.confidence) + normalQuantile(config.power);

  const families = [...new Set(cases.map((item) => item.family))].sort().map((family) => {
    const familyCases = cases.filter((item) => item.family === family);
    const rate = (outcomes: Map<string, EvalCaseOutcome>) => {
      const observed = familyCases.filter((item) => outcomes.get(item.id)?.passed != null);
      const passed = observed.filter((item) => outcomes.get(item.id)!.passed).length;
      return { observed: observed.length, missing: familyCases.length - observed.length, passed,
        rate: observed.length ? round(passed / observed.length) : null,
        wilsonLower: round(wilsonLowerBound(passed, observed.length, config.confidence)) };
    };
    const candidateRate = rate(candidate), baselineRate = rate(baseline);
    const quality: Verdict = candidateRate.missing > 0 || candidateRate.observed === 0 ? "INSUFFICIENT"
      : candidateRate.passed / candidateRate.observed >= config.qualityFloorPerFamily ? "PASS" : "FAIL";
    // Paired by scenario group: each group's mean difference is one independent sample.
    const groups = [...new Set(familyCases.map((item) => item.group))].flatMap((group) => {
      const members = familyCases.filter((item) => item.group === group);
      if (members.some((item) => candidate.get(item.id)?.passed == null || baseline.get(item.id)?.passed == null)) return [];
      const mean = (outcomes: Map<string, EvalCaseOutcome>) => members.filter((item) => outcomes.get(item.id)!.passed).length / members.length;
      return [mean(candidate) - mean(baseline)];
    });
    const n = groups.length;
    const meanDiff = n ? groups.reduce((sum, value) => sum + value, 0) / n : 0;
    const sd = n > 1 ? Math.sqrt(groups.reduce((sum, value) => sum + (value - meanDiff) ** 2, 0) / (n - 1)) : 0;
    const lowerBound = n > 1 ? meanDiff - tCritical(n - 1) * sd / Math.sqrt(n) : null;
    const nonInferiority: Verdict = lowerBound === null ? "INSUFFICIENT" : lowerBound > -config.nonInferiorityMargin ? "PASS" : "FAIL";
    const discordance = n ? groups.filter((value) => value !== 0).length / n : 0;
    const planning = Math.max(discordance, config.planningDiscordance);
    const required = Math.ceil(zSum ** 2 * planning / config.nonInferiorityMargin ** 2);
    const totalGroups = new Set(familyCases.map((item) => item.group)).size;
    const sampleSufficiency: Verdict = n >= required ? "PASS" : "INSUFFICIENT";
    return { family, cases: familyCases.length, groups: totalGroups, candidate: candidateRate, baseline: baselineRate, quality,
      nonInferiority: { pairedGroups: n, meanDifference: round(meanDiff), lowerBound: lowerBound === null ? null : round(lowerBound), verdict: nonInferiority },
      sampleSufficiency: { pairedGroups: n, requiredGroups: required, discordance: round(discordance), verdict: sampleSufficiency } };
  });

  // Costs compare only when both sides priced every case with the same catalog.
  const priced = cases.map((item) => ({ base: baseline.get(item.id), cand: candidate.get(item.id) }));
  const comparable = priced.length > 0 && priced.every(({ base, cand }) => base && cand && base.costStatus !== "UNKNOWN" && cand.costStatus !== "UNKNOWN"
    && base.costUsd !== null && cand.costUsd !== null && base.priceCatalogVersion === cand.priceCatalogVersion);
  const sum = (side: "base" | "cand") => round(priced.reduce((total, entry) => total + (entry[side]?.costUsd ?? 0), 0), 6);
  const unknownCosts = priced.filter(({ base, cand }) => !base || !cand || base.costStatus === "UNKNOWN" || cand.costStatus === "UNKNOWN").length;
  const cost = comparable
    ? { verdict: (sum("cand") <= sum("base") ? "PASS" : "FAIL") as Verdict, baselineUsd: sum("base"), candidateUsd: sum("cand"), unknownCosts: 0 }
    : { verdict: "INSUFFICIENT" as Verdict, baselineUsd: null, candidateUsd: null, unknownCosts,
      reason: "An unknown or incomparable cost blocks the cost gate; unknown is never treated as zero." };

  const reasons: string[] = [];
  if (input.evidenceKind !== "RUNTIME_RECEIPTS") reasons.push("Only runtime receipts can make a candidate release-eligible.");
  if (!input.calibrationComplete) reasons.push("Human calibration of the checks is not complete.");
  if (!cases.length) reasons.push(`The dataset has no ${split} cases.`);
  for (const family of families) {
    if (family.quality !== "PASS") reasons.push(`${family.family}: quality ${family.quality.toLowerCase()} (floor ${config.qualityFloorPerFamily}).`);
    if (family.nonInferiority.verdict !== "PASS") reasons.push(`${family.family}: non-inferiority ${family.nonInferiority.verdict.toLowerCase()} (margin ${config.nonInferiorityMargin}).`);
    if (family.sampleSufficiency.verdict !== "PASS") {
      reasons.push(`${family.family}: ${family.sampleSufficiency.pairedGroups} paired groups; ${family.sampleSufficiency.requiredGroups} needed to detect the margin.`);
    }
  }
  if (cost.verdict !== "PASS") reasons.push(cost.verdict === "FAIL" ? "The candidate costs more than the baseline." : "Costs are not comparable for every case.");
  return { datasetVersion: input.datasetVersion, split, evidenceKind: input.evidenceKind, config, families, cost,
    releaseEligible: reasons.length === 0, reasons };
}
export type EvalGateReport = ReturnType<typeof evaluateEvalGates>;
