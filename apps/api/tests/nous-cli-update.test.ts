// CLI version upgrades are never the operator's (operator 1/11 03:25 BKK, plan clipboard:-RDH4NlHBL8L): Nous runs Settings' guarded
// update-all itself with space_cli_update; a long update answers at once and its result comes to the inbox as one line.
import { expect, it } from "vitest";
import type { CliUpdateAllDetection, CliUpdateAllRequest, CliUpdateAllResult } from "@space/contracts";
import { CLI_MAJOR_NOTE, createNousCliUpdate } from "../src/nous/cli-update.js";
import { NOUS_PERSONA } from "../src/nous/service.js";
import { NOUS_SUBAGENT_EXCLUDED } from "../src/nous/subagents.js";
import { createNousTools, nousToolDefinitions } from "../src/nous/tools.js";

const owner = "user:operator";
const ctx = { owner, turnId: "turn:cli", callId: "call:cli", traceId: "trace:cli" };
const runtime = (code: string, summary: string, status: "PASS" | "WARN" | "FAIL" = "PASS") => ({ runtimeId: "cli:claude", displayName: "Claude Code",
  installedVersion: "2.1.300", availableVersion: "2.1.305", status, code, summary, checks: [], customPreserved: false });
const result = (runtimes: CliUpdateAllResult["runtimes"]): CliUpdateAllResult => ({ mode: "UPDATE_ALL", overallStatus: runtimes.some((r) => r.status === "FAIL") ? "FAIL" : "PASS",
  scope: ["claude"], reinstall: false, runtimes, startedAt: null, finishedAt: new Date().toISOString() });
const detection: CliUpdateAllDetection = { schemaVersion: "space.cli-update-all.detection.v1", detectedAt: new Date().toISOString(), cliTypes: [
  { key: "claude", cliType: "cli:claude", displayName: "Claude Code", managed: true, updateKind: "npm", enabled: true, hasCustom: false, custom: [],
    installedVersion: "2.1.300", availableVersion: "2.1.305", updateAvailable: true }] };

function fixture(update: (input: CliUpdateAllRequest) => Promise<CliUpdateAllResult>) {
  const calls: CliUpdateAllRequest[] = [];
  const notices: Array<{ key: string; line: string }> = [];
  const audits: string[] = [];
  const cliUpdate = createNousCliUpdate({ runner: { detect: async () => detection, updateAll: (input = {}) => { calls.push(input); return update(input); } },
    runtimeSettings: async () => [], notice: (_owner, key, line) => notices.push({ key, line }), audit: async (_owner, scope) => { audits.push(scope); }, waitMs: 20 });
  return { tools: createNousTools({ cliUpdate } as never), calls, notices, audits };
}

it("updates one CLI at once and answers its result, with no decision card", async () => {
  const f = fixture(async () => result([runtime("UPDATED", "Claude Code updated to 2.1.305.")]));
  const done = await f.tools.execute("space_cli_update", { runtimeId: "cli:claude" }, ctx);
  expect(done).toMatchObject({ ok: true, display: "Updated cli:claude: PASS" });
  expect(done.result).toContain("Claude Code: 2.1.300 → 2.1.305 PASS UPDATED");
  expect(f.calls).toEqual([{ keys: ["claude"] }]);
  expect(f.notices).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(f.audits).toEqual(["cli:claude"]);
  expect((await f.tools.execute("space_cli_update", { detectOnly: true }, ctx)).result).toContain("Claude Code (cli:claude): 2.1.300, available 2.1.305 (update available)");
  // W48 step 2: a malformed or unknown id is refused before update-all; cli:harness (DeepSeek Harness) is a managed update key since b77fa171da.
  for (const runtimeId of ["notacli", "cli:", "cli:../claude", "cli:claude;rm", 42]) expect(await f.tools.execute("space_cli_update", { runtimeId }, ctx)).toMatchObject({ ok: false, refused: true });
  expect(f.calls).toEqual([{ keys: ["claude"] }]);
  await f.tools.execute("space_cli_update", { runtimeId: "cli:harness" }, ctx);
  expect(f.calls.at(-1)).toEqual({ keys: ["harness"] });
});

it("holds a CLI whose update fails and rolled back while the others update; the run fails only when every CLI failed", async () => {
  const kimi = { ...runtime("UPDATE_FAILED_ROLLED_BACK", "Kimi Code CLI update failed (Kimi Code stable release asset ids are invalid.).", "FAIL"), runtimeId: "cli:kimi" as const, displayName: "Kimi Code CLI" };
  const partly = await fixture(async () => result([runtime("UPDATED", "Claude Code updated to 2.1.305."), kimi])).tools.execute("space_cli_update", {}, ctx);
  expect(partly).toMatchObject({ ok: true, display: "Updated every managed CLI: held Kimi Code CLI" });
  expect(partly.result).toContain("Kimi Code CLI UPDATE_FAILED_ROLLED_BACK");
  expect(await fixture(async () => result([kimi])).tools.execute("space_cli_update", { runtimeId: "kimi" }, ctx)).toMatchObject({ ok: false, display: "Updated cli:kimi: FAIL" });
});

it("answers a long update at once and brings its end to the inbox; a held major names the reviewed change", async () => {
  let finish!: (value: CliUpdateAllResult) => void;
  const f = fixture(() => new Promise((resolve) => { finish = resolve; }));
  expect((await f.tools.execute("space_cli_update", {}, ctx)).result).toContain("runs on");
  expect(f.calls).toEqual([{}]);
  expect((await f.tools.execute("space_cli_update", { runtimeId: "codex" }, ctx)).result).toContain("An update of every managed CLI runs since");
  expect((await f.tools.execute("space_cli_update", { detectOnly: true }, ctx)).result).toContain("An update of every managed CLI runs since");
  finish(result([runtime("MAJOR_VERSION_HELD", "Claude Code was not changed: Space supports major 2 only until its migration ships.", "WARN")]));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(f.notices).toHaveLength(1);
  expect(f.notices[0]!.key).toMatch(/^cli-update:/);
  expect(f.notices[0]!.line).toContain(CLI_MAJOR_NOTE);
  expect(f.calls).toHaveLength(1);
});

it("is Nous's own: never a helper's, hidden on public installs, and the persona never asks the operator", async () => {
  const f = fixture(async () => result([]));
  expect((await f.tools.execute("space_cli_update", {}, { ...ctx, turn: { reason: "HELPER" } } as never)).ok).toBe(false);
  expect(f.calls).toEqual([]);
  expect(NOUS_SUBAGENT_EXCLUDED.has("space_cli_update")).toBe(true);
  expect(nousToolDefinitions({ copilots: false }).find((tool) => tool.name === "space_cli_update")?.inputSchema).toMatchObject({ properties: { detectOnly: { type: "boolean" } } });
  expect(nousToolDefinitions({ copilots: false, publicInstall: true }).some((tool) => tool.name === "space_cli_update")).toBe(false);
  expect(NOUS_PERSONA).toContain("CLI version upgrades (Claude Code, OpenCode, Codex, Gemini, …) are routine and never the operator's");
});
