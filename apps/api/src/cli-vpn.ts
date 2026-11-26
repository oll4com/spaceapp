import { execInHelper, spawn } from "./safe-child-process.js";
import { z } from "zod";
import {
  cliToggleRuntimeIds,
  cliEgressRouteIdSchema,
  cliVpnProfileIdSchema,
  cliVpnConnectionSchema,
  replaceCliVpnProfileInputSchema,
  type CliEgressRouteId,
  type CliVpnProfileId,
  type CliVpnConnection
} from "@space/contracts";
import { SPACE_INSTALL_ROOT } from "@space/contracts";
import { createStaleWhileRevalidateCache, type StaleWhileRevalidateCache } from "./stale-while-revalidate.js";

const brokerCommand = "/usr/bin/sudo";
const brokerExecutable = `${SPACE_INSTALL_ROOT}/bin/space-cli-vpn-broker`;
const cliVpnManagedRuntimeIds = [...cliToggleRuntimeIds, "cli:harness"] as const;
const cliVpnManagedRuntimeIdSchema = z.enum(cliVpnManagedRuntimeIds);
export type CliVpnManagedRuntimeId = z.infer<typeof cliVpnManagedRuntimeIdSchema>;
const brokerRouteResultSchema = z
  .object({
    mode: z.enum(["direct", "vpn"]),
    isolatedPids: z.array(z.number().int().positive()).max(10_000),
    legacyPids: z.array(z.number().int().positive()).max(10_000),
    connection: cliVpnConnectionSchema
  })
  .strict();
const brokerRuntimeInspectionSchema = brokerRouteResultSchema.pick({
  mode: true,
  isolatedPids: true,
  legacyPids: true
}).extend({
  runtimeId: cliVpnManagedRuntimeIdSchema,
  routeId: cliEgressRouteIdSchema.optional()
}).strict();
const brokerInspectionResultSchema = z
  .object({
    connection: cliVpnConnectionSchema,
    selectedRoute: cliEgressRouteIdSchema,
    directEgressIpv4: z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}$/).nullable(),
    removedProfiles: z.array(cliVpnProfileIdSchema).max(4),
    profiles: z.object({
      greece: cliVpnConnectionSchema,
      thailand: cliVpnConnectionSchema,
      mullvad: cliVpnConnectionSchema,
      nord: cliVpnConnectionSchema
    }).strict(),
    runtimes: z.array(brokerRuntimeInspectionSchema).max(cliVpnManagedRuntimeIds.length)
  })
  .strict();
const brokerGlobalRouteResultSchema = brokerInspectionResultSchema.omit({ connection: true }).extend({
  runtimes: z.array(z.object({
    runtimeId: cliVpnManagedRuntimeIdSchema,
    routeId: cliEgressRouteIdSchema,
    isolatedPids: z.array(z.number().int().positive()).max(10_000),
    legacyPids: z.array(z.number().int().positive()).max(10_000)
  }).strict()).max(cliVpnManagedRuntimeIds.length)
}).strict();
const brokerErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(80).regex(/^[A-Z0-9_]+$/),
    message: z.string().trim().min(1).max(500)
  })
  .strict();

export class CliVpnError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "CliVpnError";
  }
}

export interface CliVpnRouteResult {
  mode: "direct" | "vpn";
  isolatedPids: number[];
  legacyPids: number[];
  connection: CliVpnConnection;
}

export interface CliVpnRuntimeInspection extends Omit<CliVpnRouteResult, "connection"> {
  runtimeId: CliVpnManagedRuntimeId;
  routeId?: CliEgressRouteId;
}

export interface CliVpnInspectionResult {
  connection: CliVpnConnection;
  selectedRoute: CliEgressRouteId;
  directEgressIpv4: string | null;
  removedProfiles: CliVpnProfileId[];
  profiles: Record<CliVpnProfileId, CliVpnConnection>;
  runtimes: CliVpnRuntimeInspection[];
}

export interface CliVpnGlobalRouteResult {
  selectedRoute: CliEgressRouteId;
  directEgressIpv4: string | null;
  removedProfiles: CliVpnProfileId[];
  profiles: Record<CliVpnProfileId, CliVpnConnection>;
  runtimes: Array<{
    runtimeId: CliVpnManagedRuntimeId;
    routeId: CliEgressRouteId;
    isolatedPids: number[];
    legacyPids: number[];
  }>;
}

export interface CliVpnBroker {
  status(): Promise<CliVpnConnection>;
  replace(config: string): Promise<CliVpnConnection>;
  verify(): Promise<CliVpnConnection>;
  remove(): Promise<CliVpnConnection>;
  replaceProfile(profileId: CliVpnProfileId, config: string): Promise<CliVpnConnection>;
  verifyProfile(profileId: CliVpnProfileId): Promise<CliVpnConnection>;
  removeProfile(profileId: CliVpnProfileId): Promise<CliVpnConnection>;
  rotateMullvadCity(): Promise<CliVpnConnection>;
  rotateNordCity(): Promise<CliVpnConnection>;
  setGlobalRoute(
    routeId: CliEgressRouteId,
    runtimes: Array<{ runtimeId: CliVpnManagedRuntimeId; pids: number[] }>
  ): Promise<CliVpnGlobalRouteResult>;
  inspectRuntimes(runtimes: Array<{ runtimeId: CliVpnManagedRuntimeId; pids: number[] }>): Promise<CliVpnInspectionResult>;
  /** Short-lived shared inspection for status displays only (never for isolation gates). */
  inspectRuntimesCached?(runtimes: Array<{ runtimeId: CliVpnManagedRuntimeId; pids: number[] }>): Promise<CliVpnInspectionResult>;
  setRuntime(runtimeId: CliVpnManagedRuntimeId, enabled: boolean, pids: number[]): Promise<CliVpnRouteResult>;
  /** Re-measures this server's and every configured VPN's exit IP and reconnects a VPN that stopped answering (app.ts schedules it). */
  refreshEgress?(): Promise<void>;
}

export type CliVpnBrokerExecutor = (command: string, args: string[], stdin: string) => Promise<string>;

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function brokerStatus(code: string): number {
  if (code === "INVALID_CONFIG") return 422;
  if (code === "NOT_CONFIGURED" || code === "VPN_NOT_READY" || code === "VPN_IN_USE") return 409;
  if (code === "TOOLING_UNAVAILABLE" || code === "NETWORK_UNAVAILABLE") return 503;
  return 502;
}

function brokerRejection(stderr: string, stdout: string): CliVpnError {
  const safeFailure = brokerErrorSchema.safeParse(safeJson(stderr || stdout));
  return safeFailure.success
    ? new CliVpnError(safeFailure.data.code, safeFailure.data.message, brokerStatus(safeFailure.data.code))
    : new CliVpnError("BROKER_FAILED", "The protected CLI VPN broker rejected the request.", 502);
}

// Read-only broker actions; any other action may change routes or profiles.
const readOnlyBrokerActions = new Set(["status", "egress-status"]);
const brokerEnv = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };

/** `args` is sudo's: -n, the broker, its action. Exported for its test. */
export async function executeBroker(command: string, args: string[], stdin: string): Promise<string> {
  // The polled read-only actions run in the exec helper, not in a fork of the API (docs/agents/server-cpu.md); the others stay
  // here, so a profile's config never crosses to it.
  const helped = readOnlyBrokerActions.has(args[2] ?? "")
    ? execInHelper(command, args, { env: brokerEnv, timeout: 90_000, killSignal: "SIGKILL", maxBuffer: 65_536, input: stdin })
    : null;
  if (helped) {
    const { error, stdout, stderr } = await helped;
    if (!error) return String(stdout);
    if (error.killed && error.code == null) throw new CliVpnError("BROKER_TIMEOUT", "CLI VPN verification timed out.", 504);
    // A number is the broker's exit status; more output than a status ever has is a rejection too.
    if (typeof error.code === "number" || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw brokerRejection(String(stderr), String(stdout));
    throw new CliVpnError("BROKER_FAILED", "The protected CLI VPN broker could not start.", 503);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: brokerEnv, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 90_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 65_536) stdout += chunk.slice(0, 65_536 - stdout.length);
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk.slice(0, 16_384 - stderr.length);
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new CliVpnError("BROKER_FAILED", "The protected CLI VPN broker could not start.", 503));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new CliVpnError("BROKER_TIMEOUT", "CLI VPN verification timed out.", 504));
        return;
      }
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(brokerRejection(stderr, stdout));
    });
    child.stdin.end(stdin);
  });
}

/** Status displays poll egress-status (sudo) every few seconds; share it this long. */
export const CLI_VPN_INSPECTION_CACHE_MS = 15_000;
/**
 * A status display may show the last settled inspection this long while one refresh runs behind it: egress-status waits for the
 * broker lock, up to 30 s behind a CLI launch (34 of 892 calls took 87% of the broker time, 2026-11-21). Older than this, callers wait.
 */
export const CLI_VPN_INSPECTION_STALE_MS = 60_000;

export class CliVpnBrokerClient {
  private readonly inspections: StaleWhileRevalidateCache<CliVpnInspectionResult>;

  constructor(
    private readonly execute: CliVpnBrokerExecutor = executeBroker,
    now: () => number = Date.now
  ) {
    // 64 keys: one per polled runtime/pid set; an evicted set is inspected again on its next read.
    this.inspections = createStaleWhileRevalidateCache({
      freshMs: CLI_VPN_INSPECTION_CACHE_MS, maxAgeMs: CLI_VPN_INSPECTION_STALE_MS, maxEntries: 64, now
    });
  }

  private async run(action: string, args: string[] = [], stdin = ""): Promise<unknown> {
    if (!readOnlyBrokerActions.has(action)) this.invalidateInspections();
    const output = await this.execute(brokerCommand, ["-n", brokerExecutable, action, ...args], stdin);
    const parsed = safeJson(output);
    if (parsed === null) throw new CliVpnError("BROKER_FAILED", "The CLI VPN broker returned invalid output.", 502);
    return parsed;
  }

  async status(): Promise<CliVpnConnection> {
    return cliVpnConnectionSchema.parse(await this.run("status"));
  }

  async replace(config: string): Promise<CliVpnConnection> {
    const parsed = replaceCliVpnProfileInputSchema.parse({ config });
    return cliVpnConnectionSchema.parse(await this.run("replace", [], parsed.config));
  }

  async verify(): Promise<CliVpnConnection> {
    return cliVpnConnectionSchema.parse(await this.run("verify"));
  }

  async refreshEgress(): Promise<void> {
    await this.run("refresh-egress");
  }

  async remove(): Promise<CliVpnConnection> {
    return cliVpnConnectionSchema.parse(await this.run("remove"));
  }

  async replaceProfile(profileId: CliVpnProfileId, config: string): Promise<CliVpnConnection> {
    const parsedProfileId = cliVpnProfileIdSchema.parse(profileId);
    const parsed = replaceCliVpnProfileInputSchema.parse({ config });
    return cliVpnConnectionSchema.parse(await this.run("replace-profile", [parsedProfileId], parsed.config));
  }

  async verifyProfile(profileId: CliVpnProfileId): Promise<CliVpnConnection> {
    return cliVpnConnectionSchema.parse(await this.run("verify-profile", [cliVpnProfileIdSchema.parse(profileId)]));
  }

  async removeProfile(profileId: CliVpnProfileId): Promise<CliVpnConnection> {
    return cliVpnConnectionSchema.parse(await this.run("remove-profile", [cliVpnProfileIdSchema.parse(profileId)]));
  }

  async rotateMullvadCity(): Promise<CliVpnConnection> {
    return cliVpnConnectionSchema.parse(await this.run("rotate-mullvad-city"));
  }

  async rotateNordCity(): Promise<CliVpnConnection> {
    return cliVpnConnectionSchema.parse(await this.run("rotate-nord-city"));
  }

  async inspectRuntimes(
    runtimes: Array<{ runtimeId: CliVpnManagedRuntimeId; pids: number[] }>
  ): Promise<CliVpnInspectionResult> {
    const payload = runtimes.slice(0, cliVpnManagedRuntimeIds.length).map((runtime) => ({
      runtimeId: cliVpnManagedRuntimeIdSchema.parse(runtime.runtimeId),
      pids: runtime.pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0).slice(0, 10_000)
    }));
    return brokerInspectionResultSchema.parse(await this.run(
      "egress-status",
      [],
      JSON.stringify({ runtimes: payload })
    ));
  }

  /**
   * Same result as inspectRuntimes, shared for CLI_VPN_INSPECTION_CACHE_MS per
   * identical runtime/pid set, then served stale (up to CLI_VPN_INSPECTION_STALE_MS)
   * while one refresh runs. Only for status displays: isolation checks that
   * gate a launch must call inspectRuntimes directly. Every mutating broker
   * action drops the cache, also before it runs; failures are never kept.
   */
  inspectRuntimesCached(
    runtimes: Array<{ runtimeId: CliVpnManagedRuntimeId; pids: number[] }>
  ): Promise<CliVpnInspectionResult> {
    const key = JSON.stringify(runtimes.map((runtime) => [runtime.runtimeId, [...runtime.pids].sort((a, b) => a - b)]));
    return this.inspections.get(key, () => this.inspectRuntimes(runtimes));
  }

  invalidateInspections(): void {
    // Also detaches a refresh in flight: a result read before the mutation is never stored.
    this.inspections.invalidate();
  }

  async setGlobalRoute(
    routeId: CliEgressRouteId,
    runtimes: Array<{ runtimeId: CliVpnManagedRuntimeId; pids: number[] }>
  ): Promise<CliVpnGlobalRouteResult> {
    const payload = runtimes.slice(0, cliVpnManagedRuntimeIds.length).map((runtime) => ({
      runtimeId: cliVpnManagedRuntimeIdSchema.parse(runtime.runtimeId),
      pids: runtime.pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0).slice(0, 10_000)
    }));
    return brokerGlobalRouteResultSchema.parse(await this.run(
      "set-global-route",
      [cliEgressRouteIdSchema.parse(routeId)],
      JSON.stringify({ runtimes: payload })
    ));
  }

  async setRuntime(
    runtimeId: CliVpnManagedRuntimeId,
    enabled: boolean,
    pids: number[]
  ): Promise<CliVpnRouteResult> {
    const parsedRuntimeId = cliVpnManagedRuntimeIdSchema.parse(runtimeId);
    const boundedPids = pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0).slice(0, 10_000);
    return brokerRouteResultSchema.parse(await this.run(
      "set-runtime",
      [parsedRuntimeId, enabled ? "vpn" : "direct"],
      JSON.stringify({ pids: boundedPids })
    ));
  }
}
