# State ownership for recovery review

| State | Ownership | Recovery rule |
| --- | --- | --- |
| Rooms, panes, tasks, sessions, events and artifact metadata | PostgreSQL stores (`packages/db/src`) | Persist intent and reconcile status with actual host/provider state; never recreate a native session solely from pane status |
| CLI process and terminal buffers | Independent CLI host (`packages/cli-host/src/session-registry.ts`) | API transport detachment must not terminate host-owned PTY; preserve immutable session identity |
| Provider conversation/context | Provider-native runtime storage | Resume only through supported native identity; copied transcripts are not native resume |
| Browser process and subscriptions | Browser host (`packages/browser-host/src`) | Transport subscriptions are disposable; browser state needs explicit recovery proof |
| Canonical memory source | Approved canonical files and mutation journal | Lock, compare expected hashes, journal, mutate, then reconcile/cache; preserve provenance |
| Memory embeddings and retrieval cache | Derived graph/vector state | Invalidate deleted/stale source records; rebuild from canonical sources and recorded versions |
| Agent file bytes | Artifact filesystem, identified by stored hash and metadata | Stream to exclusive partial file, verify complete bytes, journal intent, publish metadata, retain complete bytes on uncertain confirmation; reconcile by URI/hash/size |
| MCP server/tool discovery catalog | PostgreSQL `mcp_servers` and `mcp_tools`, derived from configured enabled servers | After restore, run gated discovery: every tools/list page must succeed before a serialized transaction replaces the catalog snapshot, removing disappeared tools and retired servers. Failed/incomplete discovery retains the previous snapshot; approvals and execution history are separate and untouched. |
| Upload staging | Temporary request-owned filesystem data | Never count as a completed artifact; delete on abort/error |
| Vault items | PostgreSQL (ciphertext, public keys, metadata) and the broker-held key | Server-blind: nothing server-side can read or repair an item; a restore returns ciphertext as of the backup, then the operator unlocks and the dock re-delegates |
| Appointments | Workspace domain, PostgreSQL `appointments` | Durable per owner; only a cancel (kept as CANCELLED) or an explicit delete changes one. `reminders_sent` records the reminder steps sent, so a restart sends none twice and misses none still due. A database backup restores them as of the backup; reminders already sent after it may go again. |
| Signatures and signature requests | Workspace domain, PostgreSQL `owner_signatures` and `signature_requests` | Durable per owner: the drawn signature (PNG) and phone go only by the owner's explicit delete (png set NULL); a request ends as SIGNED or CANCELLED, never deleted. Signed copies are new Agent Files (artifact metadata and bytes recover as Agent Files do). A database backup restores the signature and requests as of the backup; a request signed after it reads PENDING again and its signed copy stays in Agent Files. |
| Site sign-in recipes | Copilots domain, PostgreSQL `site_sign_ins` | Durable metadata per owner, site and account label; only an explicit delete removes a recipe. A database backup restores recipes as of the backup; credentials remain in Vault and browser sessions must be checked independently. Change history is capped at 100 entries and 180 days. |
| UI visibility/warm cache | Derived frontend state | Preserve protected six-room/96-pane policy; no timed parking or session-host replacement |

This map describes ownership boundaries, not a completed distributed-consistency
proof. Artifact metadata/files and memory source/cache transitions need the
fault/restore matrix before atomicity or recovery claims can be strengthened.

## Table ownership map (2026-10-28)

Every PostgreSQL table belongs to one domain in `docs/quality/table-ownership.json`
(14 domains, first matching rule wins). `scripts/tests/table-ownership.test.mjs`
reads the tables the migrations leave in the database and fails when a new table has
no domain, when a rule matches no table, or when a domain owns none; it runs in
`npm run test:architecture` and in `npm run test:deploy`, the merge queue's gate.

Each domain also carries a recovery kind (`database`, `reconcile-with-host`, `rebuild-from-source`, `ciphertext-only`) and the rows above it relies on, in the `recovery` section of the same file; the test checks that every named row exists here.

Within a domain, `tables` in the same file lists the tables that recover differently (2026-10-30: in `memory`, `memory_graph_embeddings` is rebuilt from the canonical records and `memory_embedding_smoke_checks` is disposable; every other memory table, including `memory_records` and the change-set journal, exists only in PostgreSQL).

2026-10-31: `mobile_instance_keys` (identity) holds the mobile channel's keys sealed with the connector key file; a restore needs both,
else paired phones show the red screen and pair again (ADR-013).
2026-11-13: `instance_links` (identity) holds this SpaceApp's links to other SpaceApps, each device key sealed with the connector key
file like `mobile_instance_keys` (ADR-014); a restore needs both, else each link is removed and paired again from a new code.

Also 2026-10-30: `disposable` tables are routine-expiring caches or attempts (`space_gateway_sticky_bindings`, `streaming_oauth_attempts`, `memory_embedding_smoke_checks`). `single-use-ledger` tables (`session_revocations`, `user_invites`, `vault_nonces`) record a credential as used or revoked, so a restore older than a row makes that credential usable again until it expires; after a restore, re-revoke what was revoked after the backup and void invites issued, used or revoked after it.

Files without an artifact row (2026-10-31, read only against the 29/10 backup): 5,230 files, 2.78 GiB in agent-files, user-uploads, cli-uploads and browser-evidence predate the first surviving row (29-30 September) and match the removal of old rows by the earlier flat `--days 7` cleanup (see DATA-001 in `review-findings.json`). Today's retention paths remove the bytes with the row, and the upload-record marker (the by-design keep after an uncertain confirmation) is absent for all of them. They are user data and stay until an operator decides.

2026-11-01: `demo_oauth_attempts` is disposable (expired rows are deleted by the API) and `telegram_pairing_sessions` is a single-use ledger (a restore older than a confirmation shows the code PENDING again until it expires; its `secret_version` must agree with the sealed bot secrets after a restore).

2026-11-01: the tables the weekly cleanup prunes on purpose are `disposable` too: the four smoke-check histories (`provider_validation_checks`, `mcp_discovery_smoke_checks`, `codex_app_server_handshake_checks`, `codex_app_server_turn_smoke_checks`, newest row kept) and `cli_maintenance_events`. `admin_operation_runs` is not: a RUNNING run is state.

2026-11-02: `history` tables are logs pruned by age on purpose, so a restore returns the backup's window and nothing retention had already removed: `pane_reports` (14 days), `room_agent_events` (30), `channel_events` (48 hours), `nous_goal_events` (30), `nous_load_samples` (30, rollups kept), `nous_decision_ledger` (180) and `nous_pane_summaries` (14, newest per pane kept).

Also `history`: `system_health_metric_buckets` and `system_analytics_resource_buckets` (tiered 2 hours / 48 hours / 31 days).

Also 2026-11-02: `task_title_attempts` is disposable (a throttle counter, a day kept), `streaming_bot_activity` is history (newest 500 kept) and `app_device_sessions` is a single-use ledger: after a restore, revoke again under Settings > Devices every phone revoked after the backup. `task_runs` keeps its domain kind on purpose: a RUNNING run waits for its pane's report.
