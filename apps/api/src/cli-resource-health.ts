import { readFile } from "node:fs/promises";
import type { SystemHealthService } from "@space/contracts";
import { z } from "zod";

const stateSchema = z.object({
  version: z.literal(1), sampledAt: z.number().finite().nonnegative(),
  status: z.enum(["PROTECTED", "DEGRADED", "DISABLED"]),
  protectedCount: z.number().int().nonnegative().optional(),
  limitedCount: z.number().int().nonnegative().optional(),
  sessions: z.array(z.object({
    cliSessionId: z.string().regex(/^cli_session:[A-Za-z0-9_-]{1,100}$/),
    paneId: z.string().regex(/^pane:[A-Za-z0-9_-]{1,100}$/),
    runtimeId: z.string().regex(/^cli:[a-z0-9_-]{1,50}$/),
    mode: z.enum(["NORMAL", "LIMITED"]),
  })).max(128),
});
type Health = Omit<SystemHealthService, "id" | "label" | "checkedAt">;

export async function cliResourceHealth(
  read: () => Promise<string> = () => readFile("/run/space-cli-resource-guard/status.json", "utf8"),
  now = Date.now(),
): Promise<Health> {
  try {
    const raw = await read();
    if (raw.length > 256 * 1024) throw new Error("oversized");
    const state = stateSchema.parse(JSON.parse(raw));
    const age = now - state.sampledAt * 1000;
    if (age < -5000 || age > 20_000) throw new Error("stale");
    if (state.status !== "PROTECTED") return {
      status: "critical", detail: "CLI resource protection is incomplete or disabled. Existing tasks were not stopped.", values: [],
    };
    const limited = state.sessions.filter(s => s.mode === "LIMITED");
    const limitedCount = state.limitedCount ?? limited.length;
    return {
      status: limitedCount ? "warning" : "healthy",
      detail: limitedCount
        ? `${limitedCount} CLI task(s) are being limited to keep Space responsive. Tasks remain running.`
        : "CLI tasks have separate CPU, disk-write and memory-pressure limits. New tasks are covered within 5 seconds.",
      values: [{ label: "Protected tasks", value: String(state.protectedCount ?? state.sessions.length) },
        ...limited.slice(0, 10).map(s => ({ label: "Limited task", value: `${s.runtimeId} · ${s.paneId}` }))],
    };
  } catch {
    return { status: "unavailable", detail: "CLI resource protection could not be verified. Monitoring is missing, stale or invalid.", values: [] };
  }
}
