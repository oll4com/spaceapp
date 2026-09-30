import { describe, expect, it } from "vitest";
import { createDecisionsService } from "../decisions-service.js";

describe("decisions service optional fallback", () => {
  it("continues without tokens (available:false, degraded)", async () => {
    const service = createDecisionsService({
      tokenFile: "/tmp/does-not-exist-jevtok",
      readFileImpl: async () => { throw new Error("no file"); }
    });
    const status = await service.status();
    expect(status.configured).toBe(false);
    const result = await service.decide({ state: "x", questions: {} });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.degraded).toBe(true);
  });

  it("continues when disabled", async () => {
    const service = createDecisionsService({ enabled: false });
    const result = await service.decide({
      state: "x",
      questions: { q: { type: "noul", instructions: "test?" } }
    });
    expect(result.available).toBe(false);
  });

  it("rejects invalid input without calling provider", async () => {
    let called = false;
    const service = createDecisionsService({
      tokenFile: "/tmp/does-not-exist-jevtok",
      fetch: ((async () => { called = true; throw new Error("must not call"); }) as unknown) as typeof fetch,
      readFileImpl: async () => "sk-or-test"
    });
    const result = await service.decide({ state: "x", questions: {} });
    expect(result.available).toBe(false);
    expect(called).toBe(false);
  });

  it("serves repeated queries from in-memory cache with 0ms latency", async () => {
    let fetchCount = 0;
    const service = createDecisionsService({
      tokenFile: "/mock/token",
      readFileImpl: async () => "mock-openrouter-token",
      fetch: ((async () => {
        fetchCount += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: "typesafe/jev-1.13",
            answers: { is_safe: { type: "noul", noul: 0.99 } },
            usage: { input_tokens: 100, output_tokens: 10, cost: 0.000004 }
          })
        };
      }) as unknown) as typeof fetch
    });

    const input = {
      state: "git status",
      questions: {
        is_safe: { type: "noul", instructions: "Is git status safe to execute?" }
      }
    };

    const first = await service.decide(input);
    expect(first.available).toBe(true);
    expect(fetchCount).toBe(1);

    const second = await service.decide(input);
    expect(second.available).toBe(true);
    expect(fetchCount).toBe(1); // Served from cache!
    if (second.available) {
      expect(second.latencyMs).toBe(0);
      expect(second.answers["is_safe"]).toEqual({ type: "noul", noul: 0.99 });
    }
  });

  it("provides typed helpers for triagePrompt, guardDestructive, and silentFailureCheck", async () => {
    const service = createDecisionsService({
      tokenFile: "/mock/token",
      readFileImpl: async () => "mock-openrouter-token",
      fetch: ((async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: "typesafe/jev-1.13",
          answers: {
            route: { type: "choice", choice: "codex" },
            is_ambiguous: { type: "noul", noul: 0.05 },
            is_destructive: { type: "noul", noul: 0.92 },
            has_silent_failure: { type: "noul", noul: 0.88 }
          }
        })
      })) as unknown) as typeof fetch
    });

    const triage = await service.triagePrompt("Refactor the backend API router");
    expect(triage.available).toBe(true);
    if (triage.available) {
      expect(triage.answers["route"]).toEqual({ type: "choice", choice: "codex" });
    }

    const guard = await service.guardDestructive("rm -rf", "/var/data");
    expect(guard.available).toBe(true);
    if (guard.available) {
      expect(guard.answers["is_destructive"]).toEqual({ type: "noul", noul: 0.92 });
    }

    const failure = await service.silentFailureCheck("Exit code 0. Warning: database unreachable.");
    expect(failure.available).toBe(true);
    if (failure.available) {
      expect(failure.answers["has_silent_failure"]).toEqual({ type: "noul", noul: 0.88 });
    }
  });

  it("evaluates destructive operations with safety thresholds and fallback", async () => {
    const serviceWithTokens = createDecisionsService({
      tokenFile: "/mock/token",
      readFileImpl: async () => "mock-token",
      fetch: ((async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: "typesafe/jev-1.13",
          answers: {
            is_destructive: { type: "noul", noul: 0.85 },
            touches_production: { type: "noul", noul: 0.90 }
          }
        })
      })) as unknown) as typeof fetch
    });

    const evaluated = await serviceWithTokens.evaluateDestructive("rm -rf", "/opt/spaceapp/data");
    expect(evaluated.available).toBe(true);
    expect(evaluated.isDestructive).toBe(true);
    expect(evaluated.confidence).toBe(0.85);
    expect(evaluated.touchesProduction).toBe(true);

    // Fallback without tokens
    const serviceWithoutTokens = createDecisionsService({
      tokenFile: "/non-existent",
      readFileImpl: async () => { throw new Error("no token"); }
    });
    const fallbackDestructive = await serviceWithoutTokens.evaluateDestructive("rm -rf", "/opt/spaceapp");
    expect(fallbackDestructive.available).toBe(false);
    expect(fallbackDestructive.isDestructive).toBe(true); // Deterministic fallback
    expect(fallbackDestructive.degraded).toBe(true);

    const fallbackSafe = await serviceWithoutTokens.evaluateDestructive("ls", "-la");
    expect(fallbackSafe.available).toBe(false);
    expect(fallbackSafe.isDestructive).toBe(false);
  });

  it("evaluates silent failure in process output", async () => {
    const service = createDecisionsService({
      tokenFile: "/mock/token",
      readFileImpl: async () => "mock-token",
      fetch: ((async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: "typesafe/jev-1.13",
          answers: {
            has_silent_failure: { type: "noul", noul: 0.94 }
          }
        })
      })) as unknown) as typeof fetch
    });

    const evaluated = await service.evaluateSilentFailure("Process finished 0. Connection refused to postgres.");
    expect(evaluated.available).toBe(true);
    expect(evaluated.hasSilentFailure).toBe(true);
    expect(evaluated.confidence).toBe(0.94);
  });

  it("judges task completion and selects recovery action", async () => {
    const service = createDecisionsService({
      tokenFile: "/mock/token",
      readFileImpl: async () => "mock-token",
      fetch: ((async (url: string, opts: any) => {
        const body = JSON.parse(opts.body);
        if (body.questions.status) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              model: "typesafe/jev-1.13",
              answers: {
                status: { type: "choice", choice: "YES" },
                is_verified: { type: "noul", noul: 0.96 }
              }
            })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: "typesafe/jev-1.13",
            answers: {
              action: { type: "choice", choice: "retry_same_agent" },
              urgency: { type: "noul", noul: 0.15 }
            }
          })
        };
      }) as unknown) as typeof fetch
    });

    const completion = await service.judgeTaskCompletion({
      task: "Fix type error in api.ts",
      changedFiles: ["api.ts"],
      testOutput: "Tests: 12 passed"
    });
    expect(completion.available).toBe(true);
    expect(completion.status).toBe("YES");
    expect(completion.confidence).toBe(0.96);

    const recovery = await service.selectRecoveryAction({
      task: "Build client",
      failedCommand: "npm run build",
      errorSnippet: "SyntaxError: Unexpected token"
    });
    expect(recovery.available).toBe(true);
    expect(recovery.action).toBe("retry_same_agent");
    expect(recovery.confidence).toBe(0.15);
  });

  it("routes agent tasks and evaluates model tiers based on complexity", async () => {
    const service = createDecisionsService({
      tokenFile: "/mock/token",
      readFileImpl: async () => "mock-token",
      fetch: ((async (url: string, opts: any) => {
        const body = JSON.parse(opts.body);
        if (body.questions.agent) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              model: "typesafe/jev-1.13",
              answers: {
                agent: { type: "choice", choice: "claude_code" },
                is_ambiguous: { type: "noul", noul: 0.12 }
              }
            })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: "typesafe/jev-1.13",
            answers: {
              complexity: { type: "score", score: 4.2 }
            }
          })
        };
      }) as unknown) as typeof fetch
    });

    const route = await service.routeAgentTask("Refactor distributed authentication system and write property tests");
    expect(route.available).toBe(true);
    expect(route.agent).toBe("claude_code");
    expect(route.tier).toBe("frontier");

    const tier = await service.evaluateModelTier("Architect multi-region database replication");
    expect(tier.tier).toBe("frontier");
    expect(tier.score).toBe(4);
    expect(tier.recommendedModel).toBe("claude-3.5-sonnet");

    // Fallback for simple prompt
    const serviceWithoutTokens = createDecisionsService({
      tokenFile: "/nonexistent",
      readFileImpl: async () => { throw new Error("no token"); }
    });
    const fallbackTier = await serviceWithoutTokens.evaluateModelTier("view /etc/hosts");
    expect(fallbackTier.tier).toBe("standard");
  });

  it("evaluates tool surface to filter out unnecessary browser tools", async () => {
    const service = createDecisionsService({
      tokenFile: "/mock/token",
      readFileImpl: async () => "mock-token",
      fetch: ((async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: "typesafe/jev-1.13",
          answers: {
            needs_browser: { type: "noul", noul: 0.05 }
          }
        })
      })) as unknown) as typeof fetch
    });

    const allTools = ["file:read", "file:write", "shell:run", "browser:navigate", "browser:screenshot", "mcp:playwright"];
    const filtered = await service.evaluateToolSurface("Write a unit test for math.ts", allTools);
    expect(filtered.available).toBe(true);
    expect(filtered.needsBrowser).toBe(false);
    expect(filtered.filteredTools).toEqual(["file:read", "file:write", "shell:run"]);

    // Test fallback when Jev is unavailable
    const serviceWithoutTokens = createDecisionsService({
      tokenFile: "/nonexistent",
      readFileImpl: async () => { throw new Error("no token"); }
    });
    const fallbackFiltered = await serviceWithoutTokens.evaluateToolSurface("Fix typo in README", allTools);
    expect(fallbackFiltered.available).toBe(false);
    expect(fallbackFiltered.needsBrowser).toBe(false);
    expect(fallbackFiltered.filteredTools).toEqual(["file:read", "file:write", "shell:run"]);

    const fallbackBrowser = await serviceWithoutTokens.evaluateToolSurface("Navigate to https://example.com and check login", allTools);
    expect(fallbackBrowser.needsBrowser).toBe(true);
    expect(fallbackBrowser.filteredTools).toEqual(allTools);
  });

  it("evaluates concurrency conflicts between active file locks and targets", async () => {
    const service = createDecisionsService({
      tokenFile: "/mock/token",
      readFileImpl: async () => "mock-token",
      fetch: ((async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: "typesafe/jev-1.13",
          answers: {
            action: { type: "choice", choice: "isolate_worktree" },
            risk: { type: "noul", noul: 0.92 }
          }
        })
      })) as unknown) as typeof fetch
    });

    // Overlapping files
    const result = await service.evaluateConcurrencyConflict({
      targetFiles: ["apps/api/src/app.ts", "packages/contracts/src/index.ts"],
      activeLockedFiles: ["apps/api/src/app.ts"]
    });
    expect(result.available).toBe(true);
    expect(result.action).toBe("isolate_worktree");
    expect(result.conflictingFiles).toEqual(["apps/api/src/app.ts"]);
    expect(result.confidence).toBe(0.92);

    // Non-conflicting files
    const safeResult = await service.evaluateConcurrencyConflict({
      targetFiles: ["apps/web/src/App.tsx"],
      activeLockedFiles: ["apps/api/src/app.ts"]
    });
    expect(safeResult.action).toBe("allow");
    expect(safeResult.conflictingFiles).toEqual([]);
  });

  it("ranks memory relevance for contextual recall", async () => {
    const service = createDecisionsService({
      tokenFile: "/mock/token",
      readFileImpl: async () => "mock-token",
      fetch: ((async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: "typesafe/jev-1.13",
          answers: {
            most_relevant: { type: "choice", choice: "c_1" }
          }
        })
      })) as unknown) as typeof fetch
    });

    const candidates = [
      { id: "mem:1", text: "Proxmox gateway is 192.0.2.1" },
      { id: "mem:2", text: "Jev decisions endpoint is /api/alpha/decisions" },
      { id: "mem:3", text: "PostgreSQL port is 5432" }
    ];

    const ranked = await service.rankMemoryRelevance("Where is the Jev endpoint?", candidates);
    expect(ranked.available).toBe(true);
    expect(ranked.ranked[0]?.id).toBe("mem:2");
    expect(ranked.ranked[0]?.score).toBe(1.0);
  });
});


