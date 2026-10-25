import { describe, expect, it } from "vitest";
import { loadMigrations } from "../src/index.js";

describe("CLI terminal control lease migration", () => {
  it("stores one durable page controller per CLI session without persisted credentials", async () => {
    const migrations = await loadMigrations();
    const migration = migrations.find(
      (candidate) => candidate.id === "0057_pane_cli_terminal_control_leases"
    );

    expect(migration).toBeDefined();
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS pane_cli_terminal_control_leases");
    expect(migration?.sql).toContain(
      "session_id text NOT NULL REFERENCES pane_cli_sessions(session_id) ON DELETE CASCADE"
    );
    expect(migration?.sql).toContain("browser_client_id uuid NOT NULL");
    expect(migration?.sql).toContain("tab_lineage_id uuid NOT NULL");
    expect(migration?.sql).toContain("page_client_id uuid NOT NULL");
    expect(migration?.sql).toContain(
      "status text NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED', 'EXPIRED', 'REVOKED'))"
    );
    expect(migration?.sql).toContain("idx_pane_cli_terminal_control_leases_one_active_per_session");
    expect(migration?.sql).toContain("WHERE status = 'ACTIVE'");
    expect(migration?.sql).toContain("expires_at timestamptz NOT NULL");
    expect(migration?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));
  });
});
