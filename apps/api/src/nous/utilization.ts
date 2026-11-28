import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadavg } from "node:os";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { NOUS_LOAD_TARGET, nousLoadRangeSchema, type Pane, type NousLoad, type NousLoadAverage, type NousLoadPart, type NousLoadPartKey, type NousLoadRange, type NousSpendMode, type NousGoal } from "@space/contracts";
import type { NousLoadBucket, NousRepository } from "@space/db";
import type { HealthCollectorSample } from "../system-health-collector.js";
import { classifyLoad, hostSwapText, type HostSwap, type HostSwapReader, type NousLoadLevel } from "./server-load.js";

/**
 * Nous's Load (operator 31/10 13:58 BKK, plan clipboard:f4SH36t3fJ6c): the share of the server's capacity and of the token pools that Nous
 * and its agents use. It rides on the System Health sampler's 10 s /proc read (one more read of the three PSI files, no process scan),
 * keeps an hour of 10 s points in memory, writes one row a minute per owner and answers the dock from memory only.
 */

export interface NousUtilizationInput {
  cpuPercent: number | null; load5: number; cores: number; memTotalBytes: number | null; memAvailableBytes: number | null; swapPercent: number | null;
  /** The physical host's swap: the only hard server limit (past 90%); the other server numbers are this VM's. */
  host?: HostSwap | null;
  /** PSI "some avg10" of /proc/pressure/{cpu,memory,io}: the share of the last 10 s some task waited; null where the kernel has none. */
  psi: { cpu: number | null; memory: number | null; io: number | null };
  /** Pool use (tokens.ts nousPoolUtilization); `noRoom` names Nous's own pool when no account of it has room. */
  tokens: { claude: number | null; codex: number | null; gemini?: number | null; noRoom: string | null } | null;
  panes: { working: number; open: number } | null;
  helpers: { live: number; max: number } | null;
}
export type NousOwnerParts = Pick<NousUtilizationInput, "tokens" | "panes" | "helpers"> & {
  /** The owner's Load target for its spend mode now (Settings → Nous → Low-spend mode); NOUS_LOAD_TARGET without one. */
  target?: { percent: number; mode: NousSpendMode };
};
export interface NousUtilization { overall: number; level: NousLoadLevel; limit: string | null; parts: NousLoadPart[]; host: string | null }

/**
 * The blend v2 (operator 21/11 «ναι σε ολα»): Load is the share of CLI panes working. v1 gave the server 60 % (CPU, memory, load, pressure) and
 * Tokens 25 %: LLM-bound panes barely move a 20-core VM (21/11: CPU 29 %, load 28 %), so even every pane working read ~58 % and the 90 % target
 * could never be met. The other parts stay shown and keep their own holds (OVERLOADED, pool room); weight 0 keeps them out of the overall.
 * A part without data leaves the blend. A hard limit holds the overall at 100: the physical host's swap past 90% (classifyLoad) only; a pool with
 * no room shows on the Tokens part, and the push still stops on CRITICAL (utilizationPushOn).
 */
export const NOUS_LOAD_WEIGHTS: Record<NousLoadPartKey, number> = { cpu: 0, memory: 0, load: 0, pressure: 0, tokens: 0, panes: 1, helpers: 0 };
/**
 * A resource whose tasks stall 40 % of the time has no headroom left. Swap counts (at half) only without a PSI memory reading: swapped pages
 * stay out after memory frees (dev 31/10: swap 35 % with memory stalls at 0.4 %), and PSI already measures the stalls swapping causes.
 */
const PSI_SCALE = 2.5;
const GiB = 1024 ** 3;
const clamp = (value: number) => Math.min(100, Math.max(0, value));
const round = (value: number) => Math.round(value * 10) / 10;
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

export function nousUtilization(input: NousUtilizationInput): NousUtilization {
  const { cpuPercent: cpu, load5, cores, memTotalBytes: total, memAvailableBytes: available, swapPercent: swap, psi } = input;
  const stalls = [psi.cpu, psi.memory, psi.io].filter((value): value is number => value !== null).map((value) => value * PSI_SCALE);
  const pressure = [...stalls, ...(swap === null || psi.memory !== null ? [] : [swap / 2])];
  const pools = [input.tokens?.claude ?? null, input.tokens?.codex ?? null, input.tokens?.gemini ?? null].filter((value): value is number => value !== null);
  const percent = (value: number | null) => value === null || !Number.isFinite(value) ? null : round(clamp(value));
  const stall = (label: string, value: number | null) => `${label} ${value === null ? "?" : round(value)}%`;
  const parts: NousLoadPart[] = [
    { key: "cpu", label: "CPU", percent: percent(cpu), detail: `${cores} cores` },
    { key: "memory", label: "Memory", percent: percent(total && available !== null ? 100 * (1 - available / total) : null),
      detail: total && available !== null ? `${((total - available) / GiB).toFixed(1)} of ${(total / GiB).toFixed(0)} GiB in use` : "unknown" },
    { key: "load", label: "Load", percent: percent(cores > 0 ? (100 * load5) / cores : null), detail: `${load5.toFixed(1)} on ${cores} cores (5 min)` },
    { key: "pressure", label: "Pressure", percent: percent(pressure.length ? Math.max(...pressure) : null),
      detail: `this VM: stalls ${stall("cpu", psi.cpu)}, ${stall("memory", psi.memory)}, ${stall("io", psi.io)} · swap ${swap === null ? "?" : Math.round(swap)}%` },
    { key: "tokens", label: "Tokens", percent: percent(mean(pools)),
      detail: input.tokens ? `Claude Max ${input.tokens.claude === null ? "?" : Math.round(input.tokens.claude)}% · Codex ${input.tokens.codex === null ? "?" : Math.round(input.tokens.codex)}%`
        + (input.tokens.gemini == null ? "" : ` · Gemini ${Math.round(input.tokens.gemini)}%`) + (input.tokens.noRoom ? ` · ${input.tokens.noRoom}` : "") : "no Gateway sample" },
    { key: "panes", label: "CLI panes", percent: percent(input.panes?.open ? (100 * input.panes.working) / input.panes.open : null),
      detail: input.panes ? `${input.panes.working} of ${input.panes.open} working` : "unknown" },
    { key: "helpers", label: "Helpers", percent: percent(input.helpers?.max ? (100 * input.helpers.live) / input.helpers.max : null),
      detail: input.helpers ? `${input.helpers.live} of ${input.helpers.max} slots` : "unknown" }
  ];
  const known = parts.filter((part) => part.percent !== null);
  const weight = known.reduce((sum, part) => sum + NOUS_LOAD_WEIGHTS[part.key], 0);
  const blend = weight ? known.reduce((sum, part) => sum + NOUS_LOAD_WEIGHTS[part.key] * part.percent!, 0) / weight : 0;
  const { level, reasons } = classifyLoad({ swapPercent: input.host?.percent ?? null, host: input.host?.host });
  // Operator 21/11 (nous_msg:694ff0a9): a pool with no room is pace, not a hard limit; it no longer forces 100 % or restarts the under-target timer.
  const limit = level === "OVERLOADED" ? `server OVERLOADED (${reasons.join(", ")})` : null;
  return { overall: limit ? 100 : round(blend), level, limit, parts, host: input.host ? hostSwapText(input.host) : null };
}

/** "some avg10=1.23 avg60=…" → 1.23; null for a missing or unreadable file. */
export function parsePsi(text: string | null): number | null {
  const match = text ? /^some avg10=([\d.]+)/m.exec(text) : null;
  return match ? Number(match[1]) : null;
}

/** The owner's local date ("2026-10-31") of an instant. */
export const localDay = (at: number, zone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
const hourKey = (at: number) => new Date(at).toISOString().slice(0, 13);
const bucketAvg = (bucket: NousLoadBucket | undefined) => bucket && bucket.samples ? bucket.total / bucket.samples : null;

/** What the world line, space_token_state, the utilization-low line and the daily REVIEW read: the newest numbers and the averages. */
export interface NousLoadSummary extends NousUtilization { at: number; averages: NousLoad["averages"]; target: number; underForMs: number }

const partText = (summary: NousUtilization) => summary.parts.map((part) => `${part.label} ${part.percent === null ? "?" : `${Math.round(part.percent)}%`}`
  + (["tokens", "panes", "helpers"].includes(part.key) ? ` (${part.detail})` : "")).join(", ");
const avgText = (value: number | null) => value === null ? "?" : `${Math.round(value)}%`;

/** The world's line right after the Server line (plan clipboard:f4SH36t3fJ6c step 3): the share in use, its averages, and what to do with the headroom. */
export function renderNousUtilization(summary: NousLoadSummary): string {
  const { overall, target, averages } = summary;
  const part = (key: NousLoadPartKey) => summary.parts.find((entry) => entry.key === key)?.percent ?? null;
  const head = `Utilization ${Math.round(overall)}% (target ${target}%; avg today ${avgText(averages.today.value)}, yesterday ${avgText(averages.today.previous)}, 7 days ${avgText(averages.week.value)})`;
  const advice: string[] = [];
  const [cpu, load, memory, tokens] = [part("cpu"), part("load"), part("memory"), part("tokens")];
  if (tokens !== null && tokens >= 85 && Math.max(cpu ?? 0, load ?? 0) < 60) // Operator 21/11 20:00 BKK (nous_msg:eedece6d): Tokens 94% was read as "near their limit" while dev, lab and ntheo ran.
  advice.push("the server has room and Tokens is the room in use, not a stop: every account not RATE_LIMITED or spent still runs, so fill its idle panes (Provider advice for which pool first)");
  if (tokens !== null && tokens < 60 && ((cpu ?? 0) >= 75 || (memory ?? 0) >= 85)) advice.push("the token pools have room but the server is busy: leave heavy builds for later, use helpers for reading and thinking");
  const what = summary.limit ? `: at a limit (${summary.limit}); start nothing new until it clears.`
    : overall >= target ? ": at the target; keep the work going, never past OVERLOADED or a pool's room."
      : `: headroom ${Math.round(target - overall)}% → start more parallel work now: idle panes, helpers (space_subagents), stalled plans, waiting requests${advice.length ? `; ${advice.join("; ")}` : ""}.`;
  return `${head}${what} Parts: ${partText(summary)}.${target ? " Raise the average: it is a standing objective." : ""}`;
}

/**
 * Whether the 90 % push may run: under the target for 10 minutes on a CALM server, CLI panes under 90 % working (operator 3/11 23:11 BKK) and a
 * pool with room. Operator 13/11 07:09 BKK (nous_msg:5c0e7a6e): LOW (Nous's own pool ahead of its pace) is no stop, it silenced the push 13 h on
 * 11/11 while Codex and Gemini had room; only CRITICAL or an OVERLOADED host (`limit`) stop it. Operator 13/11 20:05 BKK (nous_msg:5eab08b0): the
 * pace-based tokens part is no stop either, 12:00-12:51 UTC it read 100 (every account ahead of its week pace) while Claude Max had 5 h and week room.
 */
export function utilizationPushOn(summary: NousLoadSummary, mode: NousSpendMode, freed = false): boolean {
  const part = (key: NousLoadPartKey) => summary.parts.find((entry) => entry.key === key)?.percent ?? null;
  // Operator 13/11 23:03 BKK: a CLI pane that just finished (`freed`) is pushed at once while utilization is under the Load target, not after 10 min.
  return (summary.underForMs >= 10 * 60_000 || (freed && summary.overall < summary.target)) && summary.level === "CALM" && !summary.limit && mode !== "CRITICAL" && (part("panes") ?? 0) < 90;
}

/**
 * The standing orders' inbox line (every 10 minutes, or at once for a pane that just finished) when the capacity stayed idle while work waits.
 * 21/11 (operator 10:40 BKK «Σου ζήτησα να τρέξεις load 90%»): `plans` counts runnable plans only (it said "23 open plans" while all 23 were
 * parked), the daily-improvement queue is work too, and a free pane gets work before it closes; Tokens is pace, not room.
 */
export function renderUtilizationLow(summary: NousLoadSummary, waiting: { plans: number; requests: number; improvements?: string[]; findings?: RegistryFinding[]; goals?: number }): string {
  const improvements = waiting.improvements ?? [];
  const findings = waiting.findings ?? [];
  const goals = waiting.goals ?? 0;
  return `Utilization stayed under the ${summary.target}% target for ${Math.round(summary.underForMs / 60_000)} min (now ${Math.round(summary.overall)}%, avg today ${avgText(summary.averages.today.value)}) `
    + `while the server is CALM and no pool is at its limit. Idle capacity: ${partText(summary)} (the overall is the CLI panes working; Tokens is each pool's 5-hour or week room in use, the tighter per account). `
    + `Runnable: ${waiting.plans} plan${waiting.plans === 1 ? "" : "s"} with a step to run, ${waiting.requests} operator request${waiting.requests === 1 ? "" : "s"}, `
    + `${improvements.length} daily-improvement fix${improvements.length === 1 ? "" : "es"}, ${findings.length} quality-registry finding${findings.length === 1 ? "" : "s"}${goals ? `, ${goals} active goal${goals === 1 ? "" : "s"}` : ""}. Fill the idle capacity now, in parallel: hand each free CLI pane below its next piece of work `
    + `(a plan step, a request, an improvement fix or a registry finding as a code change in its own worktree) before it closes, open new panes for the rest, helpers (space_subagents) for independent reading; `
    + `close only panes whose work is done and that nothing below fits; never past OVERLOADED or a pool's room.`
    + (improvements.length ? `\nDaily-improvement queue (nous/upgrades/queue.md OPEN lines, cause only: the evidence and fix are in the file):\n${improvements.map((line) => `- ${line}`).join("\n")}` : "")
    + (findings.length ? `\nQuality registry (docs/quality/review-findings.json, resolution open or partial; one finding a pane: read its disposition, re-check it on origin/dev; `
      + `code can finish it → fix it with a test and a dev-queue ticket and set resolution "fixed" with the commit; it waits on a decision or a release → leave it): `
      + findings.map((finding) => `${finding.id} (${finding.severity})`).join(", ") : "");
}

export interface RegistryFinding { id: string; severity: string }
/**
 * 22/11 (operator nous_msg:0e499daa «load 90%»: 3 of 12 CLI panes working at 02:51Z, every plan parked on a real date, third party or the
 * operator, the daily-improvement queue empty): the quality registry's confirmed findings not yet fixed (resolution open or partial, 10 on dev)
 * are code work the push never named. Warm-owned ones are left out (Warm changes need the operator's prior approval). Most severe first.
 */
export function registryOpen(text: string): RegistryFinding[] {
  let findings: Array<{ id?: unknown; status?: unknown; resolution?: unknown; severity?: unknown; owner?: unknown; waitsOn?: unknown }> = [];
  try { findings = (JSON.parse(text) as { findings?: typeof findings }).findings ?? []; } catch { return []; }
  // 22/11 (goal 5acd171d): a finding whose `waitsOn` names a release or decision has no code left (SEC-014 went to a pane 3 times in 30 min).
  return findings.filter((f) => f.status === "confirmed" && (f.resolution === "open" || f.resolution === "partial") && typeof f.id === "string" && !/\bWarm\b/.test(String(f.owner ?? ""))
    && !(typeof f.waitsOn === "string" && f.waitsOn.trim()))
    .map((f) => ({ id: f.id as string, severity: typeof f.severity === "string" ? f.severity : "P?" }))
    .sort((a, b) => a.severity.localeCompare(b.severity));
}

const upgradeQueueCause = (line: string): string => line.slice(7).split("; evidence:")[0]!.trim();
/** The daily-improvement queue's OPEN lines (daily-review.ts writes "- OPEN <day> REVIEW: <cause>; evidence: …; fix: …"), each to its cause. */
export const upgradeQueueOpen = (text: string): string[] => upgradeQueueOpenLines(text).map(upgradeQueueCause);
/**
 * The OPEN lines whole. 22/11 REVIEW (night utilization): a line marked "[DONE …]" in place but still starting "- OPEN" (the "(not taken)" lines)
 * counted as runnable and went to a free pane after every API restart, which found it already fixed.
 * 24/11: Nous can only append to queue.md, so a later "- DONE … was OPEN <cause>" line also closes its earlier OPEN line.
 */
export function upgradeQueueOpenLines(text: string): string[] {
  const lines = text.split("\n");
  const done = lines.flatMap((line, index) => (line.startsWith("- DONE ") ? [{ index, line }] : []));
  return lines.filter((line, index) => {
    if (!line.startsWith("- OPEN ") || line.includes("[DONE ")) return false;
    const cause = upgradeQueueCause(line);
    return !cause || !done.some((entry) => entry.index > index && entry.line.includes(`was OPEN ${cause}`));
  });
}
/**
 * 22/11 (operator nous_msg:694ff0a9 «load 90% … εως το πρωι», load 14-42 % all night): every push read "0 plans with a step to run" and the queue
 * ran dry by 02:52Z, so the free-pane hand-out had nothing and Nous sent four panes the same finished piece. The operator's ACTIVE goals always
 * have a next step beside their recorded wait («όλα θα τρέχουν παράλληλα»): each is a piece for a free CLI pane (any model), in priority order.
 */
export const goalPieces = (goals: NousGoal[]): Array<{ key: string; text: string; strong: boolean }> => goals.filter((goal) => goal.status === "ACTIVE")
  .sort((left, right) => left.priority - right.priority).map((goal) => ({ key: `goal:${goal.id}`, strong: false,
    text: `Work on the operator's ACTIVE Nous goal ${goal.id}: «${goal.text}»${goal.planIds.length ? ` (its plans: ${goal.planIds.join(", ")})` : ""}`
      + `${goal.waitsOn ? `. It waits on ${goal.waitsOn.kind}: ${goal.waitsOn.what}; that wait stays with Nous` : ""}. First read what was already done for it `
      + "(space-memory-recall, its plans, the latest pane reports naming it) so you repeat nothing; then do its next concrete step that needs neither the operator "
      + "nor that wait, with the usual gates (mail through the Mail Copilot review, no payment, no promote). Report what moved with space-progress done naming the "
      + "goal; if no such step exists, report that in one line and stop." }));

/**
 * Operator 24/11 13:07 BKK (nous_msg:be8aea8592914e98b55cf568, memory 258fedce; rule 509eb378 one pane = one task): 25 panes with their own work got a
 * hygiene sweep when idle, reported it done and were closed with their own work half done. Sweeps go only to panes Space opened for them, marked by this title.
 */
export const NOUS_SWEEP_PANE_TITLE = "Hygiene sweeps (Space)";
export const sweepPane = (pane: Pick<Pane, "title" | "titleSource">) => pane.titleSource === "manual" && pane.title === NOUS_SWEEP_PANE_TITLE;

/**
 * 22/11 (operator nous_msg:37276cdc «Δεν έχεις πουσαρει καθόλου όλο το βράδυ στο 90%»): when every plan, fix, finding and goal is given, a free strong
 * pane gets a hygiene sweep of one code area: unlabeled GitHub issues, failing/flaky tests, tsc errors, then eslint warnings (~4k), so the hand-out never runs dry.
 */
export function sweepPieces(root: string): Array<{ key: string; text: string }> {
  const dirs = (path: string) => { try { return readdirSync(join(root, path), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; } };
  const sources = ["apps", "packages"].flatMap((top) => dirs(top).filter((name) => dirs(`${top}/${name}`).includes("src")).map((name) => `${top}/${name}/src`));
  // 22/11: apps/web/src/assets (only PNG/SVG, nothing eslint or tsc reads) went to a pane 3 times in 90 min; an area needs a code file.
  const code = (path: string, recursive: boolean) => { try { return readdirSync(join(root, path), { recursive }).some((name) => /\.[cm]?[jt]sx?$/.test(String(name))); } catch { return false; } };
  const areas = [...sources.flatMap((src) => [...(code(src, false) ? [`${src}/*.ts(x)`] : []), ...dirs(src).filter((name) => code(`${src}/${name}`, true)).map((name) => `${src}/${name}`)]),
    ...(dirs(".").includes("scripts") ? ["scripts"] : [])];
  return areas.map((area) => ({ key: `sweep:${area}`, text: `Hygiene sweep of ${area} (this pane is Space's own sweep pane: it takes only sweeps). `
    + "Take the first source that has something: (1) an open GitHub issue without a label (gh issue list --state open --search no:label): fix it, or label it with what it waits on; "
    + `(2) a test of ${area} that fails or flakes on origin/dev (the dev merge queue's FAILED batches: space-queue status --target dev --json); (3) tsc errors of its app or package; `
    + `(4) eslint warnings in ${area} (npm run lint's eslint command on that path): clear one file's warnings with no behaviour change. Work in your own worktree from dev, with a test `
    + "where behaviour changes; do not change --max-warnings in package.json; the ceiling is lowered once, separately; submit to the dev merge queue and report the ticket with space-progress done. "
    + "Never touch Warm, terminal resize or other operator-protected code (AGENTS.md); nothing to fix there → report that in one line with space-progress done." }))
    // 22/11 CONFLICT storm: ~17 sweeps each lowering the one --max-warnings line conflicted every batch; one held piece lowers it for all.
    .concat({ key: "sweep:lint-ceiling", text: "Lint ceiling (the only hand-out that edits --max-warnings): in your own worktree from dev, run npm run lint's eslint command, "
      + "set --max-warnings in package.json to the real warning count it reports (never higher than now), change nothing else, submit that one ticket to the dev "
      + "merge queue and report it with space-progress done." });
}

/** A hand-out text sweepPieces wrote (a sweep or the lint ceiling). */
export const sweepHandout = (text: string) => /^(?:Hygiene sweep of |Lint ceiling \()/.test(text);

/** Whether any git-changed file path falls in a `sweep:<area>` piece (goal 5acd171d: skip clean areas until dev touches them). */
export function sweepAreaTouched(key: string, files: readonly string[]): boolean {
  if (!key.startsWith("sweep:")) return true;
  const area = key.slice("sweep:".length);
  if (area === "lint-ceiling") return files.length > 0;
  if (area.endsWith("/*.ts(x)")) {
    const dir = area.slice(0, -"/*.ts(x)".length);
    return files.some((file) => file.startsWith(`${dir}/`) && !file.slice(dir.length + 1).includes("/") && /\.[cm]?[jt]sx?$/.test(file));
  }
  return files.some((file) => file === area || file.startsWith(`${area}/`));
}

export interface NousLoadDeps {
  repository: Pick<NousRepository, "addLoadMinute" | "listLoad">;
  /** The owners whose load is kept (every owner with a room); read once a minute. */
  owners(): Promise<string[]>;
  /** Once a minute per owner: its token pools, CLI panes and helper slots. */
  ownerParts(owner: string): Promise<NousOwnerParts>;
  /** Every 10 s: the owner's helpers running now (a 10-45 s helper falls between the minute's reads). */
  liveHelpers?(owner: string): number;
  /** The owner's working time zone (their days). */
  zone(owner: string): Promise<string>;
  read?(path: string): Promise<string>;
  /** The physical host's swap, the Load tab's only server limit. */
  hostSwap?: HostSwapReader;
  loadavg?(): number[];
  now?(): number;
  warn?(error: unknown): void;
}

interface History { minutes: Array<{ at: number; value: number }>; hours: Map<string, NousLoadBucket>; days: Map<string, NousLoadBucket> }
interface OwnerState {
  parts: NousOwnerParts | null; zone: string; last: (NousUtilization & { at: number }) | null;
  ring: Array<{ at: number; value: number }>;
  minute: { minute: number; sum: number; count: number } | null;
  history: History | null;
  /** Loading the history and writing a minute run one after the other, so a minute is never counted twice. */
  chain: Promise<unknown>;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const PSI_FILES = ["cpu", "memory", "io"] as const;

export function createNousLoad(deps: NousLoadDeps) {
  const now = deps.now ?? Date.now;
  const read = deps.read ?? ((path: string) => readFile(path, "utf8"));
  const states = new Map<string, OwnerState>();
  const targetOf = (entry: OwnerState) => entry.parts?.target ?? { percent: NOUS_LOAD_TARGET, mode: null };
  let ownersMinute = -1;
  let ticking = false;

  const state = (owner: string): OwnerState => {
    let entry = states.get(owner);
    if (!entry) states.set(owner, entry = { parts: null, zone: "UTC", last: null, ring: [], minute: null, history: null, chain: Promise.resolve() });
    return entry;
  };
  const queue = <T>(entry: OwnerState, work: () => Promise<T>): Promise<T> => {
    const next = entry.chain.then(work);
    entry.chain = next.catch(() => undefined);
    return next;
  };
  const history = (owner: string, entry: OwnerState): Promise<History> => entry.history ? Promise.resolve(entry.history) : queue(entry, async () => {
    if (entry.history) return entry.history;
    const at = now();
    const stored = await deps.repository.listLoad(owner, { minutes: new Date(at - DAY_MS).toISOString(), hours: hourKey(at - 30 * DAY_MS), days: localDay(at - 61 * DAY_MS, entry.zone) });
    return entry.history = { minutes: stored.minutes.map((row) => ({ at: Date.parse(row.at), value: row.overall })),
      hours: new Map(stored.hours.map((bucket) => [bucket.bucket, bucket])), days: new Map(stored.days.map((bucket) => [bucket.bucket, bucket])) };
  });

  /** Stores the finished minute (its 10 s points' mean) and adds it to the hour and day in memory, as the repository does. */
  const flush = (owner: string, entry: OwnerState, done: { minute: number; sum: number; count: number }) => queue(entry, async () => {
    const at = done.minute * 60_000;
    const value = round(done.sum / done.count);
    const minute = { ownerUserId: owner, at: new Date(at).toISOString(), overall: value, hour: hourKey(at), day: localDay(at, entry.zone),
      parts: Object.fromEntries((entry.last?.parts ?? []).map((part) => [part.key, part.percent])) };
    const added = await deps.repository.addLoadMinute(minute);
    const kept = entry.history;
    if (!kept || !added) return;
    kept.minutes = [...kept.minutes.filter((row) => row.at >= at - DAY_MS && row.at !== at), { at, value }];
    for (const [map, key] of [[kept.hours, minute.hour], [kept.days, minute.day]] as const) {
      const sum = map.get(key);
      map.set(key, sum ? { bucket: key, total: sum.total + value, samples: sum.samples + 1, peak: Math.max(sum.peak, value) } : { bucket: key, total: value, samples: 1, peak: value });
    }
    for (const key of kept.hours.keys()) if (key < hourKey(at - 30 * DAY_MS)) kept.hours.delete(key);
    for (const key of kept.days.keys()) if (key < localDay(at - 61 * DAY_MS, entry.zone)) kept.days.delete(key);
  });

  async function refreshOwners(): Promise<void> {
    const owners = new Set([...await deps.owners().catch(() => [] as string[]), ...states.keys()]);
    await Promise.all([...owners].map(async (owner) => {
      const entry = state(owner);
      const [parts, zone] = await Promise.all([deps.ownerParts(owner).catch(() => entry.parts), deps.zone(owner).catch(() => entry.zone)]);
      entry.parts = parts;
      entry.zone = zone;
    }));
  }

  /** One 10 s sample: the server's numbers from the health sampler, the PSI files and the load average; each owner's minute closes on its own. */
  async function tick(sample: HealthCollectorSample): Promise<void> {
    const at = Date.parse(sample.sampledAt) || now();
    const metric = (id: string) => sample.metrics.find((entry) => entry.id === id);
    const [cpu, memory, io] = await Promise.all(PSI_FILES.map((name) => read(`/proc/pressure/${name}`).then(parsePsi, () => null)));
    const [, load5 = 0] = (deps.loadavg ?? loadavg)();
    const host = deps.hostSwap ? await deps.hostSwap.read().catch(() => null) : null;
    const minuteOf = Math.floor(at / 60_000);
    if (minuteOf !== ownersMinute) { ownersMinute = minuteOf; await refreshOwners(); }
    const server = { cpuPercent: metric("cpu")?.value ?? null, load5, cores: sample.coreCount, memTotalBytes: metric("memory-used")?.total ?? null,
      memAvailableBytes: metric("memory-available")?.value ?? null, swapPercent: metric("swap")?.value ?? null, host, psi: { cpu: cpu ?? null, memory: memory ?? null, io: io ?? null } };
    for (const [owner, entry] of states) {
      const helpers = entry.parts?.helpers ? { ...entry.parts.helpers, live: deps.liveHelpers?.(owner) ?? entry.parts.helpers.live } : null;
      const result = nousUtilization({ ...server, tokens: entry.parts?.tokens ?? null, panes: entry.parts?.panes ?? null, helpers });
      entry.last = { ...result, at };
      entry.ring = [...entry.ring.filter((point) => point.at > at - HOUR_MS), { at, value: result.overall }];
      if (entry.minute && entry.minute.minute !== minuteOf) void flush(owner, entry, entry.minute).catch((error) => deps.warn?.(error));
      entry.minute = entry.minute?.minute === minuteOf ? { ...entry.minute, sum: entry.minute.sum + result.overall, count: entry.minute.count + 1 } : { minute: minuteOf, sum: result.overall, count: 1 };
    }
  }

  function averages(entry: OwnerState, kept: History, at: number): NousLoad["averages"] {
    const minutesMean = (from: number, to: number) => mean(kept.minutes.filter((row) => row.at >= from && row.at < to).map((row) => row.value));
    const days = (from: number, to: number) => {
      const keys = new Set(Array.from({ length: to - from }, (_, index) => localDay(at - (from + index) * DAY_MS, entry.zone)));
      const sums = [...keys].map((key) => kept.days.get(key)).filter((bucket): bucket is NousLoadBucket => Boolean(bucket));
      const samples = sums.reduce((sum, bucket) => sum + bucket.samples, 0);
      return samples ? sums.reduce((sum, bucket) => sum + bucket.total, 0) / samples : null;
    };
    const pair = (value: number | null, previous: number | null): NousLoadAverage => ({ value: value === null ? null : round(value), previous: previous === null ? null : round(previous) });
    const monthKeys = new Set(Array.from({ length: 30 }, (_, index) => localDay(at - index * DAY_MS, entry.zone)));
    // A day with under an hour of samples (the first minutes after an install) is no best day.
    const best = [...kept.days.values()].filter((bucket) => monthKeys.has(bucket.bucket) && bucket.samples >= 60).sort((a, b) => bucketAvg(b)! - bucketAvg(a)!)[0];
    return { hour: pair(minutesMean(at - HOUR_MS, at + 1), minutesMean(at - 2 * HOUR_MS, at - HOUR_MS)),
      today: pair(bucketAvg(kept.days.get(localDay(at, entry.zone))), bucketAvg(kept.days.get(localDay(at - DAY_MS, entry.zone)))),
      week: pair(days(0, 7), days(7, 14)), month: pair(days(0, 30), days(30, 60)), bestDay: best ? { day: best.bucket, value: round(bucketAvg(best)!) } : null };
  }

  function series(entry: OwnerState, kept: History, range: NousLoadRange, at: number): NousLoad["series"] {
    const point = (time: number, value: number) => ({ at: new Date(time).toISOString(), value: round(value) });
    const grouped = (rows: Array<{ at: number; value: number }>, size: number) => {
      const groups = new Map<number, number[]>();
      for (const row of rows) groups.set(Math.floor(row.at / size) * size, [...groups.get(Math.floor(row.at / size) * size) ?? [], row.value]);
      return [...groups].sort(([a], [b]) => a - b).map(([time, values]) => point(time, mean(values)!));
    };
    const live = entry.last ? [point(entry.last.at, entry.last.overall)] : [];
    if (range === "1h") {
      const ringStart = entry.ring[0]?.at ?? at;
      return [...kept.minutes.filter((row) => row.at >= at - HOUR_MS && row.at < ringStart).map((row) => point(row.at, row.value)),
        ...entry.ring.map((row) => point(row.at, row.value))];
    }
    if (range === "24h") return [...grouped(kept.minutes.filter((row) => row.at >= at - DAY_MS), 5 * 60_000), ...live];
    const days = range === "7d" ? 7 : 30;
    const hours = [...kept.hours.values()].filter((bucket) => bucket.bucket >= hourKey(at - days * DAY_MS))
      .map((bucket) => ({ at: Date.parse(`${bucket.bucket}:00:00.000Z`), value: bucketAvg(bucket)! }));
    return [...grouped(hours, (range === "7d" ? 1 : 4) * HOUR_MS), ...live];
  }

  let unsubscribe: (() => void) | null = null;
  return {
    /** Feeds on the health sampler's samples (System Health retains one every 10 s). */
    start(subscribe: (listener: (sample: HealthCollectorSample) => void) => () => void) {
      unsubscribe ??= subscribe((sample) => {
        if (ticking) return;
        ticking = true;
        void tick(sample).catch((error) => deps.warn?.(error)).finally(() => { ticking = false; });
      });
    },
    stop() { unsubscribe?.(); unsubscribe = null; },
    tick,
    /** The newest utilization of the owner with its averages and how long it stayed under the target; null before the first sample. */
    async summary(owner: string): Promise<NousLoadSummary | null> {
      const entry = states.get(owner);
      if (!entry?.last) return null;
      const kept = await history(owner, entry);
      // How long the rolling minute mean (6 points of 10 s) stayed under the target, newest first (an hour at most: the ring's length).
      // Not "every point under": near the target one 10 s spike over it restarted the count and no push reached Nous 13/11 02:32-14:07 UTC (nous_msg:afe974ae).
      // Target 0 never pushes: nothing is under it.
      const target = targetOf(entry).percent;
      let since = entry.last.at;
      for (let index = entry.ring.length - 1; index >= 0; index -= 1) {
        const minute = entry.ring.slice(index, index + 6);
        if (minute.reduce((sum, point) => sum + point.value, 0) / minute.length >= target) break;
        since = entry.ring[index]!.at;
      }
      return { ...entry.last, target, averages: averages(entry, kept, now()), underForMs: entry.last.overall < target ? entry.last.at - since : 0 };
    },
    /** The daily REVIEW's line: yesterday's average (the reviewed day) against the day before, from the stored day sums. */
    async reviewLine(owner: string): Promise<string | null> {
      const entry = state(owner);
      const kept = await history(owner, entry);
      const at = now();
      const [day, before] = [localDay(at - DAY_MS, entry.zone), localDay(at - 2 * DAY_MS, entry.zone)].map((key) => kept.days.get(key));
      if (!day) return null;
      const value = bucketAvg(day)!, previous = bucketAvg(before);
      return `## Utilization\n${day.bucket}: average ${Math.round(value)}% of capacity in use (target ${targetOf(entry).percent}%, peak ${Math.round(day.peak)}%)`
        + `${previous === null ? "" : `, ${value >= previous ? "up" : "down"} ${Math.abs(Math.round(value - previous))} points from ${before!.bucket} (${Math.round(previous)}%)`}. `
        + "Raising it is a standing objective: name what kept capacity idle and what you will start in parallel (queue it in nous/upgrades/queue.md when it needs code).";
    },
    /** GET /api/nous/load: from memory only (the stored history is read once per owner after a start). */
    async view(owner: string, range: NousLoadRange): Promise<NousLoad> {
      const entry = state(owner);
      const kept = await history(owner, entry);
      const at = now();
      const last = entry.last;
      const { percent: target, mode: targetMode } = targetOf(entry);
      return { at: last ? new Date(last.at).toISOString() : null, overall: last?.overall ?? null, target, targetMode, level: last?.level ?? null,
        limit: last?.limit ?? null, host: last?.host ?? null, parts: last?.parts ?? [], range, series: series(entry, kept, range, at), averages: averages(entry, kept, at) };
    }
  };
}
export type NousLoadMonitor = ReturnType<typeof createNousLoad>;

export function registerNousLoadRoute(app: FastifyInstance, deps: {
  load: NousLoadMonitor; routeOptions: Record<string, unknown>; owner(request: FastifyRequest): Promise<string>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
}): void {
  const query = z.object({ range: nousLoadRangeSchema.default("1h") }).strict();
  app.get("/api/nous/load", deps.routeOptions, async (request) => {
    const owner = await deps.owner(request);
    return deps.load.view(owner, deps.parseQuery(query, request.query).range);
  });
}
