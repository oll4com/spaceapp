import { spawn } from "node:child_process";
import { z } from "zod";
import {
  cliToggleRuntimeIdSchema,
  cliEgressRouteIdSchema,
  cliVpnProfileIdSchema,
  cliVpnConnectionSchema,
  replaceCliVpnProfileInputSchema,
  type CliToggleRuntimeId,
  type CliEgressRouteId,
  type CliVpnProfileId,
  type CliVpnConnection
} from "@space/contracts";

const brokerCommand = "/usr/bin/sudo";
const brokerExecutable = "/opt/spaceapp/bin/space-cli-vpn-broker";
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
  runtimeId: cliToggleRuntimeIdSchema,
  routeId: cliEgressRouteIdSchema.optional()
}).strict();
const brokerInspectionResultSchema = z
  .object({
    connection: cliVpnConnectionSchema,
    selectedRoute: cliEgressRouteIdSchema,
    directEgressIpv4: z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}$/).nullable(),
    removedProfiles: z.array(cliVpnProfileIdSchema).max(3),
    profiles: z.object({
      greece: cliVpnConnectionSchema,
      thailand: cliVpnConnectionSchema,
      mullvad: cliVpnConnectionSchema
    }).strict(),
    runtimes: z.array(brokerRuntimeInspectionSchema).max(11)
  })
  .strict();
const brokerGlobalRouteResultSchema = brokerInspectionResultSchema.omit({ connection: true }).extend({
  runtimes: z.array(z.object({
    runtimeId: cliToggleRuntimeIdSchema,
    routeId: cliEgressRouteIdSchema,
    isolatedPids: z.array(z.number().int().positive()).max(10_000),
    legacyPids: z.array(z.number().int().positive()).max(10_000)
  }).strict()).max(11)
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
  runtimeId: CliToggleRuntimeId;
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
    runtimeId: CliToggleRuntimeId;
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
  setGlobalRoute(
    routeId: CliEgressRouteId,
    runtimes: Array<{ runtimeId: CliToggleRuntimeId; pids: number[] }>
  ): Promise<CliVpnGlobalRouteResult>;
  inspectRuntimes(runtimes: Array<{ runtimeId: CliToggleRuntimeId; pids: number[] }>): Promise<CliVpnInspectionResult>;
  setRuntime(runtimeId: CliToggleRuntimeId, enabled: boolean, pids: number[]): Promise<CliVpnRouteResult>;
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

async function executeBroker(command: string, args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8"
      },
      windowsHide: true
    });
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
      const safeFailure = brokerErrorSchema.safeParse(safeJson(stderr || stdout));
      if (safeFailure.success) {
        reject(new CliVpnError(
          safeFailure.data.code,
          safeFailure.data.message,
          brokerStatus(safeFailure.data.code)
        ));
        return;
      }
      reject(new CliVpnError("BROKER_FAILED", "The protected CLI VPN broker rejected the request.", 502));
    });
    child.stdin.end(stdin);
  });
}

export class CliVpnBrokerClient {
  constructor(private readonly execute: CliVpnBrokerExecutor = executeBroker) {}

  private async run(action: string, args: string[] = [], stdin = ""): Promise<unknown> {
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

  async inspectRuntimes(
    runtimes: Array<{ runtimeId: CliToggleRuntimeId; pids: number[] }>
  ): Promise<CliVpnInspectionResult> {
    const payload = runtimes.slice(0, 11).map((runtime) => ({
      runtimeId: cliToggleRuntimeIdSchema.parse(runtime.runtimeId),
      pids: runtime.pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0).slice(0, 10_000)
    }));
    return brokerInspectionResultSchema.parse(await this.run(
      "egress-status",
      [],
      JSON.stringify({ runtimes: payload })
    ));
  }

  async setGlobalRoute(
    routeId: CliEgressRouteId,
    runtimes: Array<{ runtimeId: CliToggleRuntimeId; pids: number[] }>
  ): Promise<CliVpnGlobalRouteResult> {
    const payload = runtimes.slice(0, 11).map((runtime) => ({
      runtimeId: cliToggleRuntimeIdSchema.parse(runtime.runtimeId),
      pids: runtime.pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0).slice(0, 10_000)
    }));
    return brokerGlobalRouteResultSchema.parse(await this.run(
      "set-global-route",
      [cliEgressRouteIdSchema.parse(routeId)],
      JSON.stringify({ runtimes: payload })
    ));
  }

  async setRuntime(
    runtimeId: CliToggleRuntimeId,
    enabled: boolean,
    pids: number[]
  ): Promise<CliVpnRouteResult> {
    const parsedRuntimeId = cliToggleRuntimeIdSchema.parse(runtimeId);
    const boundedPids = pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0).slice(0, 10_000);
    return brokerRouteResultSchema.parse(await this.run(
      "set-runtime",
      [parsedRuntimeId, enabled ? "vpn" : "direct"],
      JSON.stringify({ pids: boundedPids })
    ));
  }
}
