import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  codexLbSpeedDefaultsResponseSchema,
  type CodexLbSpeedDefaultsResponse,
  type CodexLbSpeedTier
} from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";

const execFileAsync = promisify(execFile);
const defaultCommand = "/opt/spaceapp/bin/codex-vscode-parity";

export type CodexLbSpeedModelId = CodexLbSpeedDefaultsResponse["models"][number]["modelId"];
export type CodexLbSpeedCommandRunner = (command: string, args: string[]) => Promise<string>;

const updateAction: Record<CodexLbSpeedModelId, Record<CodexLbSpeedTier, string>> = {
  "gpt-5.5": {
    STANDARD: "speed-gpt-5-5-standard",
    FAST: "speed-gpt-5-5-fast"
  },
  "gpt-5.4": {
    STANDARD: "speed-gpt-5-4-standard",
    FAST: "speed-gpt-5-4-fast"
  }
};

async function runFixedCommand(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    timeout: 10_000,
    maxBuffer: 32_000
  });
  return String(stdout);
}

export function createCodexLbSpeedDefaultsService(options: {
  command?: string;
  runCommand?: CodexLbSpeedCommandRunner;
} = {}) {
  const command = options.command ?? defaultCommand;
  const runCommand = options.runCommand ?? runFixedCommand;

  async function run(action: string): Promise<CodexLbSpeedDefaultsResponse> {
    try {
      const output = await runCommand(command, [action]);
      return codexLbSpeedDefaultsResponseSchema.parse(JSON.parse(output));
    } catch {
      throw new SpaceConflictError("Codex-LB speed defaults are unavailable.");
    }
  }

  return {
    read: () => run("speed-status"),
    update: (modelId: CodexLbSpeedModelId, tier: CodexLbSpeedTier) => run(updateAction[modelId][tier])
  };
}
