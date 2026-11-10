import { z } from "zod";
import { cliUpdateAllRequestSchema, type CliUpdateAllResult } from "@space/contracts";
import type { CliUpdateAllRunner } from "../cli-maintenance.js";

/**
 * Operator 1/11 03:25 BKK (plan clipboard:-RDH4NlHBL8L, Space Memory 7cf532c7): a CLI version upgrade (Claude Code, OpenCode,
 * Codex, Gemini, …) never waits for the operator. space_cli_update runs Settings' guarded update-all path (maintenance lock,
 * an atomic switch that running panes see only at their next start, rollback, the pinned major in scripts/cli-maintenance-adapters.mjs) as routine work.
 */
export const cliUpdateArgsSchema = z.object({
  runtimeId: z.preprocess((value) => typeof value === "string" ? value.trim().toLowerCase().replace(/^cli:/, "") : value,
    cliUpdateAllRequestSchema.shape.keys.unwrap().element).optional().describe("One CLI (claude, codex, opencode, gemini, … or cli:<id>); every managed CLI when absent."),
  detectOnly: z.boolean().optional().describe("Only read the installed and available versions; change nothing.")
});
export type CliUpdateArgs = z.infer<typeof cliUpdateArgsSchema>;

/** A new major is a reviewed Space change, never the operator's yes. */
export const CLI_MAJOR_NOTE = "A held major moves only with a reviewed Space change (available.major in scripts/cli-maintenance-adapters.mjs) through the dev queue and a promote: brief a pane for it; never ask the operator.";

type Ended = { result: CliUpdateAllResult; error: null } | { result: null; error: string };

function endedText(scope: string, ended: Ended): string {
  if (!ended.result) return `The update of ${scope} failed: ${ended.error}`;
  const { result } = ended;
  return [`CLI update of ${scope}: ${result.overallStatus} (${result.runtimes.length} checked).`,
    ...result.runtimes.map((runtime) => `- ${runtime.displayName}: ${runtime.installedVersion ?? "none"}${runtime.availableVersion && runtime.availableVersion !== runtime.installedVersion
      ? ` → ${runtime.availableVersion}` : ""} ${runtime.status} ${runtime.code}: ${runtime.summary}`),
    ...(result.runtimes.some((runtime) => runtime.code === "MAJOR_VERSION_HELD") ? [CLI_MAJOR_NOTE] : [])].join("\n");
}

export type NousCliUpdate = ReturnType<typeof createNousCliUpdate>;
export function createNousCliUpdate(deps: {
  runner: CliUpdateAllRunner;
  runtimeSettings(): Promise<ReadonlyArray<{ runtimeId: string; enabled: boolean }>>;
  notice(owner: string, key: string, line: string): void;
  audit?(owner: string, scope: string, ended: Ended): Promise<void>;
  /** How long a call waits for the update before it answers that it runs on: Claude Code ends an MCP call at 60 s. */
  waitMs?: number;
}) {
  let running: { scope: string; startedAt: string } | null = null;
  return {
    async run(owner: string, args: CliUpdateArgs): Promise<{ ok: boolean; display: string; result: string }> {
      if (args.detectOnly) {
        let detection;
        try { detection = await deps.runner.detect(await deps.runtimeSettings()); }
        catch (error) { return { ok: false, display: "Could not read the CLI versions", result: error instanceof Error ? error.message : "Detection failed." }; }
        return { ok: true, display: "Read the CLI versions", result: [
          ...(running ? [`An update of ${running.scope} runs since ${running.startedAt}.`] : []),
          ...detection.cliTypes.map((type) => `- ${type.displayName} (${type.cliType}): ${type.installedVersion ?? "not installed"}${type.availableVersion ? `, available ${type.availableVersion}` : ""}`
            + `${type.updateAvailable ? " (update available)" : ""}${type.managed ? "" : " (no managed update path)"}${type.enabled ? "" : " (switched off)"}`)
        ].join("\n") };
      }
      if (running) return { ok: true, display: "A CLI update already runs", result: `An update of ${running.scope} runs since ${running.startedAt}; its result comes to your inbox as one line.` };
      const scope = args.runtimeId ? `cli:${args.runtimeId}` : "every managed CLI";
      const started = running = { scope, startedAt: new Date().toISOString() };
      let waiting = true;
      const done: Promise<Ended> = deps.runner.updateAll(args.runtimeId ? { keys: [args.runtimeId] } : {})
        .then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error: error instanceof Error ? error.message : String(error) }));
      void done.then(async (ended) => {
        running = null;
        // Read before the audit's await: this runs ahead of the race below, so a result the call answers itself is not repeated.
        const late = !waiting;
        await deps.audit?.(owner, scope, ended).catch(() => undefined);
        if (late) deps.notice(owner, `cli-update:${started.startedAt}`, endedText(scope, ended));
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ended = await Promise.race([done, new Promise<null>((resolve) => { timer = setTimeout(resolve, deps.waitMs ?? 40_000, null); })]);
      clearTimeout(timer);
      waiting = false;
      if (!ended) return { ok: true, display: `Updating ${scope}`, result: `The update of ${scope} runs on (staging, checks, rollback on failure; running panes keep their version until they restart); its result comes to your inbox as one line.` };
      return { ok: ended.result !== null && ended.result.overallStatus !== "FAIL", display: ended.result ? `Updated ${scope}: ${ended.result.overallStatus}` : `Could not update ${scope}`, result: endedText(scope, ended) };
    }
  };
}
