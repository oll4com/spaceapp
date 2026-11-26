import { describe, expect, it, vi } from "vitest";
import { CLI_VPN_INSPECTION_CACHE_MS, CLI_VPN_INSPECTION_STALE_MS, CliVpnBrokerClient, type CliVpnInspectionResult } from "../src/cli-vpn.js";

const result = { selectedRoute: "direct", runtimes: [] } as unknown as CliVpnInspectionResult;
const harness = (pids: number[]) => [{ runtimeId: "cli:harness" as const, pids }];

function fixture() {
  let now = 1_000_000;
  const execute = vi.fn(async () => "{}");
  const client = new CliVpnBrokerClient(execute, () => now);
  const inspect = vi.spyOn(client, "inspectRuntimes").mockResolvedValue(result);
  return { client, inspect, execute, advance: (ms: number) => { now += ms; } };
}

describe("CLI VPN status inspection cache", () => {
  it("shares one broker inspection per runtime/pid set within the window", async () => {
    const { client, inspect, advance } = fixture();
    await Promise.all([client.inspectRuntimesCached(harness([2, 1])), client.inspectRuntimesCached(harness([1, 2]))]);
    advance(CLI_VPN_INSPECTION_CACHE_MS - 1);
    await client.inspectRuntimesCached(harness([1, 2]));
    expect(inspect).toHaveBeenCalledTimes(1);

    await client.inspectRuntimesCached(harness([3]));
    expect(inspect).toHaveBeenCalledTimes(2);

    advance(1);
    await client.inspectRuntimesCached(harness([1, 2]));
    expect(inspect).toHaveBeenCalledTimes(3);
  });

  it("drops cached inspections before any mutating broker action runs", async () => {
    const { client, inspect, execute } = fixture();
    await client.inspectRuntimesCached(harness([1]));
    await client.removeProfile("mullvad").catch(() => undefined);
    expect(execute).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(["remove-profile", "mullvad"]), "");
    await client.inspectRuntimesCached(harness([1]));
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("keeps read-only status calls from invalidating and never caches failures", async () => {
    const { client, inspect } = fixture();
    await client.inspectRuntimesCached(harness([1]));
    await client.status().catch(() => undefined);
    await client.inspectRuntimesCached(harness([1]));
    expect(inspect).toHaveBeenCalledTimes(1);

    client.invalidateInspections();
    inspect.mockRejectedValueOnce(new Error("broker down"));
    await expect(client.inspectRuntimesCached(harness([1]))).rejects.toThrow("broker down");
    await expect(client.inspectRuntimesCached(harness([1]))).resolves.toBe(result);
    expect(inspect).toHaveBeenCalledTimes(3);
  });

  it("does not keep a result that was in flight when a mutation started", async () => {
    const { client, inspect } = fixture();
    let release!: (value: CliVpnInspectionResult) => void;
    inspect.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = client.inspectRuntimesCached(harness([1]));
    await Promise.resolve(); // the shared cache starts its load on the next microtask
    client.invalidateInspections();
    release(result);
    await pending;
    await client.inspectRuntimesCached(harness([1]));
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("serves the last settled inspection while a slow broker refresh runs, and waits once it is too old", async () => {
    const { client, inspect, advance } = fixture();
    await client.inspectRuntimesCached(harness([1]));
    const fresh = { ...result } as CliVpnInspectionResult;
    let release!: (value: CliVpnInspectionResult) => void;
    inspect.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    advance(CLI_VPN_INSPECTION_CACHE_MS);
    // The broker waits behind a launch's lock: both readers get the previous answer at once and share one refresh.
    await expect(client.inspectRuntimesCached(harness([1]))).resolves.toBe(result);
    await expect(client.inspectRuntimesCached(harness([1]))).resolves.toBe(result);
    expect(inspect).toHaveBeenCalledTimes(2);

    advance(CLI_VPN_INSPECTION_STALE_MS - CLI_VPN_INSPECTION_CACHE_MS);
    const waiting = client.inspectRuntimesCached(harness([1]));
    release(fresh);
    await expect(waiting).resolves.toBe(fresh);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("keeps the last settled inspection when a background refresh fails, and never one from before a mutation", async () => {
    const { client, inspect, advance } = fixture();
    await client.inspectRuntimesCached(harness([1]));
    advance(CLI_VPN_INSPECTION_CACHE_MS);
    inspect.mockRejectedValueOnce(new Error("lock timeout"));
    await expect(client.inspectRuntimesCached(harness([1]))).resolves.toBe(result);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(client.inspectRuntimesCached(harness([1]))).resolves.toBe(result);
    expect(inspect).toHaveBeenCalledTimes(3);

    advance(CLI_VPN_INSPECTION_CACHE_MS);
    await client.removeProfile("mullvad").catch(() => undefined);
    const after = { ...result } as CliVpnInspectionResult;
    inspect.mockResolvedValueOnce(after);
    await expect(client.inspectRuntimesCached(harness([1]))).resolves.toBe(after);
  });
});
