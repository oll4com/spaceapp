import { describe, expect, it, vi } from "vitest";

// The room-full refusal keeps an incident line in the live voice logs: never write the real file from a test.
const incidents = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()),
  mkdir: async () => undefined, appendFile: async (_path: string, line: string) => { incidents.push(line); } }));

const { createSpaceControlPanesOpen, paneCountsByName } = await import("../src/space-control-panes-open.js");

function fixture(options: { open?: number; paneCap?: number; enabled?: string[]; registry?: { read(): Promise<unknown>; readFresh(): Promise<unknown> } } = {}) {
  const execute = vi.fn(async (_roomId: string, _actorId: string, command: { action: { counts: Record<string, number> } }) =>
    ({ data: Object.entries(command.action.counts).flatMap(([typeId, count]) => Array.from({ length: count }, (_, i) => ({ id: `pane:${typeId}-${i}`, mode: "TERMINAL" }))) }));
  const { openControlPanes } = createSpaceControlPanesOpen({
    store: {
      getRoom: async () => ({ id: "room:one", paneCap: options.paneCap ?? 4 }),
      listPanes: async () => Array.from({ length: options.open ?? 0 }, (_, i) => ({ id: `pane:open-${i}`, isClosed: false }))
    } as never,
    cliTerminalManager: {} as never,
    cliRuntimeRegistryCache: (options.registry ?? { read: async () => ({ data: [{ id: "cli:codex", adapterStatus: "ENABLED", authState: "READY", status: "ENABLED" }] }) }) as never,
    cliRuntimeVisibility: { enabledRuntimeIds: async () => options.enabled ?? ["cli:codex"] },
    gatewayCliAccounts: { openProfileId: async () => null } as never,
    antigravityUsageProvider: async () => ({ data: [] }) as never,
    roomPaneCommands: { execute } as never,
    youtubePlaybackStore: { save: vi.fn() } as never,
    controlSend: vi.fn() as never
  });
  const open = (counts: Record<string, number>, input: Record<string, unknown> = {}) =>
    openControlPanes({ id: "user:operator" } as never, "room:one", { kind: "resource", operation: "panes.open", input: { counts, ...input } } as never);
  return { open, execute };
}

describe("Space Control panes.open", () => {
  it("clips the counts to the room's free slots in catalog order", async () => {
    const { open, execute } = fixture({ open: 2, paneCap: 4 });
    const result = await open({ browser: 2, codex: 2 }) as { fill: Record<string, unknown> };
    expect(execute.mock.calls[0]![2].action.counts).toEqual({ codex: 2 });
    expect(result.fill).toEqual({ requested: 4, opened: 2, clipped: true, freeSlotsBefore: 2, effectiveCounts: { codex: 2 }, originalCounts: { browser: 2, codex: 2 } });
  });

  it("drops CLI types that are not enabled and opens the rest", async () => {
    const { open, execute } = fixture({ enabled: [] });
    const result = await open({ codex: 1, browser: 1 }) as { skipped: unknown[] };
    expect(execute.mock.calls[0]![2].action.counts).toEqual({ browser: 1 });
    expect(result.skipped).toEqual([{ typeId: "codex", label: "Codex", reason: "Unavailable." }]);
    await expect(fixture({ enabled: [] }).open({ codex: 1 })).rejects.toThrow("Nothing to open: all requested pane types are currently unavailable.");
  });

  it("reads a CLI cached as signed out fresh once before dropping it (4/11 lab: sign-in outside Space's login flow)", async () => {
    const codex = (authState: string) => ({ data: [{ id: "cli:codex", adapterStatus: "ENABLED", authState, status: "ENABLED" }] });
    const registry = { read: async () => codex("LOGIN_REQUIRED"), readFresh: vi.fn(async () => codex("READY")) };
    const { open, execute } = fixture({ registry });
    await open({ codex: 1 });
    expect(registry.readFresh).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![2].action.counts).toEqual({ codex: 1 });
  });

  it("refuses a full room, or answers its incident report with debug on", async () => {
    await expect(fixture({ open: 4 }).open({ browser: 1 })).rejects.toThrow("Room capacity exceeded: room currently has 4 open panes, maximum capacity is 4 panes.");
    const debug = await fixture({ open: 4 }).open({ browser: 1 }, { debug: true }) as Record<string, unknown>;
    expect(debug).toMatchObject({ status: "FAILED", isError: true, debugDiagnosis: { operation: "panes.open", roomCapacity: { currentOpen: 4, maxAllowed: 4, requested: 1, freeSlots: 0 } } });
    await vi.waitFor(() => expect(incidents).toHaveLength(2));
  });

  it("reads a guessed pane type key as its catalog type (R84 12/11: job-copilot, jobcopilot, job, mail_copilot failed)", async () => {
    expect(paneCountsByName({ "job-copilot": 1, "freelance-copilot": 1 })).toEqual({ jobs: 1, freelance: 1 });
    expect(paneCountsByName({ jobcopilot: 1, job: 1, mail_copilot: 2, codex: 1 })).toEqual({ jobs: 2, mail: 2, codex: 1 });
    expect(() => paneCountsByName({ wizard: 1 })).toThrow(/Unknown pane type 'wizard'\. Use one of: opencode, codex/);
    const { open, execute } = fixture();
    await open({ Codex: 1 });
    expect(execute.mock.calls[0]![2].action.counts).toEqual({ codex: 1 });
  });
});
