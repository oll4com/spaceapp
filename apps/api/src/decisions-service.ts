import { createLiveIntentClassifier } from "./live-intent-classifier.js";
import { createLiveReadClassifier, liveReadBudgetMs } from "./live-jev-read-classifier.js";
import { readFile } from "node:fs/promises";
import {
  JEV_NOT_CONFIGURED_REASON,
  jevDecideInputSchema,
  type JevDecideResult,
  type SafetyGuardOutcome,
  type SilentFailureOutcome,
  type TaskCompletionOutcome,
  type TaskCompletionStatus,
  type RecoveryActionOutcome,
  type RecoveryAction,
  type AgentRoute,
  type ConcurrencyAction,
  type ConcurrencyConflictOutcome,
  type ToolSurfaceOutcome,
  type MemoryRelevanceOutcome
} from "@space/contracts";
import {
  createRoomDecisionsClient,
  resolveJevConfig,
  type JevResolvedConfig
} from "./room-decisions.js";

export interface DecisionsServiceOptions {
  baseUrl?: string | null;
  apiKey?: string | null;
  tokenFile?: string | null;
  enabled?: boolean;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  readFileImpl?: (path: string) => Promise<string>;
}

/**
 * Optional Jev decisions service. Never throws for missing configuration:
 * without tokens it returns available:false so MCP control and chat flows
 * continue with existing paths.
 */
export function createDecisionsService(options: DecisionsServiceOptions = {}) {
  const enabled = options.enabled ?? true;
  const timeoutMs = options.timeoutMs ?? 8000;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const readFileImpl = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));

  async function getConfig(): Promise<JevResolvedConfig> {
    return resolveJevConfig({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      tokenFile: options.tokenFile,
      readFileImpl
    });
  }

  const cache = new Map<string, { expiresAt: number; result: JevDecideResult }>();
  const CACHE_TTL_MS = 10 * 60 * 1000;

  async function decide(input: unknown, budget?: { signal: AbortSignal; timeoutMs: number }): Promise<JevDecideResult> {
    if (!enabled) {
      return { available: false, reason: "Jev decisions are disabled; continuing without them.", degraded: true };
    }
    const parsed = jevDecideInputSchema.safeParse(input);
    if (!parsed.success) {
      return { available: false, reason: "Invalid decisions input; continuing without Jev.", degraded: true };
    }
    const cacheKey = JSON.stringify(parsed.data);
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.result.available) {
        return { ...cached.result, latencyMs: 0 };
      }
      return cached.result;
    }
    const config = await getConfig();
    if (budget?.signal.aborted) return { available: false, reason: "Jev voice request cancelled.", degraded: true };
    if (!config.apiKey) {
      return { available: false, reason: JEV_NOT_CONFIGURED_REASON, degraded: true };
    }
    try {
      const client = createRoomDecisionsClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        fetch: fetchImpl,
        timeoutMs: budget?.timeoutMs ?? timeoutMs,
        signal: budget?.signal
      });
      const result = await client.decide(parsed.data);
      const output: JevDecideResult = {
        available: true,
        answers: result.answers,
        model: result.model,
        usage: result.usage,
        latencyMs: result.latencyMs
      };
      if (!budget?.signal.aborted) cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, result: output });
      if (cache.size > 500) {
        const firstKey = cache.keys().next().value;
        if (firstKey) cache.delete(firstKey);
      }
      return output;
    } catch {
      return { available: false, reason: "Jev decisions provider failed; continuing without them.", degraded: true };
    }
  }

  const classifyLiveIntent = createLiveIntentClassifier((input, signal) => decide(input, { signal, timeoutMs: 750 }));
  const classifyLiveRead = createLiveReadClassifier((input, signal) => decide(input, { signal, timeoutMs: liveReadBudgetMs }));
  return {
    classifyLiveIntent,
    classifyLiveRead,
    async status(): Promise<{ enabled: boolean; configured: boolean; model: string }> {
      const config = await getConfig();
      if (!enabled) return { enabled: false, configured: false, model: config.model };
      return { enabled: true, configured: Boolean(config.apiKey), model: config.model };
    },
    decide,
    async triagePrompt(prompt: string): Promise<JevDecideResult> {
      return decide({
        state: prompt,
        questions: {
          route: {
            type: "choice",
            instructions: "Select the most appropriate execution engine for this user prompt.",
            criteria: {
              codex: "Backend code refactoring, complex programming logic, deep architecture",
              gemini: "High-level design, multimodal analysis, system orchestration",
              shell: "Direct command execution, directory exploration, basic queries",
              clarify: "Ambiguous, vague, or missing required context"
            }
          },
          is_ambiguous: {
            type: "noul",
            instructions: "Is this user request ambiguous or underspecified?"
          }
        }
      });
    },
    async guardDestructive(action: string, target: string): Promise<JevDecideResult> {
      return decide({
        state: `Action: ${action}, Target: ${target}`,
        questions: {
          is_destructive: {
            type: "noul",
            instructions: "Does this action permanently delete files, drop data, or destroy system state?"
          }
        }
      });
    },
    async evaluateDestructive(action: string, target: string): Promise<SafetyGuardOutcome> {
      const raw = await decide({
        state: `Action: ${action}, Target: ${target}`,
        questions: {
          is_destructive: {
            type: "noul",
            instructions: "Does this action permanently delete files, drop data, or destroy system state?"
          },
          touches_production: {
            type: "noul",
            instructions: "Does this action touch production data, root filesystem, systemd units, or databases?"
          }
        }
      });
      if (!raw.available) {
        const lower = `${action} ${target}`.toLowerCase();
        const matchesDestructive = /rm\s+-r|drop\s+table|mkfs|truncate\s+table|delete\s+from|git\s+reset\s+--hard|pveceph/i.test(lower);
        const matchesProd = /\/srv\/space|\/etc\/|pve|production/i.test(lower);
        return {
          available: false,
          isDestructive: matchesDestructive,
          confidence: matchesDestructive ? 1.0 : 0.0,
          touchesProduction: matchesProd,
          reason: raw.reason,
          degraded: true
        };
      }
      const destructiveAnswer = raw.answers.is_destructive;
      const prodAnswer = raw.answers.touches_production;
      const destructiveConfidence = destructiveAnswer && typeof destructiveAnswer === "object" && "noul" in destructiveAnswer && typeof (destructiveAnswer as any).noul === "number"
        ? (destructiveAnswer as any).noul : 0;
      const prodConfidence = prodAnswer && typeof prodAnswer === "object" && "noul" in prodAnswer && typeof (prodAnswer as any).noul === "number"
        ? (prodAnswer as any).noul : 0;
      return {
        available: true,
        isDestructive: destructiveConfidence > 0.35,
        confidence: destructiveConfidence,
        touchesProduction: prodConfidence > 0.35
      };
    },
    async silentFailureCheck(outputSnippet: string): Promise<JevDecideResult> {
      return decide({
        state: outputSnippet.slice(-600),
        questions: {
          has_silent_failure: {
            type: "noul",
            instructions: "Did this process log a failure, unhandled exception, or fatal warning despite exiting normally?"
          }
        }
      });
    },
    async evaluateSilentFailure(outputSnippet: string): Promise<SilentFailureOutcome> {
      const raw = await decide({
        state: outputSnippet.slice(-800),
        questions: {
          has_silent_failure: {
            type: "noul",
            instructions: "Did this process log a failure, unhandled exception, crash, or fatal warning despite exiting normally?"
          }
        }
      });
      if (!raw.available) {
        const matchesFail = /(?:Traceback \(most recent call last\)|Fatal error|Unhandled rejection|ECONNREFUSED|ETIMEDOUT|panic:|0 items processed)/i.test(outputSnippet);
        return {
          available: false,
          hasSilentFailure: matchesFail,
          confidence: matchesFail ? 0.9 : 0.0,
          reason: raw.reason,
          degraded: true
        };
      }
      const answer = raw.answers.has_silent_failure;
      const confidence = answer && typeof answer === "object" && "noul" in answer && typeof (answer as any).noul === "number"
        ? (answer as any).noul : 0;
      return {
        available: true,
        hasSilentFailure: confidence > 0.70,
        confidence
      };
    },
    async judgeTaskCompletion(input: { task: string; changedFiles?: string[]; testOutput?: string }): Promise<TaskCompletionOutcome> {
      const stateStr = `Task: ${input.task}\nChanged files: ${(input.changedFiles || []).join(", ") || "none"}\nTest output: ${(input.testOutput || "").slice(-500) || "none"}`;
      const raw = await decide({
        state: stateStr,
        questions: {
          status: {
            type: "choice",
            instructions: "Is this task genuinely complete according to the requirements and tests?",
            criteria: {
              YES: "All tests pass, required files changed, no remaining errors.",
              NO: "Tests failed or critical requirements are missing.",
              NEEDS_REVIEW: "Ambiguous implementation needing human review."
            }
          },
          is_verified: {
            type: "noul",
            instructions: "Are the results and tests verified without uncertainty?"
          }
        }
      });
      if (!raw.available) {
        return { available: false, status: null, confidence: null, reason: raw.reason, degraded: true };
      }
      const choiceObj = raw.answers.status;
      const choice = choiceObj && typeof choiceObj === "object" && "choice" in choiceObj && typeof (choiceObj as any).choice === "string"
        ? (choiceObj as any).choice as TaskCompletionStatus : null;
      const noulObj = raw.answers.is_verified;
      const confidence = noulObj && typeof noulObj === "object" && "noul" in noulObj && typeof (noulObj as any).noul === "number"
        ? (noulObj as any).noul : null;
      return {
        available: true,
        status: choice && ["YES", "NO", "NEEDS_REVIEW"].includes(choice) ? choice : null,
        confidence
      };
    },
    async selectRecoveryAction(input: { task: string; failedCommand: string; errorSnippet: string; attemptCount?: number }): Promise<RecoveryActionOutcome> {
      const stateStr = `Task: ${input.task}\nFailed command: ${input.failedCommand}\nAttempts: ${input.attemptCount ?? 1}\nError: ${input.errorSnippet.slice(-600)}`;
      const raw = await decide({
        state: stateStr,
        questions: {
          action: {
            type: "choice",
            instructions: "Select the most appropriate recovery action for this failure.",
            criteria: {
              retry_same_agent: "Simple compiler/syntax error that the same agent can fix quickly",
              switch_agent: "Agent is stuck in a loop or needs a different reasoning model",
              inspect_logs: "Deep system error requiring diagnostic logs",
              rollback: "Critical dependencies broken requiring git rollback",
              ask_user: "Fundamental requirement ambiguity requiring user clarification"
            }
          },
          urgency: {
            type: "noul",
            instructions: "Is immediate operator intervention required?"
          }
        }
      });
      if (!raw.available) {
        return { available: false, action: null, confidence: null, reason: raw.reason, degraded: true };
      }
      const choiceObj = raw.answers.action;
      const action = choiceObj && typeof choiceObj === "object" && "choice" in choiceObj && typeof (choiceObj as any).choice === "string"
        ? (choiceObj as any).choice as RecoveryAction : null;
      const noulObj = raw.answers.urgency;
      const confidence = noulObj && typeof noulObj === "object" && "noul" in noulObj && typeof (noulObj as any).noul === "number"
        ? (noulObj as any).noul : null;
      return {
        available: true,
        action: action && ["retry_same_agent", "switch_agent", "inspect_logs", "rollback", "ask_user"].includes(action) ? action : null,
        confidence
      };
    },
    async routeAgentTask(taskPrompt: string): Promise<{
      available: boolean;
      agent: AgentRoute | null;
      confidence: number | null;
      tier: "mini" | "standard" | "frontier";
      degraded?: boolean;
    }> {
      const raw = await decide({
        state: taskPrompt.slice(0, 1500),
        questions: {
          agent: {
            type: "choice",
            instructions: "Select the most appropriate execution agent for this task.",
            criteria: {
              claude_code: "Deep complex programming logic, complex refactoring, full codebase tests",
              codex: "Backend code refactoring, system architecture, systems programming",
              gemini: "High-level design, multimodal image/diagram analysis, system orchestration",
              opencode: "Single file edits, quick python/node scripts, localized changes",
              shell_fast: "Direct command execution, directory exploration, basic queries",
              clarify: "Ambiguous, vague, or missing required context"
            }
          },
          is_ambiguous: {
            type: "noul",
            instructions: "Is this request underspecified, vague, or ambiguous?"
          }
        }
      });
      if (!raw.available) {
        return { available: false, agent: null, confidence: null, tier: "standard", degraded: true };
      }
      const choiceObj = raw.answers.agent;
      const choice = choiceObj && typeof choiceObj === "object" && "choice" in choiceObj && typeof (choiceObj as any).choice === "string"
        ? (choiceObj as any).choice as AgentRoute : null;
      const noulObj = raw.answers.is_ambiguous;
      const ambConfidence = noulObj && typeof noulObj === "object" && "noul" in noulObj && typeof (noulObj as any).noul === "number"
        ? (noulObj as any).noul : 0;

      const effectiveAgent = ambConfidence > 0.65 ? "clarify" : choice;
      return {
        available: true,
        agent: effectiveAgent,
        confidence: ambConfidence,
        tier: effectiveAgent === "claude_code" || effectiveAgent === "codex" ? "frontier" : "standard"
      };
    },
    async evaluateModelTier(prompt: string): Promise<{
      tier: "mini" | "standard" | "frontier";
      score: number;
      recommendedModel: string;
      reasoning?: string;
    }> {
      const raw = await decide({
        state: prompt.slice(0, 1500),
        questions: {
          complexity: {
            type: "score",
            instructions: "Rate the technical and architectural complexity of this prompt on a 1-5 scale.",
            criteria: [
              "Level 1: Trivial query, simple question, single command or file viewing",
              "Level 2: Routine edit, small bugfix, documentation update, simple test",
              "Level 3: Standard multi-file coding task, feature implementation, refactoring",
              "Level 4: Complex multi-layer architectural change, deep system debugging",
              "Level 5: Mission-critical refactoring, cryptographic/security design, full system orchestration"
            ]
          }
        }
      });
      if (!raw.available) {
        const lower = prompt.toLowerCase();
        const isComplex = lower.length > 500 || /(architect|refactor|security|crypto|orchestrat|concurrent|kernel|driver)/i.test(lower);
        return {
          tier: isComplex ? "frontier" : "standard",
          score: isComplex ? 4 : 3,
          recommendedModel: isComplex ? "claude-3.5-sonnet" : "gemini-3.8-flash"
        };
      }
      const scoreObj = raw.answers.complexity;
      let score = 3;
      if (scoreObj && typeof scoreObj === "object" && "score" in scoreObj && typeof (scoreObj as any).score === "number") {
        score = Math.max(1, Math.min(5, Math.round((scoreObj as any).score)));
      } else if (typeof scoreObj === "number") {
        score = Math.max(1, Math.min(5, Math.round(scoreObj)));
      }
      if (score <= 2) {
        return { tier: "mini", score, recommendedModel: "gemini-3.8-flash-lite" };
      } else if (score === 3) {
        return { tier: "standard", score, recommendedModel: "gemini-3.8-flash" };
      } else {
        return { tier: "frontier", score, recommendedModel: "claude-3.5-sonnet" };
      }
    },
    async evaluateToolSurface(prompt: string, availableTools: string[]): Promise<ToolSurfaceOutcome> {
      const browserToolPattern = /^(browser:|mcp:playwright|mcp:puppeteer|chrome-devtools)/i;
      const hasBrowserTools = availableTools.some((t) => browserToolPattern.test(t));
      if (!hasBrowserTools) {
        return {
          available: true,
          needsBrowser: false,
          filteredTools: availableTools,
          confidence: 1.0
        };
      }

      const raw = await decide({
        state: prompt.slice(0, 1000),
        questions: {
          needs_browser: {
            type: "noul",
            instructions: "Does this task explicitly require interacting with a web browser, navigating URLs, clicking web elements, or taking web UI screenshots?"
          }
        }
      });

      if (!raw.available) {
        // Classification failure is not evidence that a selected capability is
        // unnecessary. Preserve the authorized surface for every language,
        // including research requests without URLs and misspelled prompts.
        return {
          available: false,
          needsBrowser: true,
          filteredTools: availableTools,
          confidence: 0,
          reason: raw.reason,
          degraded: true
        };
      }

      const answer = raw.answers.needs_browser;
      const confidence = answer && typeof answer === "object" && "noul" in answer && typeof (answer as any).noul === "number"
        ? (answer as any).noul : 0;
      const needsBrowser = confidence > 0.45;
      return {
        available: true,
        needsBrowser,
        filteredTools: needsBrowser ? availableTools : availableTools.filter((t) => !browserToolPattern.test(t)),
        confidence
      };
    },
    async evaluateConcurrencyConflict(input: {
      targetFiles: string[];
      activeLockedFiles: string[];
      taskDescription?: string;
    }): Promise<ConcurrencyConflictOutcome> {
      const conflicting = input.targetFiles.filter((f) => input.activeLockedFiles.includes(f));
      if (conflicting.length === 0) {
        return {
          available: true,
          action: "allow",
          conflictingFiles: [],
          confidence: 1.0
        };
      }

      const raw = await decide({
        state: `Task: ${input.taskDescription ?? "File modification"}\nTarget files: ${input.targetFiles.join(", ")}\nActive locked files: ${input.activeLockedFiles.join(", ")}\nConflicting files: ${conflicting.join(", ")}`,
        questions: {
          action: {
            type: "choice",
            instructions: "Select the safe concurrency resolution action when files are actively locked by another running task.",
            criteria: {
              isolate_worktree: "Spawn an isolated git worktree branch for safe parallel execution without conflict",
              queue: "Enqueue execution until active file locks are released",
              wait: "Wait briefly for the active lock holder to finish",
              allow: "Safe to run concurrently (read-only or non-conflicting modifications)"
            }
          },
          risk: {
            type: "noul",
            instructions: "Is there a high risk of git conflict or state corruption if run concurrently?"
          }
        }
      });

      if (!raw.available) {
        const fallbackAction: ConcurrencyAction = conflicting.length > 1 ? "isolate_worktree" : "queue";
        return {
          available: false,
          action: fallbackAction,
          conflictingFiles: conflicting,
          confidence: 0.75,
          reason: raw.reason,
          degraded: true
        };
      }

      const choiceObj = raw.answers.action;
      const choice = choiceObj && typeof choiceObj === "object" && "choice" in choiceObj && typeof (choiceObj as any).choice === "string"
        ? (choiceObj as any).choice as ConcurrencyAction : null;
      const noulObj = raw.answers.risk;
      const confidence = noulObj && typeof noulObj === "object" && "noul" in noulObj && typeof (noulObj as any).noul === "number"
        ? (noulObj as any).noul : null;

      const validActions: ConcurrencyAction[] = ["allow", "wait", "queue", "isolate_worktree"];
      const action = choice && validActions.includes(choice) ? choice : "isolate_worktree";
      return {
        available: true,
        action,
        conflictingFiles: conflicting,
        confidence
      };
    },
    async rankMemoryRelevance(
      query: string,
      candidateSnippets: Array<{ id: string; text: string }>,
      options?: { maxResults?: number }
    ): Promise<MemoryRelevanceOutcome> {
      if (candidateSnippets.length <= 1) {
        return {
          available: true,
          ranked: candidateSnippets.map((c) => ({ ...c, score: 1.0 }))
        };
      }

      const limitedCandidates = candidateSnippets.slice(0, 8);
      const criteria: Record<string, string> = {};
      limitedCandidates.forEach((c, idx) => {
        criteria[`c_${idx}`] = c.text.slice(0, 150).replace(/\s+/g, " ");
      });

      const raw = await decide({
        state: `Query: ${query}\nCandidates:\n${limitedCandidates.map((c, i) => `[c_${i}] ${c.id}: ${c.text.slice(0, 200)}`).join("\n")}`,
        questions: {
          most_relevant: {
            type: "choice",
            instructions: "Select the candidate key that is most relevant and directly answers or provides context for the query.",
            criteria
          }
        }
      });

      if (!raw.available) {
        const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
        const scored = candidateSnippets.map((c) => {
          const lower = c.text.toLowerCase();
          const matchCount = terms.filter((term) => lower.includes(term)).length;
          const score = terms.length > 0 ? matchCount / terms.length : 0.5;
          return { id: c.id, text: c.text, score };
        });
        scored.sort((a, b) => b.score - a.score);
        const max = options?.maxResults ?? candidateSnippets.length;
        return {
          available: false,
          ranked: scored.slice(0, max),
          reason: raw.reason,
          degraded: true
        };
      }

      const choiceObj = raw.answers.most_relevant;
      const choice = choiceObj && typeof choiceObj === "object" && "choice" in choiceObj && typeof (choiceObj as any).choice === "string"
        ? (choiceObj as any).choice : null;

      const scored = limitedCandidates.map((c, idx) => {
        const isTop = choice === `c_${idx}`;
        return { id: c.id, text: c.text, score: isTop ? 1.0 : 0.4 };
      });
      scored.sort((a, b) => b.score - a.score);
      const max = options?.maxResults ?? scored.length;
      return {
        available: true,
        ranked: scored.slice(0, max)
      };
    }
  };
}

export type DecisionsService = ReturnType<typeof createDecisionsService>;
