import { describe, expect, it } from "vitest";
import { loadMigrations } from "../src/index.js";

describe("Space database migrations", () => {
  it("adds an independent default-off VPN policy to every CLI runtime setting", async () => {
    const migrations = await loadMigrations();
    const vpn = migrations.find((migration) => migration.id === "0067_cli_runtime_vpn");
    expect(vpn?.sql).toMatch(/ADD COLUMN IF NOT EXISTS vpn_enabled boolean NOT NULL DEFAULT false/);
  });

  it("extends clipboard sources with PLAN and adds a constrained title column", async () => {
    const migrations = await loadMigrations();
    const planSource = migrations.find((migration) => migration.id === "0069_plan_clipboard_source");

    expect(planSource?.sql).toContain("ADD COLUMN IF NOT EXISTS title text");
    expect(planSource?.sql).toContain("source IN ('COPY', 'PASTE', 'MANUAL_NOTE', 'AGENT_NOTE', 'PLAN')");
    expect(planSource?.sql).toContain("title IS NULL OR (char_length(title) BETWEEN 1 AND 160)");
  });

  it("adds constrained minimum_model column for PLAN clipboard items", async () => {
    const migrations = await loadMigrations();
    const minModel = migrations.find((migration) => migration.id === "0125_plan_minimum_model");

    expect(minModel).toBeDefined();
    expect(minModel?.sql).toContain("ADD COLUMN IF NOT EXISTS minimum_model text");
    expect(minModel?.sql).toContain("minimum_model IS NULL OR (char_length(minimum_model) BETWEEN 1 AND 160)");
  });

  it("adds private per-user task history with status lifecycle and exact-content deduplication", async () => {
    const migrations = await loadMigrations();
    const tasks = migrations.find((migration) => migration.id === "0072_task_items");

    expect(tasks).toBeDefined();
    expect(tasks?.sql).toContain("CREATE TABLE IF NOT EXISTS task_items");
    expect(tasks?.sql).toContain("owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE");
    expect(tasks?.sql).toContain("content_hash text NOT NULL");
    expect(tasks?.sql).toContain("UNIQUE (owner_user_id, content_hash)");
    expect(tasks?.sql).toContain("status text NOT NULL CHECK (status IN ('OPEN', 'RUNNING', 'DONE', 'ARCHIVED'))");
    expect(tasks?.sql).toContain("source text NOT NULL CHECK (source IN ('MANUAL', 'AGENT'))");
    expect(tasks?.sql).toContain("char_length(title) BETWEEN 1 AND 160");
    expect(tasks?.sql).toContain("char_length(objective) BETWEEN 1 AND 10000");
    expect(tasks?.sql).toContain("idx_task_items_owner_recent");
    expect(tasks?.sql).toContain("idx_task_items_owner_status");
    expect(tasks?.sql).not.toMatch(/audit|event|log/i);
  });

  it("persists page scroll and video playback restore state on closed browser sessions", async () => {
    const migrations = await loadMigrations();
    const restoreState = migrations.find((migration) => migration.id === "0070_pane_browser_session_restore_state");

    expect(restoreState).toBeDefined();
    expect(restoreState?.sql).toContain("ADD COLUMN IF NOT EXISTS restore_scroll_x integer");
    expect(restoreState?.sql).toContain("ADD COLUMN IF NOT EXISTS restore_scroll_y integer");
    expect(restoreState?.sql).toContain("ADD COLUMN IF NOT EXISTS restore_video_paused boolean");
  });

  it("adds a commit-ordered event relay sequence and chronology index", async () => {
    const migrations = await loadMigrations();
    const eventChronology = migrations.find((migration) => migration.id === "0047_event_chronology_index");

    expect(eventChronology?.sql).toContain("CREATE INDEX IF NOT EXISTS idx_events_created_at_id");
    expect(eventChronology?.sql).toContain("events (created_at, id)");
    expect(eventChronology?.sql).toContain("CREATE TABLE IF NOT EXISTS event_relay_state");
    expect(eventChronology?.sql).toContain("LOCK TABLE events");
    expect(eventChronology?.sql).toContain("relay_sequence bigint");
    expect(eventChronology?.sql).toContain("UPDATE event_relay_state");
    expect(eventChronology?.sql).toContain("CREATE TRIGGER set_event_relay_sequence");
    expect(eventChronology?.sql).toContain("ALTER COLUMN relay_sequence SET NOT NULL");
    expect(eventChronology?.sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_relay_sequence");
  });

  it("adds nullable constrained pane layout columns to rooms", async () => {
    const migrations = await loadMigrations();
    const paneLayouts = migrations.find((migration) => migration.id === "0045_room_pane_layout_columns");

    expect(paneLayouts?.sql).toContain("pane_layout_columns smallint");
    expect(paneLayouts?.sql).toContain("pane_layout_columns IS NULL");
    expect(paneLayouts?.sql).toContain("pane_layout_columns BETWEEN 1 AND 4");
  });

  it("relaxes the pane layout constraint to allow the fullscreen layout", async () => {
    const migrations = await loadMigrations();
    const fullscreenLayout = migrations.find((migration) => migration.id === "0077_room_pane_layout_fullscreen");

    expect(fullscreenLayout?.sql).toContain("DROP CONSTRAINT IF EXISTS rooms_pane_layout_columns_check");
    expect(fullscreenLayout?.sql).toContain("ADD CONSTRAINT rooms_pane_layout_columns_check");
    expect(fullscreenLayout?.sql).toContain("pane_layout_columns IS NULL");
    expect(fullscreenLayout?.sql).toContain("pane_layout_columns BETWEEN 0 AND 4");
  });

  it("classifies existing rooms as workspaces and constrains agent proof rooms", async () => {
    const migrations = await loadMigrations();
    const proofRooms = migrations.find((migration) => migration.id === "0050_agent_proof_rooms");

    expect(proofRooms?.sql).toContain("ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'WORKSPACE'");
    expect(proofRooms?.sql).toContain("kind IN ('WORKSPACE', 'AGENT_PROOF')");
  });

  it("persists one-shot CLI launch mode for native task resume", async () => {
    const migrations = await loadMigrations();
    const cliLaunchMode = migrations.find((migration) => migration.id === "0051_pane_cli_launch_mode");

    expect(cliLaunchMode?.sql).toContain("ADD COLUMN IF NOT EXISTS launch_mode text NOT NULL DEFAULT 'FRESH'");
    expect(cliLaunchMode?.sql).toContain("launch_mode IN ('FRESH', 'RESUME')");
  });

  it("adds a rollback-compatible CLI session purpose for non-durable login sessions", async () => {
    const migrations = await loadMigrations();
    const cliPurpose = migrations.find((migration) => migration.id === "0052_pane_cli_session_purpose");

    expect(cliPurpose?.sql).toContain("ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'NORMAL'");
    expect(cliPurpose?.sql).toContain("purpose IN ('NORMAL', 'LOGIN')");
  });

  it("persists only allowlisted global CLI visibility settings with enabled defaults", async () => {
    const migrations = await loadMigrations();
    const runtimeSettings = migrations.find((migration) => migration.id === "0053_cli_runtime_settings");

    expect(runtimeSettings?.sql).toContain("CREATE TABLE IF NOT EXISTS cli_runtime_settings");
    expect(runtimeSettings?.sql).toContain("enabled boolean NOT NULL DEFAULT true");
    expect(runtimeSettings?.sql).toContain("'cli:deepseek'");
    expect(runtimeSettings?.sql).not.toContain("'cli:root'");
    expect(runtimeSettings?.sql).toContain("ON CONFLICT (runtime_id) DO NOTHING");
  });

  it("backfills a title-independent logical CLI task registry without deleting technical sessions", async () => {
    const migrations = await loadMigrations();
    const logicalTasks = migrations.find((migration) => migration.id === "0054_cli_logical_tasks");

    expect(logicalTasks?.sql).toContain("CREATE TABLE IF NOT EXISTS cli_tasks");
    expect(logicalTasks?.sql).toContain("CREATE TABLE IF NOT EXISTS cli_task_revisions");
    expect(logicalTasks?.sql).toContain("ADD COLUMN IF NOT EXISTS cli_task_id text");
    expect(logicalTasks?.sql).toContain("ADD COLUMN IF NOT EXISTS cli_task_revision_id text");
    expect(logicalTasks?.sql).toContain("metadata->>'sourceTaskId'");
    expect(logicalTasks?.sql).toContain("metadata->>'codexThreadId'");
    expect(logicalTasks?.sql).toContain("WHERE native_task_ref IS NOT NULL");
    expect(logicalTasks?.sql).toContain("length(reasoning_effort) BETWEEN 1 AND 80");
    expect(logicalTasks?.sql).toContain("reasoning_effort ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'");
    expect(logicalTasks?.sql).not.toContain("reasoning_effort IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh')");
    expect(logicalTasks?.sql).not.toMatch(/DELETE\s+FROM\s+pane_cli_sessions/i);
    expect(logicalTasks?.sql).not.toMatch(
      /PARTITION BY\s+(?:[a-z_]+\.)?(?:title|first_user_message|preview)(?:\s|,|\))/i
    );
  });

  it("adds durable allowlisted admin operations without persisting publishing credentials", async () => {
    const migrations = await loadMigrations();
    const adminOperations = migrations.find((migration) => migration.id === "0056_admin_operations");

    expect(adminOperations?.sql).toContain("CREATE TABLE IF NOT EXISTS admin_operation_runs");
    expect(adminOperations?.sql).toContain("CLI_MAINTENANCE_CHECK");
    expect(adminOperations?.sql).toContain("CLI_MAINTENANCE_UPDATE");
    expect(adminOperations?.sql).toContain("SPACE_RELEASE");
    expect(adminOperations?.sql).toContain("CREATE TABLE IF NOT EXISTS source_control_connections");
    expect(adminOperations?.sql).toContain("provider IN ('gitea', 'github')");
    expect(adminOperations?.sql).toContain("secret_ref text");
    expect(adminOperations?.sql).toContain("CREATE TABLE IF NOT EXISTS release_previews");
    expect(adminOperations?.sql).toContain("expires_at timestamptz");
    expect(adminOperations?.sql).not.toMatch(/\b(token|password|credential)\b/i);
  });

  it("adds rollback-compatible CLI repair events, auth handoffs, and recovery rooms", async () => {
    const migrations = await loadMigrations();
    const repair = migrations.find((migration) => migration.id === "0058_cli_maintenance_repair");

    expect(repair?.sql).toContain("CLI_MAINTENANCE_REPAIR");
    expect(repair?.sql).toContain("kind IN ('WORKSPACE', 'AGENT_PROOF', 'CLI_RECOVERY')");
    expect(repair?.sql).toContain("CREATE TABLE IF NOT EXISTS cli_maintenance_events");
    expect(repair?.sql).toContain("UNIQUE (run_id, sequence)");
    expect(repair?.sql).toContain("CREATE TABLE IF NOT EXISTS cli_maintenance_auth_handoffs");
    expect(repair?.sql).toContain("diagnostics jsonb");
    expect(repair?.sql).not.toMatch(/\b(access_token|refresh_token|password|cookie_value)\b/i);
  });

  it("adds Cursor and GitHub Copilot to every persisted CLI runtime allowlist", async () => {
    const migrations = await loadMigrations();
    const cursorCopilot = migrations.find((migration) => migration.id === "0061_cursor_copilot_cli_runtimes");

    expect(cursorCopilot?.sql).toContain("cli_runtime_settings_runtime_id_check");
    expect(cursorCopilot?.sql).toContain("cli_maintenance_events_runtime_id_check");
    expect(cursorCopilot?.sql).toContain("cli_maintenance_auth_handoffs_runtime_id_check");
    expect(cursorCopilot?.sql).toContain("'cli:cursor'");
    expect(cursorCopilot?.sql).toContain("'cli:copilot'");
    expect(cursorCopilot?.sql).toContain("ON CONFLICT (runtime_id) DO NOTHING");
  });

  it("adds Autohand to every persisted CLI runtime allowlist with an enabled default", async () => {
    const migrations = await loadMigrations();
    const autohand = migrations.find((migration) => migration.id === "0063_autohand_cli_runtime");

    expect(autohand?.sql).toContain("cli_runtime_settings_runtime_id_check");
    expect(autohand?.sql).toContain("cli_maintenance_events_runtime_id_check");
    expect(autohand?.sql).toContain("cli_maintenance_auth_handoffs_runtime_id_check");
    expect(autohand?.sql).toContain("'cli:autohand'");
    expect(autohand?.sql).toContain("ON CONFLICT (runtime_id) DO NOTHING");
  });

  it("migrates one deterministic existing administrator without claiming a fresh install", async () => {
    const migrations = await loadMigrations();
    const ownerSetup = migrations.find((migration) => migration.id === "0064_single_owner_setup");
    const onboarding = migrations.find(
      (migration) => migration.id === "0065_setup_connections_wizard"
    );

    expect(ownerSetup).toBeDefined();
    expect(ownerSetup?.sql).not.toMatch(/INSERT\s+INTO\s+space_owner_setup/i);

    expect(onboarding).toBeDefined();
    expect(onboarding?.sql).toContain("INSERT INTO space_owner_setup");
    expect(onboarding?.sql).toContain("FROM users");
    expect(onboarding?.sql).toContain("WHERE role = 'ADMIN'");
    expect(onboarding?.sql).toContain(
      "ORDER BY CASE WHEN id = 'user:operator' THEN 0 ELSE 1 END, id"
    );
    expect(onboarding?.sql).toContain("LIMIT 1");
    expect(onboarding?.sql).toContain("ON CONFLICT (singleton) DO NOTHING");
    expect(onboarding?.sql).toContain("onboarding_completed_at");
    expect(onboarding?.sql).toContain("CREATE TABLE IF NOT EXISTS space_setup_connection_verifications");
    expect(onboarding?.sql).toContain(
      "connection_id text PRIMARY KEY CHECK (connection_id ~ '^[a-z0-9][a-z0-9:_-]{0,159}$')"
    );
    expect(onboarding?.sql).toContain(
      "state text NOT NULL CHECK (state IN ('CONNECTED', 'NEEDS_SETUP', 'UNAVAILABLE'))"
    );
    expect(onboarding?.sql).toContain(
      "reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z0-9_]{1,80}$')"
    );
    expect(onboarding?.sql).toContain(
      "fingerprint_hash text CHECK (fingerprint_hash IS NULL OR fingerprint_hash ~ '^[a-f0-9]{64}$')"
    );
  });

  it("adds durable redacted setup connection check runs and replay events", async () => {
    const migrations = await loadMigrations();
    const checks = migrations.find(
      (migration) => migration.id === "0066_setup_connection_check_runs"
    );

    expect(checks?.sql).toContain("CREATE TABLE IF NOT EXISTS space_setup_connection_check_runs");
    expect(checks?.sql).toContain("CREATE TABLE IF NOT EXISTS space_setup_connection_check_events");
    expect(checks?.sql).toContain("UNIQUE (run_id, sequence)");
    expect(checks?.sql).toContain("scope IN ('ALL', 'SINGLE')");
    expect(checks?.sql).toContain("status IN ('RUNNING', 'COMPLETED')");
    expect(checks?.sql).toContain("completed_count <= total_count");
    expect(checks?.sql).toContain("functional_state IN ('FUNCTIONAL', 'NEEDS_SETUP', 'UNAVAILABLE')");
    expect(checks?.sql).toContain(
      "live_verification_state IN ('VERIFIED', 'QUOTA_LIMITED', 'NOT_CHECKED', 'PROVIDER_FAILED', 'TIMED_OUT', 'CREDENTIAL_CHANGED')"
    );
    expect(checks?.sql).not.toMatch(
      /\b(nonce|fingerprint|stdout|stderr|access_token|refresh_token|provider_payload)\b/i
    );
  });

  it("renames the persisted Gitea Space repository without rotating its secret", async () => {
    const migrations = await loadMigrations();
    const repositoryRename = migrations.find(
      (migration) => migration.id === "0062_source_control_space_repository"
    );

    expect(repositoryRename?.sql).toContain("UPDATE source_control_connections");
    expect(repositoryRename?.sql).toContain("repository_name = 'space'");
    expect(repositoryRename?.sql).toContain("provider = 'gitea'");
    expect(repositoryRename?.sql).toContain(
      "DROP CONSTRAINT IF EXISTS source_control_connections_repository_name_check"
    );
    expect(repositoryRename?.sql).toContain(
      "DROP CONSTRAINT IF EXISTS source_control_connections_check"
    );
    expect(repositoryRename?.sql).not.toContain("FROM pg_constraint");
    expect(repositoryRename?.sql).not.toMatch(/SET\s+secret_ref/i);
  });

  it("aligns the source control repository check constraint with the spaceapp seed", async () => {
    const migrations = await loadMigrations();
    const spaceappConstraint = migrations.find(
      (migration) => migration.id === "0082_source_control_spaceapp_repository"
    );

    expect(spaceappConstraint).toBeDefined();
    expect(spaceappConstraint?.sql).toContain(
      "DROP CONSTRAINT IF EXISTS source_control_connections_repository_name_check"
    );
    expect(spaceappConstraint?.sql).toContain("repository_name = 'spaceapp'");
    expect(spaceappConstraint?.sql).toContain(
      "provider IN ('gitea', 'github')"
    );
    expect(spaceappConstraint?.sql).toContain(
      "ADD CONSTRAINT source_control_connections_repository_name_check"
    );
    expect(spaceappConstraint?.sql).toContain("provider = 'gitea' AND repository_name = 'spaceapp'");
    expect(spaceappConstraint?.sql).toContain("provider = 'github' AND repository_name = 'spaceapp'");
  });

  it("defines the canonical Postgres foundation for durable Space state", async () => {
    const migrations = await loadMigrations();
    const initial = migrations.find((migration) => migration.id === "0001_initial");

    expect(initial).toBeDefined();
    expect(initial?.sql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(initial?.sql).toContain("CREATE TABLE IF NOT EXISTS rooms");
    expect(initial?.sql).toContain("CREATE TABLE IF NOT EXISTS panes");
    expect(initial?.sql).toContain("CREATE TABLE IF NOT EXISTS workflows");
    expect(initial?.sql).toContain("CREATE TABLE IF NOT EXISTS artifacts");
    expect(initial?.sql).toContain("CREATE TABLE IF NOT EXISTS outbox_events");
    expect(initial?.sql).not.toMatch(/bytea/i);

    const providerValidation = migrations.find((migration) => migration.id === "0002_provider_validation_checks");
    expect(providerValidation?.sql).toContain("CREATE TABLE IF NOT EXISTS provider_validation_checks");
    expect(providerValidation?.sql).toContain("idx_provider_validation_checks_latest");

    const codexHandshakeChecks = migrations.find((migration) => migration.id === "0003_codex_app_server_handshake_checks");
    expect(codexHandshakeChecks?.sql).toContain("CREATE TABLE IF NOT EXISTS codex_app_server_handshake_checks");
    expect(codexHandshakeChecks?.sql).toContain("idx_codex_app_server_handshake_checks_latest");
    expect(codexHandshakeChecks?.sql).toContain("server_info jsonb");

    const codexTurnSmokeChecks = migrations.find((migration) => migration.id === "0004_codex_app_server_turn_smoke_checks");
    expect(codexTurnSmokeChecks?.sql).toContain("CREATE TABLE IF NOT EXISTS codex_app_server_turn_smoke_checks");
    expect(codexTurnSmokeChecks?.sql).toContain("idx_codex_app_server_turn_smoke_checks_latest");
    expect(codexTurnSmokeChecks?.sql).not.toMatch(/prompt/i);

    const mcpDiscoverySmokeChecks = migrations.find((migration) => migration.id === "0005_mcp_discovery_smoke_checks");
    expect(mcpDiscoverySmokeChecks?.sql).toContain("CREATE TABLE IF NOT EXISTS mcp_discovery_smoke_checks");
    expect(mcpDiscoverySmokeChecks?.sql).toContain("idx_mcp_discovery_smoke_checks_latest");
    expect(mcpDiscoverySmokeChecks?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const mcpDiscoveryCatalog = migrations.find((migration) => migration.id === "0006_mcp_discovery_catalog");
    expect(mcpDiscoveryCatalog?.sql).toContain("ALTER TABLE mcp_servers");
    expect(mcpDiscoveryCatalog?.sql).toContain("status_reason");
    expect(mcpDiscoveryCatalog?.sql).toContain("tool_count");
    expect(mcpDiscoveryCatalog?.sql).toContain("last_discovered_at");
    expect(mcpDiscoveryCatalog?.sql).toContain("ALTER TABLE mcp_tools");
    expect(mcpDiscoveryCatalog?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const memoryRegistryIndexes = migrations.find((migration) => migration.id === "0007_memory_registry_indexes");
    expect(memoryRegistryIndexes?.sql).toContain("idx_memory_records_scope_created");
    expect(memoryRegistryIndexes?.sql).toContain("idx_memory_records_room_created");
    expect(memoryRegistryIndexes?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const skillProposalMetadata = migrations.find((migration) => migration.id === "0008_skill_proposal_metadata");
    expect(skillProposalMetadata?.sql).toContain("ALTER TABLE skills");
    expect(skillProposalMetadata?.sql).toContain("body text");
    expect(skillProposalMetadata?.sql).toContain("source text");
    expect(skillProposalMetadata?.sql).toContain("idx_skills_source_updated_at");
    expect(skillProposalMetadata?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const memoryEmbeddingSmokeChecks = migrations.find((migration) => migration.id === "0009_memory_embedding_smoke_checks");
    expect(memoryEmbeddingSmokeChecks?.sql).toContain("CREATE TABLE IF NOT EXISTS memory_embedding_smoke_checks");
    expect(memoryEmbeddingSmokeChecks?.sql).toContain("idx_memory_embedding_smoke_checks_latest");
    expect(memoryEmbeddingSmokeChecks?.sql).toContain("EMBEDDING_PROVIDER_UNVERIFIED");
    expect(memoryEmbeddingSmokeChecks?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const memoryEmbeddingIndex = migrations.find((migration) => migration.id === "0010_memory_embedding_hnsw_index");
    expect(memoryEmbeddingIndex?.sql).toContain("idx_memory_records_embedding_hnsw");
    expect(memoryEmbeddingIndex?.sql).toContain("USING hnsw");
    expect(memoryEmbeddingIndex?.sql).toContain("vector_cosine_ops");

    const memoryEmbeddingProviderCodes = migrations.find(
      (migration) => migration.id === "0011_memory_embedding_provider_smoke_codes"
    );
    expect(memoryEmbeddingProviderCodes?.sql).toContain("memory_embedding_smoke_checks_code_check");
    expect(memoryEmbeddingProviderCodes?.sql).toContain("EMBEDDING_PROVIDER_SMOKE_FAILED");
    expect(memoryEmbeddingProviderCodes?.sql).toContain("EMBEDDING_DIMENSIONS_MISMATCH");
    expect(memoryEmbeddingProviderCodes?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const importCandidates = migrations.find((migration) => migration.id === "0012_import_candidates");
    expect(importCandidates?.sql).toContain("CREATE TABLE IF NOT EXISTS import_candidates");
    expect(importCandidates?.sql).toContain("idx_import_candidates_status_created");
    expect(importCandidates?.sql).toContain("imported_memory_id");
    expect(importCandidates?.sql).toContain("imported_skill_id");
    expect(importCandidates?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const swarmControlPlane = migrations.find((migration) => migration.id === "0013_swarm_control_plane");
    expect(swarmControlPlane?.sql).toContain("CREATE TABLE IF NOT EXISTS swarm_tasks");
    expect(swarmControlPlane?.sql).toContain("CREATE TABLE IF NOT EXISTS swarm_locks");
    expect(swarmControlPlane?.sql).toContain("idx_swarm_locks_active_resource");
    expect(swarmControlPlane?.sql).toContain("CREATE TABLE IF NOT EXISTS swarm_messages");
    expect(swarmControlPlane?.sql).toContain("CREATE TABLE IF NOT EXISTS swarm_reconciles");
    expect(swarmControlPlane?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const reviewAggregation = migrations.find((migration) => migration.id === "0014_review_aggregation");
    expect(reviewAggregation?.sql).toContain("CREATE TABLE IF NOT EXISTS review_checks");
    expect(reviewAggregation?.sql).toContain("CREATE TABLE IF NOT EXISTS review_diff_summaries");
    expect(reviewAggregation?.sql).toContain("idx_review_checks_room_created");
    expect(reviewAggregation?.sql).toContain("idx_review_diff_summaries_room_created");
    expect(reviewAggregation?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const turnPromptHistory = migrations.find((migration) => migration.id === "0015_turn_prompt_history");
    expect(turnPromptHistory?.sql).toContain("ALTER TABLE turns");
    expect(turnPromptHistory?.sql).toContain("ADD COLUMN IF NOT EXISTS prompt text");

    const paneAgentBindings = migrations.find((migration) => migration.id === "0016_pane_agent_bindings");
    expect(paneAgentBindings?.sql).toContain("CREATE TABLE IF NOT EXISTS pane_agent_bindings");
    expect(paneAgentBindings?.sql).toContain("pane_id text PRIMARY KEY REFERENCES panes(id) ON DELETE CASCADE");
    expect(paneAgentBindings?.sql).toContain("source text NOT NULL CHECK (source IN ('CODER'))");
    expect(paneAgentBindings?.sql).toContain("coder_chat_id text");
    expect(paneAgentBindings?.sql).toContain("selected_model_config_id text");
    expect(paneAgentBindings?.sql).toContain("idx_pane_agent_bindings_coder_chat_id");
    expect(paneAgentBindings?.sql).not.toContain("ALTER TABLE panes");
    expect(paneAgentBindings?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const paneAgentSelection = migrations.find((migration) => migration.id === "0017_pane_agent_selection_metadata");
    expect(paneAgentSelection?.sql).toContain("ALTER TABLE pane_agent_bindings");
    expect(paneAgentSelection?.sql).toContain("ADD COLUMN IF NOT EXISTS selected_provider_name text");
    expect(paneAgentSelection?.sql).toContain("ADD COLUMN IF NOT EXISTS selected_model_name text");
    expect(paneAgentSelection?.sql).toContain("ADD COLUMN IF NOT EXISTS selected_reasoning_key text");
    expect(paneAgentSelection?.sql).not.toContain("ALTER TABLE panes");
    expect(paneAgentSelection?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const paneAgentToolSelection = migrations.find((migration) => migration.id === "0018_pane_agent_tool_selection");
    expect(paneAgentToolSelection?.sql).toContain("ALTER TABLE pane_agent_bindings");
    expect(paneAgentToolSelection?.sql).toContain("ADD COLUMN IF NOT EXISTS selected_tool_ids text[]");
    expect(paneAgentToolSelection?.sql).not.toContain("ALTER TABLE panes");
    expect(paneAgentToolSelection?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const paneAgentSessions = migrations.find((migration) => migration.id === "0019_pane_agent_sessions");
    expect(paneAgentSessions?.sql).toContain("CREATE TABLE IF NOT EXISTS pane_agent_sessions");
    expect(paneAgentSessions?.sql).toContain("PRIMARY KEY (pane_id, coder_chat_id)");
    expect(paneAgentSessions?.sql).toContain("idx_pane_agent_sessions_room_updated_at");
    expect(paneAgentSessions?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const spaceAgentSessions = migrations.find((migration) => migration.id === "0020_space_agent_sessions");
    expect(spaceAgentSessions?.sql).toContain("CREATE TABLE IF NOT EXISTS space_agent_sessions");
    expect(spaceAgentSessions?.sql).toContain("source text NOT NULL DEFAULT 'SPACE' CHECK (source IN ('SPACE'))");
    expect(spaceAgentSessions?.sql).toContain("CREATE TABLE IF NOT EXISTS space_agent_messages");
    expect(spaceAgentSessions?.sql).toContain("CREATE TABLE IF NOT EXISTS space_agent_runs");
    expect(spaceAgentSessions?.sql).toContain("idx_space_agent_sessions_one_active_per_pane");
    expect(spaceAgentSessions?.sql).toContain("idx_space_agent_runs_workflow_id");
    expect(spaceAgentSessions?.sql).not.toContain("192.0.2.216");
    expect(spaceAgentSessions?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const paneCliSessions = migrations.find((migration) => migration.id === "0021_pane_cli_sessions");
    expect(paneCliSessions?.sql).toContain("CREATE TABLE IF NOT EXISTS pane_cli_sessions");
    expect(paneCliSessions?.sql).toContain("CREATE TABLE IF NOT EXISTS pane_cli_transcript_chunks");
    expect(paneCliSessions?.sql).toContain("idx_pane_cli_sessions_one_active_per_pane");
    expect(paneCliSessions?.sql).toContain("idx_pane_cli_transcript_chunks_session_sequence");
    expect(paneCliSessions?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const paneBrowserSessions = migrations.find((migration) => migration.id === "0022_pane_browser_sessions");
    expect(paneBrowserSessions?.sql).toContain("CREATE TABLE IF NOT EXISTS pane_browser_sessions");
    expect(paneBrowserSessions?.sql).toContain("profile_path text NOT NULL");
    expect(paneBrowserSessions?.sql).toContain("viewport text NOT NULL CHECK (viewport IN ('mobile', 'tablet', 'desktop'))");
    expect(paneBrowserSessions?.sql).toContain("idx_pane_browser_sessions_one_active_per_pane");
    expect(paneBrowserSessions?.sql).toContain("idx_pane_browser_sessions_room_active");
    expect(paneBrowserSessions?.sql).not.toMatch(/bytea/i);
    expect(paneBrowserSessions?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const providerGlobalSettings = migrations.find((migration) => migration.id === "0023_provider_global_settings");
    expect(providerGlobalSettings?.sql).toContain("CREATE TABLE IF NOT EXISTS provider_settings");
    expect(providerGlobalSettings?.sql).toContain("default_provider_id text NOT NULL");
    expect(providerGlobalSettings?.sql).toContain("route_profile");
    expect(providerGlobalSettings?.sql).toContain("codex-lb");
    expect(providerGlobalSettings?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const paneCliSessionCodexThread = migrations.find(
      (migration) => migration.id === "0024_pane_cli_session_codex_thread"
    );
    expect(paneCliSessionCodexThread?.sql).toContain("ALTER TABLE pane_cli_sessions");
    expect(paneCliSessionCodexThread?.sql).toContain("ADD COLUMN IF NOT EXISTS codex_thread_id text");
    expect(paneCliSessionCodexThread?.sql).toContain("idx_pane_cli_sessions_codex_thread_id");
    expect(paneCliSessionCodexThread?.sql).toContain("WHERE codex_thread_id IS NOT NULL");
    expect(paneCliSessionCodexThread?.sql).not.toMatch(
      new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i")
    );

    const paneColumnSpan = migrations.find((migration) => migration.id === "0027_pane_column_span");
    expect(paneColumnSpan?.sql).toContain("ALTER TABLE panes");
    expect(paneColumnSpan?.sql).toContain("ADD COLUMN IF NOT EXISTS column_span integer NOT NULL DEFAULT 1");
    expect(paneColumnSpan?.sql).toContain("CHECK (column_span BETWEEN 1 AND 3)");
    expect(paneColumnSpan?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const independentCliHost = migrations.find((migration) => migration.id === "0029_independent_cli_host");
    expect(independentCliHost?.sql).toContain("ADD COLUMN IF NOT EXISTS host_generation_id uuid");
    expect(independentCliHost?.sql).toContain("ADD COLUMN IF NOT EXISTS host_output_sequence bigint");
    expect(independentCliHost?.sql).toContain("idx_pane_cli_transcript_host_output");
    expect(independentCliHost?.sql).toContain("CREATE TABLE IF NOT EXISTS pane_cli_codex_thread_ownerships");
    expect(independentCliHost?.sql).toContain("source IN ('AUTO', 'HISTORY_TRANSFER', 'MIGRATION')");
    expect(independentCliHost?.sql).not.toMatch(
      new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i")
    );

    const agentSessionPermissions = migrations.find((migration) => migration.id === "0030_agent_session_permissions");
    expect(agentSessionPermissions?.sql).toContain("ALTER TABLE space_agent_sessions");
    expect(agentSessionPermissions?.sql).toContain("ADD COLUMN IF NOT EXISTS permission_mode text");
    expect(agentSessionPermissions?.sql).toContain("ADD COLUMN IF NOT EXISTS collaboration_mode text");
    expect(agentSessionPermissions?.sql).toContain("ask_for_approval");
    expect(agentSessionPermissions?.sql).toContain("approve_for_me");
    expect(agentSessionPermissions?.sql).toContain("full_access");
    expect(agentSessionPermissions?.sql).toContain("'default', 'plan'");
    expect(agentSessionPermissions?.sql).not.toMatch(/UPDATE\s+space_agent_sessions/i);

    const paneTerminalRuntime = migrations.find((migration) => migration.id === "0031_pane_terminal_runtime");
    expect(paneTerminalRuntime?.sql).toContain("ALTER TABLE panes");
    expect(paneTerminalRuntime?.sql).toContain("ADD COLUMN IF NOT EXISTS terminal_runtime_id text");
    expect(paneTerminalRuntime?.sql).not.toMatch(
      new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i")
    );

    const browserPaneV2 = migrations.find((migration) => migration.id === "0033_browser_pane_v2");
    expect(browserPaneV2?.sql).toContain("ADD COLUMN IF NOT EXISTS stream_mode text NOT NULL DEFAULT 'AUTO'");
    expect(browserPaneV2?.sql).toContain("CREATE TABLE IF NOT EXISTS browser_control_leases");
    expect(browserPaneV2?.sql).toContain("idx_browser_control_leases_one_active_per_session");
    expect(browserPaneV2?.sql).toContain("CREATE TABLE IF NOT EXISTS browser_capture_jobs");
    expect(browserPaneV2?.sql).toContain("idx_browser_capture_jobs_queue");
    expect(browserPaneV2?.sql).toContain("ADD COLUMN IF NOT EXISTS expires_at timestamptz");
    expect(browserPaneV2?.sql).toContain("ADD COLUMN IF NOT EXISTS pinned_at timestamptz");
    expect(browserPaneV2?.sql).toContain("ADD COLUMN IF NOT EXISTS deleted_at timestamptz");
    expect(browserPaneV2?.sql).not.toMatch(new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i"));

    const roomAgentSupervisor = migrations.find((migration) => migration.id === "0034_room_agent_supervisor");
    expect(roomAgentSupervisor?.sql).toContain("CREATE TABLE IF NOT EXISTS room_agent_bindings");
    expect(roomAgentSupervisor?.sql).toContain("room_id text PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE");
    expect(roomAgentSupervisor?.sql).toContain("pane_id text UNIQUE NOT NULL REFERENCES panes(id) ON DELETE CASCADE");
    expect(roomAgentSupervisor?.sql).toContain("CREATE TABLE IF NOT EXISTS room_agent_requests");
    expect(roomAgentSupervisor?.sql).toContain("UNIQUE (room_id, client_request_id)");
    expect(roomAgentSupervisor?.sql).toContain("CREATE TABLE IF NOT EXISTS room_agent_missions");
    expect(roomAgentSupervisor?.sql).toContain("turn_payload jsonb");
    expect(roomAgentSupervisor?.sql).not.toMatch(/workflow_id text UNIQUE NOT NULL/);
    expect(roomAgentSupervisor?.sql).toContain("CREATE TABLE IF NOT EXISTS room_agent_actions");
    expect(roomAgentSupervisor?.sql).not.toMatch(
      new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i")
    );

    const roomAgentGoalRunner = migrations.find((migration) => migration.id === "0035_room_agent_goal_runner");
    expect(roomAgentGoalRunner?.sql).toContain("transcript_cleared_at");
    expect(roomAgentGoalRunner?.sql).toContain("mission_id text REFERENCES room_agent_missions");
    expect(roomAgentGoalRunner?.sql).toContain("'PAUSED'");
    expect(roomAgentGoalRunner?.sql).toContain("execution_state jsonb");
    expect(roomAgentGoalRunner?.sql).not.toMatch(
      new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i")
    );

    const browserRecordingHandoff = migrations.find((migration) => migration.id === "0034_browser_recording_handoff");
    expect(browserRecordingHandoff?.sql).toContain("CREATE TABLE IF NOT EXISTS browser_capture_segments");
    expect(browserRecordingHandoff?.sql).toContain("UNIQUE (job_id, segment_sequence)");
    expect(browserRecordingHandoff?.sql).toContain("idx_browser_capture_segments_open");
    expect(browserRecordingHandoff?.sql).toContain("CREATE TABLE IF NOT EXISTS browser_handoff_requests");
    expect(browserRecordingHandoff?.sql).toContain("'REQUESTED', 'ACCEPTED', 'COMPLETED', 'EXPIRED', 'CANCELLED'");
    expect(browserRecordingHandoff?.sql).toContain("operator_user_id text REFERENCES users(id)");
    expect(browserRecordingHandoff?.sql).toContain("idx_browser_handoff_requests_one_active_per_session");
    expect(browserRecordingHandoff?.sql).not.toMatch(
      new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i")
    );

    const memoryGraphChangeSets = migrations.find((migration) => migration.id === "0037_memory_graph_change_sets");
    expect(memoryGraphChangeSets?.sql).toContain("CREATE TABLE IF NOT EXISTS memory_graph_change_sets");
    expect(memoryGraphChangeSets?.sql).toContain("rollback_of_change_set_id text REFERENCES memory_graph_change_sets(id)");
    expect(memoryGraphChangeSets?.sql).toContain("rolled_back_by_change_set_id text REFERENCES memory_graph_change_sets(id)");
    expect(memoryGraphChangeSets?.sql).toContain("expected_source_hash ~ '^[a-f0-9]{64}$'");
    expect(memoryGraphChangeSets?.sql).toContain("idx_memory_graph_change_sets_status_created");
    expect(memoryGraphChangeSets?.sql).toContain("idx_memory_graph_change_sets_source_created");
    expect(memoryGraphChangeSets?.sql).not.toMatch(
      new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i")
    );

    const memoryGraphDurableState = migrations.find((migration) => migration.id === "0038_memory_graph_durable_state");
    expect(memoryGraphDurableState?.sql).toContain("ADD COLUMN IF NOT EXISTS canonical_memory_id");
    expect(memoryGraphDurableState?.sql).toContain("CREATE TABLE IF NOT EXISTS memory_graph_issue_states");
    expect(memoryGraphDurableState?.sql).toContain("CREATE TABLE IF NOT EXISTS memory_consolidation_runs");
    expect(memoryGraphDurableState?.sql).toContain("CREATE TABLE IF NOT EXISTS memory_consolidation_findings");
    expect(memoryGraphDurableState?.sql).toContain("CREATE TABLE IF NOT EXISTS memory_consolidation_operations");
    expect(memoryGraphDurableState?.sql).toContain("CREATE TABLE IF NOT EXISTS memory_command_idempotency");
    expect(memoryGraphDurableState?.sql).toContain("UNIQUE (command_scope, actor_key, idempotency_key_hash)");
    expect(memoryGraphDurableState?.sql).toContain("CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$')");
    expect(memoryGraphDurableState?.sql).not.toContain("before_snapshot");
    expect(memoryGraphDurableState?.sql).not.toContain("after_snapshot");
    expect(memoryGraphDurableState?.sql).not.toMatch(
      new RegExp("api[_-]?key|sec" + "ret|pass" + "word|tok" + "en", "i")
    );
  });

  it("permits max, ultra, and future safe CLI reasoning identifiers", async () => {
    const migrations = await loadMigrations();
    const paneCliReasoningEfforts = migrations.find(
      (migration) => migration.id === "0039_pane_cli_reasoning_efforts"
    );

    expect(paneCliReasoningEfforts).toBeDefined();
    expect(paneCliReasoningEfforts?.sql).toContain(
      "DROP CONSTRAINT IF EXISTS pane_cli_sessions_reasoning_effort_check"
    );
    expect(paneCliReasoningEfforts?.sql).toContain(
      "ADD CONSTRAINT pane_cli_sessions_reasoning_effort_check"
    );
    expect(paneCliReasoningEfforts?.sql).toContain(
      "char_length(reasoning_effort) BETWEEN 1 AND 80"
    );
    expect(paneCliReasoningEfforts?.sql).toContain(
      "reasoning_effort ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'"
    );
    expect(paneCliReasoningEfforts?.sql).not.toMatch(/reasoning_effort\s+IN\s*\(/i);
  });

  it("adds durable Telegram integration, pairing, CLI turn, and deduplicated outbox state", async () => {
    const migrations = await loadMigrations();
    const telegram = migrations.find((migration) => migration.id === "0040_telegram_notifications");

    expect(telegram).toBeDefined();
    expect(telegram?.sql).toContain("CREATE TABLE IF NOT EXISTS telegram_integrations");
    expect(telegram?.sql).toContain("CREATE TABLE IF NOT EXISTS telegram_pairing_sessions");
    expect(telegram?.sql).toContain("CREATE TABLE IF NOT EXISTS codex_cli_turn_markers");
    expect(telegram?.sql).toContain("CREATE TABLE IF NOT EXISTS telegram_notification_outbox");
    expect(telegram?.sql).toContain("source_key text NOT NULL UNIQUE");
    expect(telegram?.sql).toContain("idx_telegram_notification_outbox_claim");
    expect(telegram?.sql).toContain("code_hash ~ '^[a-f0-9]{64}$'");
    expect(telegram?.sql).not.toMatch(/bot_token|chat_token|credential_path/i);
  });

  it("snapshots Telegram agent and task labels for final completion messages", async () => {
    const migrations = await loadMigrations();
    const labels = migrations.find((migration) => migration.id === "0046_telegram_completion_labels");

    expect(labels).toBeDefined();
    expect(labels?.sql).toContain("ADD COLUMN agent_label text");
    expect(labels?.sql).toContain("ADD COLUMN task_title text");
    expect(labels?.sql).toContain("ALTER COLUMN agent_label SET DEFAULT 'Agent 1'");
    expect(labels?.sql).toContain("ALTER COLUMN task_title SET DEFAULT 'Untitled task'");
    expect(labels?.sql).toContain("SET NOT NULL");
    expect(labels?.sql).toContain("telegram_notification_outbox_agent_label_check");
    expect(labels?.sql).toContain("telegram_notification_outbox_task_title_check");
    expect(labels?.sql).not.toMatch(/bot_token|chat_token|credential_path/i);
  });

  it("adds private per-user clipboard history with exact-content deduplication", async () => {
    const migrations = await loadMigrations();
    const clipboard = migrations.find((migration) => migration.id === "0041_clipboard_items");

    expect(clipboard).toBeDefined();
    expect(clipboard?.sql).toContain("CREATE TABLE IF NOT EXISTS clipboard_items");
    expect(clipboard?.sql).toContain("owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE");
    expect(clipboard?.sql).toContain("content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$')");
    expect(clipboard?.sql).toContain("UNIQUE (owner_user_id, content_hash)");
    expect(clipboard?.sql).toContain("source IN ('COPY', 'PASTE', 'MANUAL_NOTE', 'AGENT_NOTE')");
    expect(clipboard?.sql).toContain("char_length(text) BETWEEN 1 AND 100000");
    expect(clipboard?.sql).toContain("idx_clipboard_items_owner_recent");
    expect(clipboard?.sql).not.toMatch(/audit|event|log/i);
  });

  it("adds persistent minimized pane state with a safe default", async () => {
    const migrations = await loadMigrations();
    const minimizedState = migrations.find((migration) => migration.id === "0042_pane_minimized_state");

    expect(minimizedState).toBeDefined();
    expect(minimizedState?.sql).toContain("is_minimized boolean NOT NULL DEFAULT false");
    expect(minimizedState?.sql).toContain("CHECK (NOT (is_maximized AND is_minimized))");
  });

  it("relaxes the pane column span constraint to four columns to match the layout UI", async () => {
    const migrations = await loadMigrations();
    const fourColumns = migrations.find((migration) => migration.id === "0071_pane_column_span_four");

    expect(fourColumns).toBeDefined();
    expect(fourColumns?.sql).toContain("DROP CONSTRAINT IF EXISTS panes_column_span_check");
    expect(fourColumns?.sql).toContain("ADD CONSTRAINT panes_column_span_check CHECK (column_span BETWEEN 1 AND 4)");
  });

  it("adds durable Codex CLI mode defaults without pinning provider models", async () => {
    const migrations = await loadMigrations();
    const defaults = migrations.find((migration) => migration.id === "0049_codex_cli_mode_defaults");

    expect(defaults).toBeDefined();
    expect(defaults?.sql).toContain("CREATE TABLE IF NOT EXISTS codex_cli_mode_defaults");
    expect(defaults?.sql).toContain("CHECK (id = 'global')");
    expect(defaults?.sql).toContain("build_model_id text NOT NULL");
    expect(defaults?.sql).toContain("build_reasoning_effort text NOT NULL");
    expect(defaults?.sql).toContain("plan_model_id text NOT NULL");
    expect(defaults?.sql).toContain("plan_reasoning_effort text NOT NULL");
    expect(defaults?.sql).toContain("runtime_initialized boolean NOT NULL DEFAULT false");
    expect(defaults?.sql).not.toContain("VALUES ('global'");
    expect(defaults?.sql).not.toMatch(/credential|api_key|token|secret/i);
  });

  it("adds a hash-addressed memory graph embedding cache without storing canonical text or credentials", async () => {
    const migrations = await loadMigrations();
    const semantics = migrations.find((migration) => migration.id === "0043_memory_graph_semantics");

    expect(semantics).toBeDefined();
    expect(semantics?.sql).toContain("CREATE TABLE IF NOT EXISTS memory_graph_embeddings");
    expect(semantics?.sql).toContain("canonical_memory_id text PRIMARY KEY");
    expect(semantics?.sql).toContain("content_hash text NOT NULL");
    expect(semantics?.sql).toContain("input_hash text NOT NULL");
    expect(semantics?.sql).toContain("embedding vector(1536) NOT NULL");
    expect(semantics?.sql).toContain("idx_memory_graph_embeddings_lookup");
    expect(semantics?.sql).toContain("idx_memory_graph_embeddings_hnsw");
    expect(semantics?.sql).not.toMatch(/\b(?:title|body|input_text|credential|secret|api_key)\b/i);
  });

  it("adds bounded system analytics history for models and host or CLI resources", async () => {
    const migrations = await loadMigrations();
    const analytics = migrations.find((migration) => migration.id === "0078_system_analytics");

    expect(analytics).toBeDefined();
    expect(analytics?.sql).toContain("CREATE TABLE IF NOT EXISTS system_analytics_model_events");
    expect(analytics?.sql).toContain("coverage IN ('NATIVE', 'SESSION_ONLY', 'UNAVAILABLE')");
    expect(analytics?.sql).toContain("status IN ('RUNNING', 'COMPLETED', 'ABORTED', 'SESSION')");
    expect(analytics?.sql).toContain("CREATE TABLE IF NOT EXISTS system_analytics_resource_buckets");
    expect(analytics?.sql).toContain("resolution_seconds IN (10, 60, 900)");
    expect(analytics?.sql).toContain("entity_type IN ('HOST', 'CLI_SESSION', 'SHARED_RUNTIME')");
    expect(analytics?.sql).toContain("CREATE TABLE IF NOT EXISTS system_analytics_ingest_cursors");
    expect(analytics?.sql).toContain("VALUES ('backfill', 'PENDING')");
    expect(analytics?.sql).not.toMatch(/command_line|commandline|argv|environment|credential|secret/i);
  });

  it("removes the reverted Gemini multi-account schema", async () => {
    const migrations = await loadMigrations();
    const cleanup = migrations.find((migration) => migration.id === "0086_remove_cli_account_profiles");

    expect(cleanup).toBeDefined();
    expect(cleanup?.sql).toContain("DROP INDEX IF EXISTS idx_pane_cli_sessions_account_profile");
    expect(cleanup?.sql).toContain("DROP COLUMN IF EXISTS account_profile_id");
    expect(cleanup?.sql).toContain("DROP TABLE IF EXISTS cli_account_profiles");
  });

  it("indexes the hot control, CLI session and model analytics read paths", async () => {
    const migrations = await loadMigrations();
    const indexes = migrations.find((migration) => migration.id === "0121_hot_path_indexes");

    expect(indexes).toBeDefined();
    expect(indexes?.sql).toContain("CREATE INDEX IF NOT EXISTS space_control_records_kind_updated_at");
    expect(indexes?.sql).toContain("space_control_records(kind, updated_at DESC)");
    expect(indexes?.sql).toContain("CREATE INDEX IF NOT EXISTS idx_pane_cli_sessions_active_runtime");
    expect(indexes?.sql).toContain("ON pane_cli_sessions(runtime_id)");
    expect(indexes?.sql).toContain("WHERE is_active = true AND status = 'RUNNING'");
    expect(indexes?.sql).toContain("CREATE INDEX IF NOT EXISTS idx_pane_cli_sessions_pane_started_at");
    expect(indexes?.sql).toContain("ON pane_cli_sessions(pane_id, started_at DESC, session_id DESC)");
    expect(indexes?.sql).toContain("CREATE INDEX IF NOT EXISTS idx_system_analytics_model_events_coalesced_range");
    expect(indexes?.sql).toContain("system_analytics_model_events((COALESCE(ended_at, started_at)))");
    expect(indexes?.sql).not.toMatch(/\b(?:DROP|DELETE|UPDATE|ALTER)\b/);
  });

  it("tunes autovacuum on high-churn tables and indexes exited CLI sessions for data retention", async () => {
    const migrations = await loadMigrations();
    const tuning = migrations.find((migration) => migration.id === "0130_db_performance_tuning");

    expect(tuning).toBeDefined();
    expect(tuning?.sql).toContain("ALTER TABLE space_control_records SET (autovacuum_vacuum_scale_factor = 0.05);");
    expect(tuning?.sql).toContain("ALTER TABLE pane_cli_terminal_control_leases SET (autovacuum_vacuum_scale_factor = 0.05);");
    expect(tuning?.sql).toContain("CREATE INDEX IF NOT EXISTS idx_pane_cli_sessions_exited_updated_at");
    expect(tuning?.sql).toContain("ON pane_cli_sessions(updated_at DESC)");
    expect(tuning?.sql).toContain("WHERE status = 'EXITED'");
  });
});

