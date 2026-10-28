import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import protoPkg from "@temporalio/proto";

const { temporal } = protoPkg;
const History = (temporal.api.history.v1 as any).History;

const EXPECTED_FIXTURES = [
  "main-codex-turn.json",
  "main-dot-goal.json",
  "main-dummy-turn.json",
  "main-room-action.json",
  "main-supervisor-first-run.json",
  "main-supervisor-pre-patch.json",
  "maintenance-consolidation.json",
  "maintenance-run.json",
  "mutation-run.json"
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "fixtures/workflow-histories");
const WORKFLOWS_MAIN = resolve(__dirname, "../src/workflows.ts");
const WORKFLOWS_MAINTENANCE = resolve(__dirname, "../src/memory-maintenance-workflows.ts");
const WORKFLOWS_MUTATION = resolve(__dirname, "../src/memory-mutation-workflows.ts");

describe("Workflow determinism replay gate", () => {
  it("asserts EXPECTED_FIXTURES contains all 9 canonical files", () => {
    const existing = readdirSync(FIXTURES_DIR).filter((file) => file.endsWith(".json"));
    expect(existing.sort()).toEqual([...EXPECTED_FIXTURES].sort());
    for (const fixture of EXPECTED_FIXTURES) {
      expect(existing).toContain(fixture);
    }
  });

  it("replays main workflow bundle histories without determinism errors", async () => {
    const mainFixtures = EXPECTED_FIXTURES.filter((name) => name.startsWith("main-"));
    const failures: Array<{ fixture: string; error: unknown }> = [];

    for (const fixture of mainFixtures) {
      const json = JSON.parse(readFileSync(resolve(FIXTURES_DIR, fixture), "utf8"));
      const history = History.fromObject(json);
      for await (const res of Worker.runReplayHistories(
        { workflowsPath: WORKFLOWS_MAIN },
        [{ workflowId: fixture, history }]
      )) {
        if (res.error) {
          failures.push({ fixture, error: res.error });
        }
      }
    }

    expect(failures).toEqual([]);
  }, 60_000);

  it("replays maintenance workflow bundle histories without determinism errors", async () => {
    const maintenanceFixtures = EXPECTED_FIXTURES.filter((name) => name.startsWith("maintenance-"));
    const failures: Array<{ fixture: string; error: unknown }> = [];

    for (const fixture of maintenanceFixtures) {
      const json = JSON.parse(readFileSync(resolve(FIXTURES_DIR, fixture), "utf8"));
      const history = History.fromObject(json);
      for await (const res of Worker.runReplayHistories(
        { workflowsPath: WORKFLOWS_MAINTENANCE },
        [{ workflowId: fixture, history }]
      )) {
        if (res.error) {
          failures.push({ fixture, error: res.error });
        }
      }
    }

    expect(failures).toEqual([]);
  }, 60_000);

  it("replays mutation workflow bundle histories without determinism errors", async () => {
    const mutationFixtures = EXPECTED_FIXTURES.filter((name) => name.startsWith("mutation-"));
    const failures: Array<{ fixture: string; error: unknown }> = [];

    for (const fixture of mutationFixtures) {
      const json = JSON.parse(readFileSync(resolve(FIXTURES_DIR, fixture), "utf8"));
      const history = History.fromObject(json);
      for await (const res of Worker.runReplayHistories(
        { workflowsPath: WORKFLOWS_MUTATION },
        [{ workflowId: fixture, history }]
      )) {
        if (res.error) {
          failures.push({ fixture, error: res.error });
        }
      }
    }

    expect(failures).toEqual([]);
  }, 60_000);

  it("replays all 9 canonical histories against current production workflows with 0 failures", async () => {
    const failures: Array<{ fixture: string; error: unknown }> = [];

    for (const fixture of EXPECTED_FIXTURES) {
      const workflowsPath = fixture.startsWith("main-")
        ? WORKFLOWS_MAIN
        : fixture.startsWith("maintenance-")
        ? WORKFLOWS_MAINTENANCE
        : WORKFLOWS_MUTATION;

      const json = JSON.parse(readFileSync(resolve(FIXTURES_DIR, fixture), "utf8"));
      const history = History.fromObject(json);

      for await (const res of Worker.runReplayHistories(
        { workflowsPath },
        [{ workflowId: fixture, history }]
      )) {
        if (res.error) {
          failures.push({ fixture, error: res.error });
        }
      }
    }

    expect(failures).toEqual([]);
  }, 120_000);
});
