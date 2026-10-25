import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProfileUsage } from "@space/contracts";
import { createCliAccountBalancer } from "../src/cli-account-balancer.js";

const usage = (remainingPercent: number | null, resetAt: string | null = null, status: CliProfileUsage["status"] = remainingPercent === null ? "UNKNOWN" : "OK"): CliProfileUsage =>
  ({ status, plan: null, remainingPercent, resetAt, windows: remainingPercent === null ? [] : [{ id: "chat", label: "Chat", remainingPercent, resetAt }] });

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

function setup(usages: Record<string, CliProfileUsage>, statePath: string | null = null) {
  let clock = Date.parse("2026-10-12T12:00:00.000Z");
  const readUsage = vi.fn(async (_runtimeId: string, profileId: string) => usages[profileId]!);
  const balancer = createCliAccountBalancer({
    statePath, now: () => clock, readUsage,
    listProfiles: async () => Object.keys(usages).map((profileId) => ({ profileId, displayName: profileId.toUpperCase() }))
  });
  return { balancer, readUsage, advance: (ms: number) => { clock += ms; } };
}

describe("CLI account balancer (session-level Auto)", () => {
  it("picks the account with the most room and never the gateway, a disconnected or an empty one", async () => {
    const { balancer } = setup({ main: usage(40), work: usage(90), empty: usage(0), "space-gateway": usage(null, null, "GATEWAY"),
      new: usage(null, null, "NOT_CONNECTED"), cursorlike: usage(null) });
    const balance = await balancer.balance("cli:copilot");
    expect(balance.next).toBe("work");
    expect(balance.profiles.filter((profile) => profile.available).map((profile) => profile.profileId).sort()).toEqual(["cursorlike", "main", "work"]);
    expect(await balancer.pick("cli:copilot", ["work"])).toBe("cursorlike");
    expect(await balancer.pick("cli:copilot", ["work", "cursorlike"])).toBe("main");
  });

  it("lets equal accounts take turns", async () => {
    const { balancer } = setup({ a: usage(null), b: usage(null), c: usage(null) });
    const picks = [await balancer.pick("cli:cursor"), await balancer.pick("cli:cursor"), await balancer.pick("cli:cursor")];
    expect(new Set(picks).size).toBe(3);
  });

  it("skips an exhausted account until its provider's reset, or for an hour without one", async () => {
    const { balancer, advance } = setup({ a: usage(80, "2026-11-01T00:00:00.000Z"), b: usage(null) });
    expect((await balancer.markExhausted("cli:copilot", "a")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect((await balancer.markExhausted("cli:copilot", "b")).toISOString()).toBe("2026-10-12T13:00:00.000Z");
    expect(await balancer.pick("cli:copilot")).toBeNull();
    advance(60 * 60_000 + 1);
    expect(await balancer.pick("cli:copilot")).toBe("b");
    expect((await balancer.balance("cli:copilot")).profiles.find((profile) => profile.profileId === "a")?.exhaustedUntil).toBe("2026-11-01T00:00:00.000Z");
  });

  it("caches usage for five minutes and reports a failed read as an error", async () => {
    const { balancer, readUsage, advance } = setup({ a: usage(70) });
    await balancer.balance("cli:copilot");
    await balancer.balance("cli:copilot");
    expect(readUsage).toHaveBeenCalledTimes(1);
    advance(5 * 60_000);
    readUsage.mockRejectedValueOnce(new Error("wrapper failed"));
    const balance = await balancer.balance("cli:copilot");
    expect(balance.profiles[0]).toMatchObject({ available: false, usage: { status: "ERROR" } });
  });

  it("keeps Auto panes and exhaustion marks across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-balancer-"));
    directories.push(directory);
    const statePath = join(directory, "nested", "state.json");
    const first = setup({ a: usage(null), b: usage(null) }, statePath);
    await first.balancer.setAuto("pane:one", "cli:cursor");
    await first.balancer.markExhausted("cli:cursor", "a");
    expect(JSON.parse(await readFile(statePath, "utf8")).autoPanes).toEqual({ "pane:one": "cli:cursor" });
    const second = setup({ a: usage(null), b: usage(null) }, statePath);
    expect(await second.balancer.isAuto("pane:one")).toBe(true);
    expect(await second.balancer.pick("cli:cursor")).toBe("b");
    await second.balancer.setAuto("pane:one", null);
    expect(await second.balancer.autoPanes()).toEqual({});
  });
});
