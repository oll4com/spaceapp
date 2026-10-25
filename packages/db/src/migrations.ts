import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface MigrationFile {
  id: string;
  filename: string;
  sql: string;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(moduleDirectory);
export const migrationDirectory = join(packageRoot, "migrations");

// These complete IDs have already shipped with a shared numeric prefix. They
// stay as they are: renaming an applied migration would re-run it.
export const historicalPrefixCollisions: ReadonlySet<string> = new Set([
  "0034_browser_recording_handoff.sql",
  "0034_room_agent_supervisor.sql",
  // The public installer's own 0057_single_owner_setup.sql (shipped in public installs) shares its number with
  // this repository's 0057; both are applied, so neither may be renamed (1.1.5 internal review, 2026-10-16).
  "0057_pane_cli_terminal_control_leases.sql",
  "0057_single_owner_setup.sql",
  "0088_shared_chat.sql",
  "0088_copilot_account_profiles.sql",
  "0089_audit_chain.sql",
  "0089_cursor_account_profiles.sql",
  "0148_dot_delegations.sql",
  "0148_repository_providers.sql",
  "0154_session_revocations.sql",
  "0154_space_gateway_reauth_status.sql",
  "0157_job_apply_pane_metadata.sql",
  "0157_space_gateway_speed_defaults.sql"
]);

export interface MigrationIdentityIssue {
  code: "INVALID_FILENAME" | "DUPLICATE_PREFIX";
  filenames: string[];
}

/** Identity rules for new migrations: a stable ordered ID and a prefix no
 * other migration uses. Enforced by tests, not at deploy time: full-filename
 * order stays deterministic, and concurrent agents must not see a live deploy
 * roll back because two of them picked the same number. */
export function migrationIdentityIssues(filenames: readonly string[]): MigrationIdentityIssue[] {
  const issues: MigrationIdentityIssue[] = [];
  const byPrefix = new Map<string, string[]>();
  for (const filename of [...filenames].sort()) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(filename)) {
      issues.push({ code: "INVALID_FILENAME", filenames: [filename] });
      continue;
    }
    byPrefix.set(filename.slice(0, 4), [...(byPrefix.get(filename.slice(0, 4)) ?? []), filename]);
  }
  for (const group of byPrefix.values()) {
    if (group.length > 1 && !group.every((filename) => historicalPrefixCollisions.has(filename))) {
      issues.push({ code: "DUPLICATE_PREFIX", filenames: group });
    }
  }
  return issues;
}

export async function loadMigrations(directory = migrationDirectory): Promise<MigrationFile[]> {
  const filenames = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(
    filenames.map(async (filename) => ({
      id: filename.replace(/\.sql$/, ""),
      filename,
      sql: await readFile(join(directory, filename), "utf8")
    }))
  );
}
