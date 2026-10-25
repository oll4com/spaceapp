import { describe, expect, it } from "vitest";
import { loadMigrations } from "../src/index.js";

describe("app diagnostics migration", () => {
  it("adds a disabled singleton, capture sessions, one active recorder, and expiring segment index", async () => {
    const migrations = await loadMigrations();
    const diagnostics = migrations.find((migration) => migration.id === "0059_app_diagnostics");

    expect(diagnostics).toBeDefined();
    expect(diagnostics?.sql).toContain("CREATE TABLE IF NOT EXISTS app_diagnostics_settings");
    expect(diagnostics?.sql).toContain("CHECK (singleton_id = 1)");
    expect(diagnostics?.sql).toContain("enabled boolean NOT NULL DEFAULT false");
    expect(diagnostics?.sql).toContain("CREATE TABLE IF NOT EXISTS app_diagnostics_captures");
    expect(diagnostics?.sql).toContain("CREATE TABLE IF NOT EXISTS app_diagnostics_video_leases");
    expect(diagnostics?.sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_diagnostics_one_active_video_lease");
    expect(diagnostics?.sql).toContain("WHERE status = 'ACTIVE'");
    expect(diagnostics?.sql).toContain("CREATE TABLE IF NOT EXISTS app_diagnostics_segments");
    expect(diagnostics?.sql).toContain("expires_at timestamptz NOT NULL");
    expect(diagnostics?.sql).toContain("idx_app_diagnostics_segments_kind_ended");
    expect(diagnostics?.sql).toContain("(kind, ended_at, segment_id)");
    expect(diagnostics?.sql).toContain("idx_app_diagnostics_segments_technical_batch");
    expect(diagnostics?.sql).toContain("(capture_id, client_id, batch_id)");
    expect(diagnostics?.sql).not.toMatch(/\b(chat|clipboard|terminal_text|request_body|cookie|authorization|password|token)\b/i);
  });

  it("retains trusted ephemeral admin actor ids without requiring a users row", async () => {
    const migrations = await loadMigrations();
    const actorIds = migrations.find(
      (migration) => migration.id === "0060_app_diagnostics_actor_ids"
    );

    expect(actorIds).toBeDefined();
    expect(actorIds?.sql).toContain(
      "DROP CONSTRAINT IF EXISTS app_diagnostics_settings_enabled_by_user_id_fkey"
    );
    expect(actorIds?.sql).toContain(
      "DROP CONSTRAINT IF EXISTS app_diagnostics_settings_disabled_by_user_id_fkey"
    );
    expect(actorIds?.sql).toContain(
      "DROP CONSTRAINT IF EXISTS app_diagnostics_captures_started_by_user_id_fkey"
    );
    expect(actorIds?.sql).toContain(
      "DROP CONSTRAINT IF EXISTS app_diagnostics_captures_ended_by_user_id_fkey"
    );
    expect(actorIds?.sql).toContain(
      "DROP CONSTRAINT IF EXISTS app_diagnostics_video_leases_user_id_fkey"
    );
  });
});
