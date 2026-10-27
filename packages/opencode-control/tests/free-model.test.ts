import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isFreeCostTier, isolatedOpenCodeEnvironment, openCodeDefaultFreeModel, orderFreeModelCandidates, parseFreeModelCatalog, probeFreeModel,
  toolCycleSucceeded, type OpenCodeExecute
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const line = (event: unknown) => JSON.stringify(event);

describe("free OpenCode model checks (operator rule 2026-10-11: working only after a real tool call)", () => {
  it("lists free, tool-capable, active Zen models from OpenCode 2's /api/model, newest first", () => {
    const model = (id: string, overrides: Record<string, unknown> = {}) => ({ id, providerID: "opencode", status: "active",
      enabled: true, capabilities: { tools: true }, cost: [{ input: 0, output: 0 }], time: { released: 1 }, ...overrides });
    const catalog = JSON.stringify({ data: [
      model("big-pickle", { time: { released: 1 } }), model("new-free", { time: { released: 2 } }),
      model("paid", { cost: [{ input: 0, output: 0 }, { input: 1, output: 2 }] }), model("no-tools", { capabilities: { tools: false } }),
      model("off", { enabled: false }), model("other", { providerID: "legacy" })
    ] });
    expect(parseFreeModelCatalog(catalog)).toEqual(["opencode/new-free", "opencode/big-pickle"]);
    expect(parseFreeModelCatalog("not json")).toEqual([]);
  });

  it("counts a tier as free only when every price in it is zero; a missing or null price is unknown, not zero (review 2026-10-21 #2)", () => {
    const model = (id: string, cost: unknown) => ({ id, providerID: "opencode", status: "active", enabled: true,
      capabilities: { tools: true }, cost, time: { released: 1 } });
    const catalog = JSON.stringify({ data: [
      model("free", [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]),
      model("free-no-cache", [{ input: 0, output: 0 }]),
      model("cache-billed", [{ input: 0, output: 0, cache: { read: 2, write: 3 } }]),
      model("cache-write-billed", [{ input: 0, output: 0, cache: { read: 0, write: 0.5 } }]),
      model("reasoning-billed", [{ input: 0, output: 0, reasoning: 1 }]),
      model("cache-null", [{ input: 0, output: 0, cache: null }]),
      model("cache-text", [{ input: 0, output: 0, cache: "free" }]),
      model("input-missing", [{ output: 0 }]),
      model("input-text", [{ input: "0", output: 0 }]),
      model("second-tier-cache", [{ input: 0, output: 0 }, { input: 0, output: 0, cache: { read: 1, write: 0 } }])
    ] });
    expect(parseFreeModelCatalog(catalog).sort()).toEqual(["opencode/free", "opencode/free-no-cache"]);
    expect(isFreeCostTier({ input: 0, output: 0, cache: { read: 0, write: 0 } })).toBe(true);
    expect(isFreeCostTier({ input: 0, output: 0, cache: { read: 2, write: 3 } })).toBe(false);
    expect(isFreeCostTier({ input: 0, output: 0, cache: { read: 0, write: 0, storage: 0.1 } })).toBe(false);
    expect(isFreeCostTier(null)).toBe(false);
    expect(isFreeCostTier([{ input: 0, output: 0 }])).toBe(false);
  });

  it("tries Big Pickle first, then the current choice, then the catalog", () => {
    expect(openCodeDefaultFreeModel).toBe("opencode/big-pickle");
    expect(orderFreeModelCandidates(["opencode/a", "opencode/big-pickle", "opencode/b"], "opencode/b"))
      .toEqual(["opencode/big-pickle", "opencode/b", "opencode/a"]);
    expect(orderFreeModelCandidates(["opencode/a"], "opencode/gone")).toEqual(["opencode/a"]);
  });

  it("accepts only a completed read call followed by the file's token", () => {
    const read = line({ type: "tool_use", part: { tool: "read", state: { status: "completed" } } });
    const answer = line({ type: "text", part: { text: "TOKEN" } });
    expect(toolCycleSucceeded({ code: 0, stdout: `${read}\n${answer}`, stderr: "" }, "TOKEN", { finishEvent: false })).toBe(true);
    expect(toolCycleSucceeded({ code: 0, stdout: answer, stderr: "" }, "TOKEN", { finishEvent: false })).toBe(false);
    expect(toolCycleSucceeded({ code: 1, stdout: `${read}\n${answer}`, stderr: "" }, "TOKEN", { finishEvent: false })).toBe(false);
  });

  it("probes in an isolated home with --standalone and a fresh token file", async () => {
    const { directory, env, work } = await isolatedOpenCodeEnvironment();
    roots.push(directory);
    expect(env.HOME).toBe(directory);
    expect(env.XDG_DATA_HOME).toBe(join(directory, "data"));
    const calls: string[][] = [];
    const execute: OpenCodeExecute = async (args, options) => {
      calls.push(args);
      const token = (await readFile(join(options.cwd, "spaceapp-check.txt"), "utf8")).trim();
      return { code: 0, stderr: "", stdout: [line({ type: "tool_use", part: { tool: "read", state: { status: "completed" } } }),
        line({ type: "text", part: { text: token } })].join("\n") };
    };
    const passed = await probeFreeModel("opencode/big-pickle", { env, work, execute });
    expect(passed).toMatchObject({ modelId: "opencode/big-pickle", ok: true, error: null });
    expect(calls[0]!.slice(0, 2)).toEqual(["run", "--standalone"]);
    expect(calls[0]).toContain("opencode/big-pickle");
    const refused = await probeFreeModel("opencode/big-pickle", { env, work, execute: async () => ({ code: 1, stderr: "",
      stdout: line({ type: "error", error: { message: "OpenCode's free tier can only be used from within OpenCode." } }) }) });
    expect(refused).toMatchObject({ ok: false, error: "OpenCode's free tier can only be used from within OpenCode." });
  });

  it("removes nothing outside its own temporary home", async () => {
    const outside = await mkdtemp(join(tmpdir(), "free-model-outside-"));
    roots.push(outside);
    const { directory } = await isolatedOpenCodeEnvironment();
    roots.push(directory);
    expect(directory.startsWith(outside)).toBe(false);
  });
});
