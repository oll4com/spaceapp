import { describe, it, expect, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemoryControlRepository } from "@space/db";
import { controlExecuteSchema, SPACE_CONTROL_VERSION } from "@space/contracts";
import { createSpaceControl } from "../src/space-control.js";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const actor = { id: "operator:one", role: "ADMIN" as const };

function fixture(extraOptions: Record<string, any> = {}) {
  const store = new InMemorySpaceStore();
  const repository = new InMemoryControlRepository();
  const room = store.createRoom({ name: "Governance test", initialPaneCount: 0, kind: "AGENT_PROOF" });
  const controller = {
    catalog: vi.fn(async () => ({ types: [], unavailable: [] })),
    inspect: vi.fn(async () => ({
      paneId: "pane-1",
      title: "Test",
      runtimeId: "cli:codex",
      sessionId: "session:1",
      state: "IDLE" as const,
      nativeTaskRef: "ref:1",
      modelId: "test",
      nativeMode: "default",
      checkedAt: new Date().toISOString(),
      tasks: []
    })),
    configure: vi.fn(async () => ({})),
    command: vi.fn(async () => ({})),
    start: vi.fn(async () => ({})),
    resume: vi.fn(async () => ({})),
    interrupt: vi.fn(async () => ({}))
  };
  const send = vi.fn(async () => ({ submitted: true }));
  const integration = vi.fn(async (target: string, payload: Record<string, unknown>) => {
    return { status: "COMPLETED", result: { simulated: true, target, payload } };
  });
  const inspectExtra = vi.fn(async (input: { section: string }) => {
    if (input.section === "SYSTEM_HEALTH") {
      return { status: "HEALTHY", uptime: 1234 };
    }
    if (input.section === "PLUGINS") {
      return { count: 1, plugins: [{ id: "github", name: "GitHub", connected: true, status: "CONNECTED", error: null }] };
    }
    if (input.section === "MODULES") {
      return { version: SPACE_CONTROL_VERSION, docks: [{ id: "surface-health", label: "Health", scope: "installation" }] };
    }
    if (input.section === "VOICE") {
      return { defaultVoiceId: "alloy", currentMode: "full_duplex", availableVoices: [{ id: "alloy", label: "Alloy" }] };
    }
    if (input.section === "LINKS") {
      return { count: 0, links: [] };
    }
    if (input.section === "TASKS") {
      return { count: 0, tasks: [] };
    }
    if (input.section === "SETTINGS") {
      return { theme: "dark", voice: { defaultVoiceId: "alloy" } };
    }
    return null;
  });

  const options = {
    store,
    repository,
    controller,
    send,
    publish: vi.fn(async () => {}),
    integration,
    inspectExtra,
    ...extraOptions
  };
  const service = createSpaceControl(options);
  const execute = (actions: unknown[], requestId = "req:gov:1", extra = {}) =>
    service.execute(actor, controlExecuteSchema.parse({ roomId: room.id, requestId, actions, ...extra }));

  return { store, repository, controller, send, integration, inspectExtra, options, service, room, execute };
}

describe("Space Control Governance & Security", () => {
  it("exposes complete discoverability schemas in capabilities()", async () => {
    const c = fixture();
    const caps = await c.service.capabilities();
    expect(caps.version).toBe(SPACE_CONTROL_VERSION);
    expect(caps.actionCatalog.length).toBeGreaterThan(15);
    expect(caps.inspectSections.length).toBeGreaterThanOrEqual(10);
    expect(caps.securityPolicy).toBeDefined();
    expect(caps.securityPolicy.prohibitedKeys).toContain("apiKey");
    expect(caps.securityPolicy.prohibitedKeys).toContain("password");
    expect(caps.securityPolicy.requiresConfirmation).toContain("settings.rollback");
  });

  it("inspects extended sections via inspect() and inspectExtra", async () => {
    const c = fixture();
    for (const section of ["SYSTEM_HEALTH", "PLUGINS", "MODULES", "VOICE", "LINKS", "TASKS", "SETTINGS"] as const) {
      const result = await c.service.inspect({ section });
      expect(result.section).toBe(section);
      expect(result.data).toBeDefined();
    }
  });

  it("does not claim adapter validation for a schema-only dry run", async () => {
    const c = fixture();
    const result = await c.execute(
      [
        {
          kind: "resource",
          operation: "settings.task_titles",
          input: {}
        }
      ],
      "dry-run-req",
      { dryRun: true }
    );

    expect(result.status).toBe("UNKNOWN");
    expect(result.results[0]!.evidence).toMatchObject({
      dryRun: true,
      schemaValidated: true,
      adapterValidated: false
    });
    expect(c.integration).not.toHaveBeenCalled();
  });

  it("performs focused-client preflight for voice preferences without mutating", async () => {
    const c = fixture();
    c.service.registerClient(actor, c.room.id, "focused", [], {});
    const result = await c.execute([{ kind: "resource", operation: "settings.voice", input: { language: "el" } }], "voice-preflight", { dryRun: true });
    expect(result).toMatchObject({ status: "COMPLETED", results: [{ evidence: { adapterValidated: true, adapter: "BROWSER_VOICE_COMPOSER" } }] });
    expect(c.integration).not.toHaveBeenCalled();
  });

  it("performs focused-client preflight for appearance controls without mutating", async () => {
    const c = fixture();
    c.service.registerClient(actor, c.room.id, "focused", [], {});
    const result = await c.execute([{ kind: "resource", operation: "settings.appearance", input: { theme: "modern", zoomLevel: 110 } }], "appearance-preflight", { dryRun: true });
    expect(result).toMatchObject({ status: "COMPLETED", results: [{ evidence: { adapterValidated: true, adapter: "BROWSER_APPEARANCE" } }] });
    expect(c.integration).not.toHaveBeenCalled();
  });

  it("strictly rejects forbidden credential and secret fields in mutations", async () => {
    const c = fixture();
    const result = await c.execute([
      {
        kind: "resource",
        operation: "settings.update",
        input: { apiKey: "secret_value" }
      }
    ]);

    expect(result.status).toBe("FAILED");
    expect(result.results[0]!.error).toMatch(/Security violation: Direct modification of 'apiKey' is forbidden/);
    expect(c.integration).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation for destructive operations", async () => {
    const c = fixture();
    // settings.rollback without confirm: true
    const unconfirmed = await c.execute([
      {
        kind: "resource",
        operation: "settings.rollback",
        input: { snapshotId: "snap-123" }
      }
    ]);
    expect(unconfirmed.status).toBe("FAILED");
    expect(unconfirmed.results[0]!.error).toMatch(/requires explicit confirmation/);

    // With confirm: true. Since cef5d0b619 the integration is consulted first; the
    // production integration does not handle settings.rollback, so the snapshot
    // restore path decides and an unknown snapshot is still not restorable.
    c.integration.mockImplementation(async () => undefined as never);
    const confirmed = await c.execute(
      [
        {
          kind: "resource",
          operation: "settings.rollback",
          input: { snapshotId: "snap-123", confirm: true }
        }
      ],
      "confirmed-rollback"
    );
    expect(confirmed.status).toBe("FAILED");
    expect(confirmed.results[0]!.error).toMatch(/does not exist or cannot be accessed/);
    expect(c.integration).toHaveBeenCalledTimes(1);
  });

  it("records structured audit logs and makes them queryable via AUDIT inspection", async () => {
    const c = fixture();
    await c.execute(
      [
        {
          kind: "resource",
          operation: "settings.task_titles",
          input: {}
        }
      ],
      "audit-req-1"
    );

    const auditInspect = await c.service.inspect(actor, { section: "AUDIT", offset: 0, limit: 25 });
    expect(auditInspect.section).toBe("AUDIT");
    const data = auditInspect.data as any;
    expect(data.count).toBeGreaterThanOrEqual(1);
    expect(data.entries[0]).toMatchObject({
      actorId: actor.id,
      operation: "settings.task_titles",
      status: "COMPLETED"
    });
  });

  it("rejects forbidden fields nested in objects and arrays before any adapter runs", async () => {
    const c = fixture();
    const result = await c.execute([{ kind: "resource", operation: "settings.update", input: { domain: "tools", patch: { entries: [{ apiKey: "test-only" }] } } }]);
    expect(result.status).toBe("FAILED");
    expect(c.integration).not.toHaveBeenCalled();
  });

  it("resolves unified settings once and preserves the outer operation on retries", async () => {
    const c = fixture();
    const actions = [{ kind: "resource", operation: "settings.update", input: { domain: "tools", patch: { policies: [] } } }];
    const first = await c.execute(actions, "settings-alias-once");
    const retry = await c.execute(actions, "settings-alias-once");
    expect(first.status).toBe("COMPLETED");
    expect(retry.id).toBe(first.id);
    expect(c.integration).toHaveBeenCalledTimes(1);
    expect(c.integration).toHaveBeenCalledWith(actor, c.room.id, expect.objectContaining({
      operation: "settings.tools", input: { policies: [] }
    }));
    expect(await c.repository.list("operation", actor.id, c.room.id)).toHaveLength(1);
    const audit = await c.service.inspect(actor, { section: "AUDIT", offset: 0, limit: 25 });
    expect(audit.entries[0]).toMatchObject({ requestId: "settings-alias-once", operation: "settings.update" });
  });

  it("reads persistent owner-scoped audit after reconstruction", async () => {
    const c = fixture();
    await c.execute([{ kind: "room", operation: "rename", name: "Renamed" }]);
    const restarted = createSpaceControl(c.options);
    const own = await restarted.inspect(actor, { section: "AUDIT", offset: 0, limit: 25 });
    expect(own.entries).toHaveLength(1);
    const other = await restarted.inspect({ ...actor, id: "operator:other" }, { section: "AUDIT", offset: 0, limit: 25 });
    expect(other.entries).toHaveLength(0);
  });

  it("fails target validation in dry runs without mutating valid panes", async () => {
    const c = fixture();
    const result = await c.execute([{ kind: "pane", operation: "close", target: { paneIds: ["missing:pane"] } }], "missing-target", { dryRun: true });
    expect(result.status).toBe("FAILED");
    expect(c.controller.interrupt).not.toHaveBeenCalled();
  });

  it.each(["RUNNING", "PENDING", "QUEUED", "UNKNOWN", "PARTIAL", "CANCELLED"])("does not turn adapter %s into completion", async status => {
    const c = fixture({ integration: vi.fn(async () => ({ status })) });
    const result = await c.execute([
      { kind: "resource", operation: "settings.task_titles", input: {} },
      { kind: "room", operation: "rename", name: "Must not run" }
    ]);
    expect(result.status).not.toBe("COMPLETED");
    expect(c.store.getRoom(c.room.id).name).toBe("Governance test");
  });

  it("does not count unexecuted readiness probes as PASS", async () => {
    const c = fixture();
    const result = await c.service.testMcpTools(actor, c.room.id, { tools: ["space_screenshot", "voice_youtube_search"] });
    expect(result).toMatchObject({ status: "PARTIAL", passedCount: 0, failedCount: 0, warnedCount: 2 });
  });

  it("persists failed MCP-probe incidents when the private log directory does not yet exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-mcp-incident-"));
    const install = join(root, "install");
    const file = join(install, "var", "live-voice-logs", "debug-incidents.jsonl");
    const removeFixture = async () => {
      const inside = relative(resolve(tmpdir()), resolve(root));
      if (!inside.startsWith("space-mcp-incident-") || inside.includes(sep) || isAbsolute(inside)) throw new Error("Refusing cleanup outside the private MCP fixture.");
      await rm(root, { recursive: true, force: true });
    };
    vi.stubEnv("SPACE_INSTANCE", "dev"); vi.stubEnv("SPACE_INSTALL_ROOT", install);
    try {
      await expect(stat(join(install, "var", "live-voice-logs"))).rejects.toMatchObject({ code: "ENOENT" });
      const c = fixture({ inspectExtra: async () => { throw new Error("Synthetic MCP probe failure"); } });
      const result = await c.service.testMcpTools(actor, c.room.id, { tools: ["space_inspect:SYSTEM_HEALTH"] });
      expect(result).toMatchObject({ status: "PARTIAL", testedCount: 1, passedCount: 0, failedCount: 1 });
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
        incidentId: result.incidentId, operation: "space_test_mcp_tools", roomId: c.room.id, failedCount: 1,
        failedTools: [{ tool: "space_inspect:SYSTEM_HEALTH", error: "Synthetic MCP probe failure" }]
      });
    } finally {
      vi.unstubAllEnvs();
      await removeFixture();
    }
  });

  it("does not enqueue transient commands or claim success for a disconnected client", async () => {
    const c = fixture({ queueDisconnected: true });
    const result = await c.execute([{ kind: "playback", operation: "next" }]);
    expect(result.status).toBe("RUNNING");
    expect(result.results).toMatchObject([{ status: "PENDING", evidence: { waitingForClient: true } }]);
    expect(c.service.registerClient(actor, c.room.id, "later", [], {})).toEqual([]);
  });

  it("does not replay a submitted schedule when a client reconnects", async () => {
    const c = fixture();
    const result = await c.execute([{ kind: "playback", operation: "next" }]);
    const record = (await c.repository.get("operation", actor.id, result.id))!;
    await c.repository.write({ ...record, value: { ...result, nextIndex: 1,
      results: [{ index: 0, status: "PENDING", detail: "Already scheduled", evidence: { scheduleId: "schedule:existing" } }]
    } }, record.version);
    c.service.registerClient(actor, c.room.id, "focused", [], {});
    await c.service.operations(actor, c.room.id, result.id);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(c.service.registerClient(actor, c.room.id, "focused", [], {})).toEqual([]);
    const stored = (await c.repository.get("operation", actor.id, result.id))!.value as any;
    expect(stored.results[0].evidence.scheduleId).toBe("schedule:existing");
    expect(stored.nextIndex).toBe(1);
  });

  it("settles cancelled browser waits and never dispatches after reconnect", async () => {
    const c = fixture();
    const result = await c.execute([{ kind: "playback", operation: "next" }]);
    const cancelled = await c.service.operations(actor, c.room.id, result.id, true);
    expect(cancelled).toMatchObject({ status: "CANCELLED", cancelRequested: true,
      results: [{ status: "CANCELLED", evidence: { waitingForClient: true } }] });
    c.service.registerClient(actor, c.room.id, "focused", [], {});
    expect(await c.service.operations(actor, c.room.id, result.id)).toMatchObject({ status: "CANCELLED" });
    expect(c.service.registerClient(actor, c.room.id, "focused", [], {})).toEqual([]);
  });
});
