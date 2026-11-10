import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaneBrowserAccounts } from "../src/pane-browser-account.js";

const primary = { id: "google_account:primary", ownerUserId: "user:a", email: "a@example.com", displayName: "A", isPrimary: true };
const pane = { id: "pane:one", roomId: "room:one", mode: "BROWSER" } as never;

function fixture(roomKind = "USER", probe = vi.fn(async () => ({ email: null as string | null }))) {
  const selections = new Map<string, string | null>();
  const selectionStore = {
    get: async (_owner: string, paneId: string) => selections.get(paneId) ?? null,
    save: async (_owner: string, paneId: string, profileId: string | null) => { selections.set(paneId, profileId); return profileId; },
    initializeSelection: async (_owner: string, paneId: string, profileId: string | null) => { selections.set(paneId, profileId); return profileId; }
  } as never;
  const accounts = createPaneBrowserAccounts({
    store: {
      getRoom: async () => ({ kind: roomKind }),
      listGoogleAccounts: async () => [primary],
      getCliAccountProfile: async () => null
    } as never,
    config: { browserSessionsProfileRoot: "/nonexistent" },
    log: { warn: vi.fn() },
    browserSessionManager: {},
    youtubeAccountStore: selectionStore,
    browserAccountStore: selectionStore,
    youtubeAccountOperations: new Map(),
    readCachedCliAccountIdentity: probe,
    googleAccountBrowserStatuses: async () => new Map()
  });
  return { accounts, probe };
}

afterEach(() => { vi.useRealTimers(); });

describe("pane browser accounts", () => {
  it("opens the primary account by default and refuses a choice it cannot open", async () => {
    const { accounts } = fixture();
    expect(await accounts.resolvePaneBrowserAccount("user:a", pane)).toEqual({ selectedProfileId: null, account: primary, profileKey: null });
    await expect(accounts.resolvePaneBrowserAccount("user:a", pane, "google_account:gone")).rejects.toThrow("The selected Google account is no longer available.");
    await expect(accounts.resolvePaneBrowserAccount("user:a", pane, "gemini-gone")).rejects.toThrow("Choose another account.");
    await expect(fixture("AGENT_PROOF").accounts.resolvePaneBrowserAccount("user:a", pane, primary.id)).rejects.toThrow("Real Google accounts are unavailable in proof rooms.");
    expect(await fixture("AGENT_PROOF").accounts.resolvePaneBrowserAccount("user:a", pane)).toEqual({ selectedProfileId: null, profileKey: null });
  });

  it("keeps a Gemini account's last known email and probes again only once it is stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const probe = vi.fn(async () => ({ email: "g@example.com" as string | null }));
    const { accounts } = fixture("USER", probe);
    expect(await accounts.geminiAccountEmails(["g"])).toEqual(new Map([["g", "g@example.com"]]));
    expect(await accounts.geminiAccountEmails(["g"])).toEqual(new Map([["g", "g@example.com"]]));
    expect(probe).toHaveBeenCalledTimes(1);
    probe.mockResolvedValueOnce({ email: null });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await accounts.geminiAccountEmails(["g"])).toEqual(new Map([["g", "g@example.com"]]));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("runs one YouTube account operation per pane at a time, and a failure frees the pane", async () => {
    const { accounts } = fixture();
    const order: string[] = [];
    let release!: () => void;
    const first = accounts.withYouTubeAccountLock("pane:one", async () => { order.push("first:start"); await new Promise<void>(resolve => { release = resolve; }); order.push("first:end"); throw new Error("failed"); });
    const second = accounts.withYouTubeAccountLock("pane:one", async () => { order.push("second"); return "ok"; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(order).toEqual(["first:start"]);
    release();
    await expect(first).rejects.toThrow("failed");
    expect(await second).toBe("ok");
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});
