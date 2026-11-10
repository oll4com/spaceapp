import { afterEach, describe, expect, it, vi } from "vitest";

type Input = Record<string, unknown>;
type Fn = (...args: never[]) => Promise<unknown>;
const { captured } = vi.hoisted(() => ({ captured: { built: [] as Array<{ name: string; input: Input }>, rotation: [] as unknown[][] } }));
vi.mock("../src/host-stats.js", async (orig) => ({ ...await orig<object>(),
  createHostStatsProvider: (input: Input) => { captured.built.push({ name: "host", input }); return "host-stats"; } }));
vi.mock("../src/antigravity-usage-services.js", async (orig) => ({ ...await orig<object>(),
  createAntigravityUsageAccountProvider: (input: Input) => { captured.built.push({ name: "antigravity", input }); return "antigravity"; } }));
vi.mock("../src/claude-usage-services.js", async (orig) => ({ ...await orig<object>(),
  createClaudeUsageAccountProvider: (input: Input) => { captured.built.push({ name: "claude", input }); return "claude"; },
  claudeGatewayApiKeyUsage: (repository: unknown, accountId: string) => ({ repository, accountId }),
  anthropicMonthSpendUsd: (billing: unknown) => ({ month: billing }) }));
vi.mock("../src/api-provider-balance-services.js", async (orig) => ({ ...await orig<object>(),
  createApiProviderAccountProvider: (input: Input) => { captured.built.push({ name: "api", input }); return "api-providers"; } }));
vi.mock("../src/gateway/account-rotation.js", async (orig) => ({ ...await orig<object>(),
  emailsOutOfRotation: (...args: unknown[]) => { captured.rotation.push(args.slice(0, 2)); return ["hidden@example.com"]; } }));

const { createUsageProviders } = await import("../src/usage-providers-wiring.js");

afterEach(() => { captured.built = []; captured.rotation = []; });

function build(input: { options?: Input; listProfiles?: (runtimeId: string) => unknown; gateway?: () => unknown; admin?: () => unknown } = {}) {
  const reads: string[] = [];
  const repository = { listAccounts: async () => ["account"], getSettings: async () => "settings",
    listAnthropicUsage: async (from: string, to: string) => ({ from, to }) };
  const admin = { anthropicBilling: async (days: number) => `billing ${days}`, anthropicAdminStatus: async () => ({ configured: true }) };
  const deps = {
    options: input.options ?? {}, apiStartedAt: "2026-11-01T00:00:00.000Z", config: { cliEnabled: true, cliRootEnabled: false },
    store: { listCliAccountProfiles: input.listProfiles ?? (async () => [{ profileId: "p1", displayName: "Work" }]) },
    cliTerminalManager: { hostHealth: async (runtimeId: string) => `health ${runtimeId}` },
    readClaudeAccountProfileUsage: async () => "usage",
    gatewayRepositoryFor: input.gateway ?? (() => { reads.push("gateway"); return repository; }),
    resolveGatewayAdminService: input.admin ?? (() => { reads.push("admin"); return admin; })
  };
  return { providers: createUsageProviders(deps as never), reads, repository };
}
const built = (name: string) => captured.built.find((entry) => entry.name === name)!.input;
const call = (name: string, key: string, ...args: unknown[]) => (built(name)[key] as (...a: unknown[]) => Promise<unknown>)(...args);

describe("usage providers wiring (ARCH-001 step 89)", () => {
  it("keeps every injected provider and builds nothing", () => {
    const options = { hostStatsProvider: "h", antigravityUsageProvider: "a", claudeUsageProvider: "c", apiProviderAccountsProvider: "p" };
    expect(build({ options }).providers).toEqual(options);
    expect(captured.built).toEqual([]);
  });

  it("builds the providers in order without reading the gateway, which app.ts declares after them", () => {
    const tdz = () => { throw new ReferenceError("Cannot access before initialization"); };
    const { providers } = build({ gateway: tdz, admin: tdz });
    expect(captured.built.map((entry) => entry.name)).toEqual(["host", "antigravity", "claude", "api"]);
    expect(providers).toEqual({ hostStatsProvider: "host-stats", antigravityUsageProvider: "antigravity", claudeUsageProvider: "claude",
      apiProviderAccountsProvider: "api-providers" });
  });

  it("gives the host stats the API start and both CLI hosts", async () => {
    build();
    const host = built("host") as { apiStartedAt: string; cliHosts: Array<{ hostId: string; enabled: boolean; health: () => Promise<unknown> }> };
    expect(host.apiStartedAt).toBe("2026-11-01T00:00:00.000Z");
    expect(host.cliHosts.map(({ hostId, enabled }) => ({ hostId, enabled }))).toEqual([{ hostId: "main", enabled: true }, { hostId: "root", enabled: false }]);
    expect(await Promise.all(host.cliHosts.map((entry) => entry.health()))).toEqual(["health cli:codex", "health cli:root"]);
  });

  it("labels Antigravity profiles, empty when the store fails, and hides the accounts out of the gateway's rotation", async () => {
    const { reads } = build();
    expect(reads).toEqual([]);
    expect(await call("antigravity", "profileLabels")).toEqual(new Map([["p1", "Work"]]));
    expect(await call("antigravity", "hiddenEmails")).toEqual(["hidden@example.com"]);
    expect(captured.rotation).toEqual([[["account"], "ANTIGRAVITY"]]);
    expect(reads).toEqual(["gateway"]);
    captured.built = [];
    build({ listProfiles: () => { throw new Error("down"); } });
    expect(await call("antigravity", "profileLabels")).toEqual(new Map());
  });

  it("reads the gateway and the Anthropic bill for Claude and the API providers only when asked", async () => {
    const { reads, repository } = build();
    expect(await call("claude", "listProfiles")).toEqual([{ profileId: "p1", displayName: "Work" }]);
    expect(await (built("claude").readUsage as Fn)()).toBe("usage");
    expect(await call("claude", "gatewayAccounts")).toEqual(["account"]);
    expect(await call("claude", "gatewaySettings")).toBe("settings");
    expect(await call("claude", "gatewayAccountUsage", "acct:1")).toEqual({ repository, accountId: "acct:1" });
    expect(await call("claude", "anthropicMonthUsd")).toEqual({ month: `billing ${new Date().getUTCDate()}` });
    const anthropic = built("api").anthropic as Record<string, () => Promise<unknown>>;
    expect(await anthropic.billing()).toBe("billing 31");
    expect(await anthropic.settings()).toBe("settings");
    expect(await anthropic.usage()).toEqual({ from: "2000-01-01", to: new Date().toISOString().slice(0, 10) });
    expect(await anthropic.configured()).toBe(true);
    expect(reads).toEqual(["gateway", "gateway", "gateway", "admin", "admin", "gateway", "gateway", "admin"]);
  });
});
