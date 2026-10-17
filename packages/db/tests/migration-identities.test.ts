import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadMigrations, migrationDirectory, migrationIdentityIssues } from "../src/migrations.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "space-migrations-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it("sorts full migration IDs deterministically", async () => {
  await writeFile(path.join(directory, "0002_second.sql"), "SELECT 2;");
  await writeFile(path.join(directory, "0001_first.sql"), "SELECT 1;");
  await writeFile(path.join(directory, "0001_another.sql"), "SELECT 3;");
  const migrations = await loadMigrations(directory);
  expect(migrations.map((migration) => migration.id)).toEqual(["0001_another", "0001_first", "0002_second"]);
});

it("keeps the repository's migrations free of new identity problems", async () => {
  // A failure here means a new migration reused a numeric prefix or broke the
  // filename format. Renumber the new, not-yet-deployed file; never rename an
  // applied one (add it to historicalPrefixCollisions only if it already shipped).
  const filenames = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql"));
  expect(migrationIdentityIssues(filenames)).toEqual([]);
});

it("reports a new prefix collision without renaming historical migration IDs", () => {
  expect(migrationIdentityIssues(["0128_first.sql", "0128_second.sql"])).toEqual([
    { code: "DUPLICATE_PREFIX", filenames: ["0128_first.sql", "0128_second.sql"] }
  ]);
  expect(migrationIdentityIssues(["0034_browser_recording_handoff.sql", "0034_room_agent_supervisor.sql"])).toEqual([]);
});

it("preserves the exact historical repeated-prefix migrations", async () => {
  const migrations = await loadMigrations();
  expect(migrations.filter((m) => m.id.startsWith("0034_")).map((m) => m.id)).toEqual([
    "0034_browser_recording_handoff", "0034_room_agent_supervisor"
  ]);
});

it("reports another migration using a historical prefix", () => {
  expect(migrationIdentityIssues(["0034_browser_recording_handoff.sql", "0034_unreviewed.sql"]))
    .toEqual([{ code: "DUPLICATE_PREFIX", filenames: ["0034_browser_recording_handoff.sql", "0034_unreviewed.sql"] }]);
});

it("reports migration filenames without a stable ordered ID", () => {
  expect(migrationIdentityIssues(["latest.sql"])).toEqual([{ code: "INVALID_FILENAME", filenames: ["latest.sql"] }]);
});

it("accepts the public installer's historical 0057 migration beside this repository's 0057", () => {
  expect(migrationIdentityIssues(["0057_pane_cli_terminal_control_leases.sql", "0057_single_owner_setup.sql"])).toEqual([]);
  expect(migrationIdentityIssues(["0057_single_owner_setup.sql", "0057_unreviewed.sql"]))
    .toEqual([{ code: "DUPLICATE_PREFIX", filenames: ["0057_single_owner_setup.sql", "0057_unreviewed.sql"] }]);
});
