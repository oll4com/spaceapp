import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CliToggleRuntimeId } from "@space/contracts";
import { findCliRuntimeDescriptor } from "./cli-runtime-descriptors.js";

const execFileAsync = promisify(execFile);

const sweepCommand = "/usr/bin/sudo";
const sweepExecutable = "/opt/spaceapp/bin/space-cli-process-sweep";
const sweepTimeoutMs = 60_000;

export const cliProcessSweepExclusionPatterns: readonly RegExp[] = [
  /chrome[_-]devtools[_-]mcp/i
];

export interface RuntimeProcessTableRow {
  pid: number;
  args: string;
}

export interface RuntimeProcessSweepResult {
  matchedPids: number[];
  killedPids: number[];
  remainingPids: number[];
}

export interface RuntimeProcessSweeperOptions {
  readProcessTable?: () => Promise<RuntimeProcessTableRow[]>;
  killPids?: (pids: number[]) => Promise<void>;
}

export class CliRuntimeProcessSweepError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CliRuntimeProcessSweepError";
  }
}

export function matchRuntimeProcessArgs(runtimeId: string | null | undefined, args: string): boolean {
  const descriptor = runtimeId ? findCliRuntimeDescriptor(runtimeId) : null;
  if (!descriptor) return false;
  if (cliProcessSweepExclusionPatterns.some((pattern) => pattern.test(args))) return false;
  if (args.includes(descriptor.commandName)) return true;
  return new RegExp(`\\b${descriptor.key}\\b`).test(args);
}

export async function readDefaultProcessTable(): Promise<RuntimeProcessTableRow[]> {
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-eo", "pid=,args="],
    {
      env: {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8"
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15_000
    }
  );
  const rows: RuntimeProcessTableRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && match[2] !== undefined) rows.push({ pid: Number(match[1]), args: match[2] });
  }
  return rows;
}

export async function countRuntimeProcesses(
  runtimeId: CliToggleRuntimeId,
  options: RuntimeProcessSweeperOptions = {}
): Promise<number> {
  const readProcessTable = options.readProcessTable ?? readDefaultProcessTable;
  const rows = await readProcessTable();
  return rows.filter((row) => matchRuntimeProcessArgs(runtimeId, row.args)).length;
}

export async function sweepRuntimeProcesses(
  runtimeId: CliToggleRuntimeId,
  options: RuntimeProcessSweeperOptions = {}
): Promise<RuntimeProcessSweepResult> {
  const readProcessTable = options.readProcessTable ?? readDefaultProcessTable;
  const killPids = options.killPids ?? killPidsViaBroker;

  const rows = await readProcessTable();
  const matchedPids = rows
    .filter((row) => matchRuntimeProcessArgs(runtimeId, row.args))
    .map((row) => row.pid)
    .sort((left, right) => left - right);
  if (matchedPids.length === 0) {
    return { matchedPids: [], killedPids: [], remainingPids: [] };
  }

  let sweepFailure: Error | null = null;
  try {
    await killPids(matchedPids);
  } catch (error) {
    sweepFailure = error instanceof Error ? error : new Error("CLI runtime process sweep failed.");
  }

  const afterRows = await readProcessTable();
  const stillMatched = new Set(
    afterRows
      .filter((row) => matchRuntimeProcessArgs(runtimeId, row.args))
      .map((row) => row.pid)
  );
  const killedPids = matchedPids.filter((pid) => !stillMatched.has(pid));
  const remainingPids = matchedPids.filter((pid) => stillMatched.has(pid));

  if (sweepFailure) {
    throw new CliRuntimeProcessSweepError(
      "CLI_PROCESS_SWEEP_FAILED",
      `The protected CLI process sweep could not complete: ${sweepFailure.message}`
    );
  }

  return { matchedPids, killedPids, remainingPids };
}

async function killPidsViaBroker(pids: number[]): Promise<void> {
  const { stdout } = await execFileAsync(
    sweepCommand,
    ["-n", sweepExecutable, "kill", pids.join(",")],
    {
      env: {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8"
      },
      maxBuffer: 64 * 1024,
      timeout: sweepTimeoutMs
    }
  );
  const parsed = parseBrokerResult(stdout);
  if (!parsed || parsed.accepted !== true) {
    throw new CliRuntimeProcessSweepError(
      "CLI_PROCESS_SWEEP_REJECTED",
      "The protected CLI process sweep broker rejected the kill request."
    );
  }
}

function parseBrokerResult(stdout: string): { accepted: boolean } | null {
  try {
    const value = JSON.parse(stdout);
    if (value !== null && typeof value === "object" && typeof value.accepted === "boolean") {
      return { accepted: value.accepted };
    }
    return null;
  } catch {
    return null;
  }
}