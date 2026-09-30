import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  systemServicesResponseSchema,
  type SystemServiceUnit,
  type SystemServicesResponse
} from "@space/contracts";

const execFileAsync = promisify(execFile);

export const SPACE_SERVICE_UNIT_PREFIXES = [
  "space-",
  "codex-",
  "vm207-",
  "mc-browser-proxy",
  "promtail",
  "pulseaudio"
] as const;

export const SYSTEM_SERVICES_COMMAND = {
  command: "/usr/bin/systemctl",
  args: [] as const
};

export type SystemServicesRunner = () => Promise<SystemServicesResponse>;

const cacheTtlMs = 10_000;

function matchesSpaceService(unit: string): boolean {
  return SPACE_SERVICE_UNIT_PREFIXES.some((prefix) => unit.startsWith(prefix));
}

function safeDescription(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
}

function parseTimestampToIso(value: unknown): string | null {
  if (value === null || value === undefined || value === 0 || value === "0") return null;
  if (typeof value === "number") {
    const ms = value > 1e14 ? Math.floor(value / 1000) : value;
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "n/a" || trimmed === "-" || trimmed === "0") return null;
    const asNum = Number(trimmed);
    if (!Number.isNaN(asNum) && asNum > 0) {
      const ms = asNum > 1e14 ? Math.floor(asNum / 1000) : asNum;
      return new Date(ms).toISOString();
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

function parseSystemctlUnits(raw: string): Map<string, Pick<SystemServiceUnit, "unit" | "description" | "type" | "loadState" | "activeState" | "subState">> {
  const units = new Map<string, Pick<SystemServiceUnit, "unit" | "description" | "type" | "loadState" | "activeState" | "subState">>();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return units;
  }
  if (!Array.isArray(payload)) return units;
  for (const item of payload) {
    if (!item || typeof item !== "object") continue;
    const record = item as { unit?: unknown; description?: unknown; load?: unknown; active?: unknown; sub?: unknown };
    if (typeof record.unit !== "string" || !record.unit.trim()) continue;
    const type = record.unit.endsWith(".timer") ? "timer" : record.unit.endsWith(".service") ? "service" : null;
    if (!type) continue;
    units.set(record.unit, {
      unit: record.unit,
      description: safeDescription(record.description),
      type,
      loadState: typeof record.load === "string" && record.load ? record.load : "loaded",
      activeState: typeof record.active === "string" && record.active ? record.active : "inactive",
      subState: typeof record.sub === "string" && record.sub ? record.sub : "dead"
    });
  }
  return units;
}

function parseSystemctlTimers(raw: string): Map<string, { activates: string | null; next: string | null; last: string | null }> {
  const timers = new Map<string, { activates: string | null; next: string | null; last: string | null }>();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return timers;
  }
  if (!Array.isArray(payload)) return timers;
  for (const item of payload) {
    if (!item || typeof item !== "object") continue;
    const record = item as { unit?: unknown; activates?: unknown; next?: unknown; last?: unknown };
    if (typeof record.unit !== "string" || !record.unit.endsWith(".timer")) continue;
    timers.set(record.unit, {
      activates: typeof record.activates === "string" && record.activates ? record.activates : null,
      next: parseTimestampToIso(record.next),
      last: parseTimestampToIso(record.last)
    });
  }
  return timers;
}

function parseSystemctlShowOrUnitFiles(raw: string): Map<string, string | null> {
  const states = new Map<string, string | null>();
  if (!raw.trim()) return states;
  try {
    const payload = JSON.parse(raw);
    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (!item || typeof item !== "object") continue;
        const record = item as { unit_file?: unknown; state?: unknown };
        if (typeof record.unit_file === "string" && record.unit_file) {
          states.set(record.unit_file, typeof record.state === "string" && record.state ? record.state : null);
        }
      }
      return states;
    }
  } catch {
    // Fall back to key=value parsing
  }
  let currentUnit: string | null = null;
  for (const line of raw.split("\n")) {
    const idMatch = /^Id=(\S+)$/.exec(line.trim());
    if (idMatch) {
      currentUnit = idMatch[1] ?? null;
      continue;
    }
    const stateMatch = /^UnitFileState=(.*)$/.exec(line.trim());
    if (stateMatch && currentUnit) {
      const value = (stateMatch[1] ?? "").trim();
      states.set(currentUnit, value || null);
    }
  }
  return states;
}

export async function runSystemServicesCollector(): Promise<SystemServicesResponse> {
  const sampledAt = new Date();
  const [unitsRaw, timersRaw, showRaw] = await Promise.all([
    execFileAsync(SYSTEM_SERVICES_COMMAND.command, [
      ...SYSTEM_SERVICES_COMMAND.args,
      "list-units",
      "--all",
      "--type=service,timer",
      "--output=json"
    ], { timeout: 8_000, maxBuffer: 2 * 1024 * 1024 }),
    execFileAsync(SYSTEM_SERVICES_COMMAND.command, [
      ...SYSTEM_SERVICES_COMMAND.args,
      "list-timers",
      "--all",
      "--output=json"
    ], { timeout: 8_000, maxBuffer: 2 * 1024 * 1024 }),
    execFileAsync(SYSTEM_SERVICES_COMMAND.command, [
      ...SYSTEM_SERVICES_COMMAND.args,
      "list-unit-files",
      "--all",
      "--type=service,timer",
      "--output=json"
    ], { timeout: 8_000, maxBuffer: 2 * 1024 * 1024 }).catch(() =>
      execFileAsync(SYSTEM_SERVICES_COMMAND.command, [
        ...SYSTEM_SERVICES_COMMAND.args,
        "show",
        "--all",
        "--property=Id,UnitFileState"
      ], { timeout: 8_000, maxBuffer: 2 * 1024 * 1024 }).catch(() => ({ stdout: "" }))
    )
  ]);
  const units = parseSystemctlUnits(String(unitsRaw.stdout));
  const timers = parseSystemctlTimers(String(timersRaw.stdout));
  const fileStates = parseSystemctlShowOrUnitFiles(String(showRaw.stdout));

  const matched = [...units.values()]
    .filter((unit) => matchesSpaceService(unit.unit))
    .sort((left, right) => left.unit.localeCompare(right.unit))
    .map((unit) => {
      const timer = timers.get(unit.unit);
      return systemServicesResponseSchema.shape.units.element.parse({
        ...unit,
        unitFileState: fileStates.get(unit.unit) ?? null,
        timerActivates: timer?.activates ?? null,
        timerNextElapse: timer?.next ?? null,
        timerLastTrigger: timer?.last ?? null
      });
    });

  const summary = {
    total: matched.length,
    active: matched.filter((unit) => unit.activeState === "active").length,
    inactive: matched.filter((unit) => unit.activeState === "inactive").length,
    failed: matched.filter((unit) => unit.activeState === "failed").length,
    services: matched.filter((unit) => unit.type === "service").length,
    timers: matched.filter((unit) => unit.type === "timer").length,
    enabled: matched.filter((unit) => unit.unitFileState === "enabled").length,
    disabled: matched.filter((unit) => unit.unitFileState === "disabled").length
  };

  return systemServicesResponseSchema.parse({ units: matched, summary, sampledAt: sampledAt.toISOString() });
}

export function createSystemServicesProvider(options: {
  collect: () => Promise<SystemServicesResponse>;
  now?: () => Date;
  cacheTtlMs?: number;
}): SystemServicesRunner {
  const now = options.now ?? (() => new Date());
  const ttlMs = Math.max(Math.trunc(options.cacheTtlMs ?? cacheTtlMs), 0);
  let cached: { value: SystemServicesResponse; expiresAtMs: number } | null = null;
  let inFlight: Promise<SystemServicesResponse> | null = null;
  return async () => {
    if (cached && cached.expiresAtMs > now().getTime()) return cached.value;
    if (inFlight) return inFlight;
    const request = options.collect().then((value) => {
      cached = { value, expiresAtMs: now().getTime() + ttlMs };
      return value;
    });
    inFlight = request;
    const clear = () => {
      if (inFlight === request) inFlight = null;
    };
    void request.then(clear, clear);
    return request;
  };
}

export async function resetFailedSystemUnits(unit?: string): Promise<{ success: boolean; reset: string }> {
  const target = unit && matchesSpaceService(unit) ? unit : "space-*";
  await execFileAsync("/usr/bin/sudo", ["-n", "/usr/bin/systemctl", "reset-failed", target], {
    timeout: 8_000,
    windowsHide: true
  });
  return { success: true, reset: target };
}
