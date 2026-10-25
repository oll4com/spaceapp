import { describe, expect, it, vi } from "vitest";
import { CLI_VPN_INSPECTION_CACHE_MS, CliVpnBrokerClient, type CliVpnInspectionResult } from "../src/cli-vpn.js";

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
    client.invalidateInspections();
    release(result);
    await pending;
    await client.inspectRuntimesCached(harness([1]));
    expect(inspect).toHaveBeenCalledTimes(2);
  });
});
