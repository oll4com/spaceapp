import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { AgentRuntimeRegistry } from "@space/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  CLI_CREDENTIAL_STATUS_FRESH_MS,
  CLI_CREDENTIAL_STATUS_MISSING_FRESH_MS,
  createAgentRuntimeRegistryCache,
  createCliCredentialStatusCache,
  createCliRuntimeRegistryCache,
  findRuntime,
  invalidatesCliRuntimeCache,
  registerCliRuntimeCacheInvalidation,
  type CliCredentialStatus
} from "../src/cli-runtimes.js";
import { getApiConfig } from "../src/config.js";

describe("agent runtime registry cache", () => {
  it("shares one discovery until expiry and refreshes immediately after invalidation", async () => {
    let nowMs = 1_000;
    const registries = [
      { data: [], checkedAt: "2026-07-22T12:00:00.000Z" },
      { data: [], checkedAt: "2026-07-22T12:00:01.000Z" },
      { data: [], checkedAt: "2026-07-22T12:00:02.000Z" }
    ] satisfies AgentRuntimeRegistry[];
    const discover = vi.fn(async () => registries[discover.mock.calls.length - 1] as AgentRuntimeRegistry);
    const cache = createAgentRuntimeRegistryCache(discover, {
      ttlMs: 10_000,
      now: () => nowMs
    });

    const [first, concurrent] = await Promise.all([cache.read(), cache.read()]);
    expect(first).toBe(registries[0]);
    expect(concurrent).toBe(registries[0]);
    expect(discover).toHaveBeenCalledOnce();

    nowMs += 9_999;
    expect(await cache.read()).toBe(registries[0]);
    expect(discover).toHaveBeenCalledOnce();

    cache.invalidate();
    expect(await cache.read()).toBe(registries[1]);
    expect(discover).toHaveBeenCalledTimes(2);

    nowMs += 10_001;
    expect(await cache.read()).toBe(registries[2]);
    expect(discover).toHaveBeenCalledTimes(3);
  });

  it.each(["expiry", "invalidation"])("returns the last valid registry while %s refreshes", async (reason) => {
    let nowMs = 1_000;
    const first = { data: [], checkedAt: "2026-07-22T12:00:00.000Z" } satisfies AgentRuntimeRegistry;
    const refreshed = { data: [], checkedAt: "2026-07-22T12:00:01.000Z" } satisfies AgentRuntimeRegistry;
    let resolveRefresh!: (registry: AgentRuntimeRegistry) => void;
    const refresh = new Promise<AgentRuntimeRegistry>((resolve) => {
      resolveRefresh = resolve;
    });
    const discover = vi.fn()
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(refresh);
    const cache = createAgentRuntimeRegistryCache(discover, {
      ttlMs: 10_000,
      now: () => nowMs
    });

    expect(await cache.read()).toBe(first);
    if (reason === "expiry") nowMs += 10_001;
    else cache.invalidate();
    let freshCompleted = false;
    const fresh = cache.read().then((registry) => { freshCompleted = true; return registry; });

    expect(await cache.readStaleWhileRefreshing()).toBe(first);
    expect(freshCompleted).toBe(false);
    expect(discover).toHaveBeenCalledTimes(2);

    resolveRefresh(refreshed);
    expect(await fresh).toBe(refreshed);
    expect(await cache.read()).toBe(refreshed);
  });
});

describe("CLI credential status cache", () => {
  it("probes verified credentials at most once per freshness window and refreshes in the background", async () => {
    let nowMs = 0;
    const probe = vi.fn(async (): Promise<CliCredentialStatus | null> => "READY");
    const cache = createCliCredentialStatusCache({ probe, now: () => nowMs });

    await expect(Promise.all([cache.read("/bin/kimi"), cache.read("/bin/kimi")])).resolves.toEqual(["READY", "READY"]);
    expect(probe).toHaveBeenCalledOnce();

    nowMs = CLI_CREDENTIAL_STATUS_FRESH_MS - 1;
    await expect(cache.read("/bin/kimi")).resolves.toBe("READY");
    expect(probe).toHaveBeenCalledOnce();

    nowMs = CLI_CREDENTIAL_STATUS_FRESH_MS;
    probe.mockResolvedValueOnce(null);
    await expect(cache.read("/bin/kimi")).resolves.toBe("READY");
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect(await cache.read("/bin/kimi")).toBeNull());
  });

  it("retries missing credentials sooner and re-probes immediately after invalidation", async () => {
    let nowMs = 0;
    const probe = vi.fn(async (): Promise<CliCredentialStatus | null> => null);
    const cache = createCliCredentialStatusCache({ probe, now: () => nowMs });

    await cache.read("/bin/kimi");
    nowMs = CLI_CREDENTIAL_STATUS_MISSING_FRESH_MS - 1;
    await cache.read("/bin/kimi");
    expect(probe).toHaveBeenCalledOnce();

    cache.invalidate();
    probe.mockResolvedValueOnce("READY");
    await expect(cache.read("/bin/kimi")).resolves.toBe("READY");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("keeps the registry refresh cheap and drops credential probes when the registry is invalidated", async () => {
    const commandDir = await mkdtemp(join(tmpdir(), "space-cli-runtime-cache-"));
    try {
      const commandPath = join(commandDir, "kimi-vscode-parity");
      await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(commandPath, 0o755);
      const config = getApiConfig({ SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: commandDir });
      let nowMs = 0;
      const probe = vi.fn(async (): Promise<CliCredentialStatus | null> => "READY");
      const cache = createCliRuntimeRegistryCache(config, { now: () => nowMs, probeCredentialStatus: probe });

      expect(findRuntime(await cache.read(), "cli:kimi")?.authState).toBe("READY");
      expect(probe).toHaveBeenCalledOnce();
      expect(probe).toHaveBeenCalledWith(commandPath);

      // The 10 s registry refresh re-checks binaries without new credential probes.
      nowMs += 10_001;
      expect(findRuntime(await cache.read(), "cli:kimi")?.authState).toBe("READY");
      expect(probe).toHaveBeenCalledOnce();

      // Login completion and setup verification invalidate the registry.
      cache.invalidate();
      probe.mockResolvedValueOnce(null);
      expect(findRuntime(await cache.read(), "cli:kimi")?.authState).not.toBe("READY");
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      await rm(commandDir, { recursive: true, force: true });
    }
  });
});

describe("CLI runtime cache invalidation routes", () => {
  it.each([
    ["PATCH", "/api/cli/runtime-settings/:runtimeId", true],
    ["PATCH", "/api/cli/runtime-settings/:runtimeId/vpn", true],
    ["POST", "/api/cli/runtimes/:runtimeId/account-profiles", true],
    ["DELETE", "/api/cli/runtimes/:runtimeId/account-profiles/:profileId", true],
    ["PATCH", "/api/cli/providers/:id", true],
    ["POST", "/api/admin/cli-maintenance/update-all/run", true],
    ["GET", "/api/cli/runtime-settings", false],
    ["GET", "/api/cli/runtimes/:runtimeId/account-profiles", false],
    ["POST", "/api/panes/:id/cli/session", false],
    ["POST", "/api/rooms/:id/cli-login", false]
  ] as const)("%s %s invalidates: %s", (method, url, expected) => {
    expect(invalidatesCliRuntimeCache(method, url)).toBe(expected);
  });

  it("invalidates before the response of routes registered before the hook", async () => {
    const app = Fastify();
    const invalidate = vi.fn();
    app.patch("/api/cli/runtime-settings/:runtimeId", async () => ({ ok: true }));
    app.get("/api/cli/runtime-settings", async () => ({ settings: [] }));
    app.post("/api/cli/runtimes/:runtimeId/account-profiles", async (_request, reply) => reply.code(409).send({ error: "conflict" }));
    registerCliRuntimeCacheInvalidation(app, invalidate);
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/api/cli/runtime-settings" })).statusCode).toBe(200);
    expect(invalidate).not.toHaveBeenCalled();
    const patched = await app.inject({ method: "PATCH", url: "/api/cli/runtime-settings/cli:kimi", payload: {} });
    expect(patched.json()).toEqual({ ok: true });
    expect(invalidate).toHaveBeenCalledOnce();
    expect((await app.inject({ method: "POST", url: "/api/cli/runtimes/cli:gemini/account-profiles", payload: {} })).statusCode).toBe(409);
    expect(invalidate).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
