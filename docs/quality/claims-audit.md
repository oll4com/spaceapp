# Public claims audit (2026-10-11)

This audit lists the latency, isolation, continuity and security claims found in
`README.md`, `CONTRIBUTING.md` and `docs/**`, and what was done with each: linked
to evidence, reworded as a goal or an unverified statement, corrected against the
code, or kept because it is already qualified. Locations are file and line at
commit `4f0210b52a`, before the corrections.

Method:

- `grep -i` over `README.md`, `CONTRIBUTING.md` and `docs/**/*.md` for `zero`,
  `instant`, `immediate`, `never`, `guarantee`, `100%`, `exactly-once`,
  `crosstalk`, `sub-N ms`, `ultra-fast`, `seamless`, `real-time`, `low-latency`,
  `isolat*`, `sandbox`, `stay alive`, `persistent` and every `N ms` figure.
- Each hit was compared with the code or with a recorded benchmark. Hits that are
  acceptance gates, configuration values, policy names or explicit negations
  ("no exactly-once guarantee is claimed") are listed as kept.
- `npm run check:claims` (`scripts/check-public-claims.mjs`) now rejects new
  unqualified absolute wording and unqualified latency figures in the public
  document set, and compares the stated version, licence, Node requirement,
  runtime list and key constants with the code. A line that records a historical
  value on purpose can carry `<!-- claims:historical -->`.

`docs/quality/README.md`, `plan-v2.md` and `review-findings.json` belong to the
integrator and were read but not edited.

## Warm room switch benchmark

The only latency figure the product docs quote for room switching. The gate is a
warm switch p95 within 250 ms, with the same terminals and sockets retained after
more than 35 s hidden.

| Date | Build | Proof | Warm p95 | Capacity and retention | Result |
| --- | --- | --- | --- | --- | --- |
| 2026-10-07 | accepted Warm implementation | Two authenticated fixed 6×16 synthetic PTY runs, more than 35 s hidden | 226.3 ms and 239.6 ms | 96 same xterm DOMs and sockets, no new or closed sockets | Accepted |
| 2026-10-11 | live `0ff3d53269` / `0d2ede0ca6` | `BENCHMARK_WARM_CAPACITY` runs 1 and 3 (run 2 invalid: `space-api` restarted for another deploy) | 1150 ms and 966 ms | 96/96 same terminals and sockets after 45–47 s hidden | Gate failed; PERF-001 open |

What is measured: DOM and input readiness of the revealed room, not compositor
presentation timestamps. The 2026-10-11 cost is almost all style recalculation on
the first reveal of a hidden room (RecalcStyle 0.76–1.29 s); the second switch
measured 172–253 ms.

Sources: finding PERF-001 in [review-findings.json](review-findings.json),
[decomposition-proposal.md](decomposition-proposal.md), and on the operator host
`/opt/spaceapp/docs/space_room_switch_performance_baseline.md` with the reports under
`/var/lib/spaceapp-user/agent-workspace/reports/20261005-room-panes-performance/`
(operator-host files, not part of this repository).

## Claims

Dispositions: **Reworded** (wording changed to a goal, limit or plain
description), **Corrected** (a factual statement fixed against the code),
**Linked** (evidence added), **Kept** (already qualified or not a performance
claim), **External** (owned by the `run-spaceapp` installer, not verifiable in
this repository).

### Latency and performance

| ID | Location | Original claim (abridged) | Disposition | Evidence or new wording |
| --- | --- | --- | --- | --- |
| L01 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:78` | "adaptive warm state ... for immediate sub-50ms room switching" | Reworded, Linked | Six warm rooms / 96 connected panes, parking disabled; target p95 within 250 ms; accepted 226.3/239.6 ms, live 1150/966 ms fails (PERF-001). Linked to the benchmark record above |
| L02 | `docs/architecture/spaceapp-system-topology.md:152` | "Room activation is immediate" | Reworded | "reuses the mounted room and its sockets without reconnecting terminals" |
| L03 | `docs/architecture/spaceapp-system-topology.md:157-159` | "no fresh authenticated six-room/96-pane proof" | Corrected, Linked | States the 2026-10-11 proof: capacity and retention pass, latency gate failed; link to the benchmark record |
| L04 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:16` | "ultra-fast, local-first ... AI runtime operating system" | Reworded | "self-hosted ... model inference runs at the providers" |
| L05 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:245` | Snip "~30-150 ms per snip, pixel-matched to a real screenshot" | Reworded | "Development measurements were about 30–150 ms per snip; this is not a benchmarked target" |
| L06 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:194` | Tool pruner "saving up to 80% input tokens" | Reworded | "to reduce input tokens (no token-saving benchmark is recorded in this repository)" |
| L07 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:299` | "True seamless One-Click Automatic Update" | Reworded | Plain description of `update.sh` |
| L08 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:84`, `:98`, `:224`, `:281` | "High-performance" terminal, "fast editing", "High-performance, low-load" thumbnails, "High-performance Go microservice" | Reworded | Adjectives removed; no benchmark exists |
| L09 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:65`, `:117`, `:227`, `:229`, `:250` | "real-time" streaming, monitoring, task status, clipboard, system metrics | Reworded | "push updates", "Live", plain status, "Sampled ... (system health)" |
| L10 | `README.md:49` | "agent thought chains, token consumption ... in real-time" | Reworded | Output streams from each pane; token usage only where the runtime reports it (runtime-compatibility: no normalized usage at the PTY boundary) |
| L11 | `README.md:64` | "providing instant access to Rooms ..." | Reworded | "a single entry point to ..." |
| L12 | `README.md:84` | "Gemini Live low-latency full-duplex voice interface" | Reworded | "latency depends on the provider and network and is not benchmarked here" |
| L13 | `docs/features/space-jev-capabilities-catalog.md:15` | "deterministic, low-latency, type-safe decision engine" | Reworded | Vendor description; "latency is not benchmarked in this repository" |
| L14 | `docs/archive/unified-cli-task-history-complete.md:227`, `docs/unified-cli-task-history-usage.md:168` | "Total Response Time ~100-300ms" | Reworded | Marked "estimate, not benchmarked" |
| L15 | `docs/archive/spaceapp-jev-architecture-plan.md:35`, `:167` | "~70-300ms"; "0ms latency στα duplicates" | Reworded | Plan header notes figures are design estimates; "no provider call for duplicates" |
| L16 | `docs/space_agent_files_filing_guide.md:56` | "Immediate Visibility: Published files immediately appear" | Reworded | "appear ... through WebSocket `space:artifacts-updated` events, without a manual refresh" |
| L17 | `docs/runbooks/t3code-managed-runtime.md:122`, `:167-170`; `docs/SPACEAPP_CAPABILITIES_SPEC.md:130` | T3 Code open times and request counts | Kept | Measured with method and conditions in the runbook |
| L18 | `docs/archive/room-agent-v3-implementation.md:35-37`, `:52` | Room Agent probe 2135.325 ms; model calls over 1000 ms | Kept | Recorded measurements with the accepted gate exception |
| L19 | `docs/quality/decomposition-proposal.md:33`, `docs/quality/README.md:426` | Warm p95 1150/966 ms vs 250 ms | Kept | Measurement with source (PERF-001) |
| L20 | `docs/decisions/ADR-009-per-pane-lazy-heavy-mcp-gateway.md:165`, `ADR-010-capability-first-tools.md:76-87`, `docs/design/memory-graph-v1-*.md`, `docs/runbooks/ai-live-remaining-acceptance.md:33`, `docs/archive/live-control-upgrade-plan.md:235` | p95 and latency limits | Kept | Acceptance gates and targets, labelled as such |
| L21 | `docs/features/system-health.md:26-27` | RTT 300/425 ms, API p95 1000/2500 ms | Kept | Warning/critical thresholds (configuration) |
| L22 | `docs/features/task-titles-plan.md:24` | Popover opens after 300ms | Kept | UI delay constant, not a performance claim |
| L23 | `README.md:136` | `logs` "streams real-time container logs" | Kept, External | Describes log streaming; launcher behavior |

### Isolation and trust

| ID | Location | Original claim (abridged) | Disposition | Evidence or new wording |
| --- | --- | --- | --- | --- |
| I01 | `README.md:150` | "runs in an isolated container sandbox and cannot access your host filesystem" | Reworded | No host bind mount by default; only registered directories; containers are not a sandbox against a hostile workload; host-root removes the boundary; link to [trust boundaries](../architecture.md#trust-boundaries) |
| I02 | `README.md:165` | "its isolated persistent volume" | Reworded | "its own persistent volume" |
| I03 | `README.md:246` | "isolated Chromium browser sessions" | Reworded | "Chromium browser sessions in a separate service" |
| I04 | `README.md:321` | Link label "Container Security & Isolation Model" for `docs/security-model.md` | Corrected | The document covers authentication, rate limits and browser capture; label changed and the architecture map added |
| I05 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:60` | `@space/cli-host` "process isolation" | Corrected | Owns process lifetime; not a sandbox: every provider CLI runs as `spaceapp-user` (`deploy/*-vscode-parity`, sudoers) |
| I06 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:91` | Browser "Isolated ephemeral cookie profiles" | Corrected | Per-pane private or shared per-account profiles (stage 3 runbook) |
| I07 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:108-109`, `:273` | "Worktree-First ephemeral isolation", "isolated Git worktrees ... prevent parallel edit collisions" | Reworded | Worktrees separate files, not processes or credentials |
| I08 | `docs/decisions/ADR-002-independent-cli-pane-host.md:29` | "mode-`0600` Unix socket" | Corrected | Implementation note: sockets are created `0660`; access is limited by the `0700` (`space`) and `0750` (root:`space`) runtime directories |
| I09 | `README.md:17` | "Rooms organize sessions; they are not a security boundary" | Kept | Matches the trust model |
| I10 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:168` | Muse "no per-tool approval or shell sandbox" | Kept | Accurate description of `--yolo` |
| I11 | `README.md:246` (profiles), hardware and "five core services" | Installer profiles and container layout | External | Defined by the `run-spaceapp` package; not verifiable here |

### Continuity and recovery

| ID | Location | Original claim (abridged) | Disposition | Evidence or new wording |
| --- | --- | --- | --- | --- |
| C01 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:85` | "`codex-pane-host.service` ensures terminals stay alive even if `space-api` restarts" | Reworded, Linked | API restart detaches without killing the PTY (ADR-002); every deploy compares CLI continuity snapshots (`scripts/verify-cli-host-service-restart.mjs` in `space-deploy-commit.sh`); detached sessions are reaped after `SPACE_CLI_HOST_INACTIVE_SESSION_MS` (default 30 minutes); authenticated end-to-end proof open ([failure matrix](failure-matrix.md)) |
| C02 | `README.md:32` | "Cross-Agent Persistent Vector Memory ... shared across your agent sessions" | Reworded | Optional (`SPACE_MEMORY_GRAPH_ENABLED`); embeddings computed by the configured provider, which receives the indexed text |
| C03 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:234` | "Ambiguous sends are reconciled and never blindly repeated" | Linked | Controller lost-ACK, pause, override and recovery tests; real restart during a native turn still open ([failure matrix](failure-matrix.md)) |
| C04 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:211-212` | "SQLite Vector Store ... without cloud API dependencies" | Corrected | PostgreSQL `vector` columns with HNSW indexes (`packages/db/migrations/0001_initial.sql`, `0010`, `0043`); embeddings from a configured provider (default OpenAI-compatible endpoint, `apps/api/src/config.ts`) |
| C05 | `docs/quality/failure-matrix.md:5`, `docs/quality/upload-reconciliation.md:10`, `docs/architecture/spaceapp-system-topology.md:117` | "No exactly-once guarantee is claimed" | Kept | Explicit negation |
| C06 | `docs/decisions/ADR-007-telegram-completion-notifications.md:13`, `:82` | "Space needs exactly-once Telegram notifications" | Kept | Requirement statement; the Consequences section documents the retry exception (no Bot API idempotency key) |
| C07 | `docs/archive/room-agent-v3-implementation.md:19` | "SEARCH/PLAYBACK retries never redeliver side effects" | Kept | At-most-once statement with the uncertainty case documented |
| C08 | `README.md:17` | "persistent rooms" | Kept | Rooms are PostgreSQL records; the in-memory development store is not durable ([architecture](../architecture.md#data-stores)) |
| C09 | `README.md:177-178` (`update`, `rollback`) | "automatic checkpointing", "Reverts ... to the verified pre-update checkpoint" | External | Installer behavior; not verifiable here |

### Security

| ID | Location | Original claim (abridged) | Disposition | Evidence or new wording |
| --- | --- | --- | --- | --- |
| S01 | `docs/security-model.md:16-19` | "Immediate Revocation ... instantly invalidating all previously issued tokens ... across all devices" | Corrected | `SessionRevocationStore` is an in-memory map in `apps/api/src/auth.ts`: effective for the running API process, lost on an API restart (every deploy); operator tokens live up to 400 days. Documented as a limit |
| S02 | `docs/security-model.md:30` | PKCE cookie "guarantees token exchange cannot be completed if authorization codes are intercepted" | Reworded | "an intercepted authorization code alone cannot be exchanged for tokens" |
| S03 | `docs/security-model.md:46` | "CodeQL Static Verification" | Corrected | It is a unit test (`apps/api/tests/route-rate-limits.test.ts`) that keeps limits CodeQL-visible, not a CodeQL run |
| S04 | `docs/security-model.md:67` | Audit gate "enforced during build and pre-deployment testing, requiring zero high or critical vulnerabilities" | Corrected | Runs in `npm test` (`test:deploy`); `npm run build` and the merge-queue deploy do not run it |
| S05 | `docs/security-model.md:44` | Login "10 attempts per 15 minutes per IP" | Kept, machine-checked | `POST /api/auth/login` rate limit in `apps/api/src/app.ts`; global key is the client IP |
| S06 | `docs/security-model.md:11` | Anonymous requests never elevate to `user:operator` | Kept | `apps/api/tests/setup.test.ts` asserts unauthenticated `/api/auth/me` |
| S07 | `docs/security-model.md:53` | Element screenshot capture never uses `Runtime.evaluate` | Kept | `resolveElementScreenshotClip` uses `DOM.getDocument`, `DOM.querySelector`, `DOM.getBoxModel` (`apps/api/src/browser-sessions.ts`); other browser actions do use `Runtime.evaluate` |
| S08 | `README.md:335` | "You are 100% free to copy, modify, test, self-host" | Corrected | Licence summary aligned with LICENSE: permitted use, the Additional Use Grant, the competing hosted-service limitation, Change Date 2030-10-01 to Apache License 2.0; "source-available, not open source" |

### Other absolute or factual statements corrected

| ID | Location | Original | Disposition | Correction |
| --- | --- | --- | --- | --- |
| F01 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:31`, `:54` | API is an "Express" server | Corrected | Fastify (`apps/api/package.json`, `@fastify/websocket`) |
| F02 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:33` | "10 monorepo packages" | Corrected | 9 (`packages/*`) |
| F03 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:59` | `@space/db` "Multi-engine (PostgreSQL & SQLite), zero-downtime autovacuum tuning" | Corrected | PostgreSQL only (`pg`); autovacuum tuning in migration `0130` |
| F04 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:147`, `:155` | "100% parity", "16+ AI CLI engines" | Corrected | 16 declared runtimes plus the `gh` wrapper; lifecycle differs per runtime. The `gh` wrapper is installed on the operator host as `/opt/spaceapp/bin/gh-vscode-parity`; it is not in `deploy/` and has no runtime descriptor |
| F05 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:180` | "production-grade deterministic decision engine" embedded | Corrected | Optional remote model API with a configured key; outputs gate specific steps |
| F06 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:208` | "Zero-cost" recall | Reworded | "Provider-free ... no model or provider calls" |
| F07 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:43` | "Zero-dependency setup CLI" | Reworded | Installer dependencies are not verifiable in this repository |
| F08 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:75` | "backend/store rejects" a seventh room | Corrected | The API route rejects it; the stores do not check |
| F09 | `docs/SPACEAPP_CAPABILITIES_SPEC.md:79` | "zero layout overflow" | Reworded | Asserted by authenticated UI proofs, not guaranteed in general |
| F10 | `docs/configuration-reference.md:14` | "all 137 fields of `SpaceApiConfig`" | Corrected | 148 (`apiConfigRegistry`, equal to the `SpaceApiConfig` interface) |
| F11 | `README.md:195`, `:207` | "includes adapters for the following CLI tools" (11 listed) | Corrected | "declares 16 CLI adapters"; Hermes, Oh My Pi, Qoder, Muse and Droid added |
| F12 | `docs/archive/unified-cli-task-history-complete.md:1`, `:5`, `:235`, `:356`, `:362` | "100% Complete", "100% backwards compatible", "Zero Breaking Changes" | Reworded | Title changed; header marks the note as unverified historical record |
| F13 | `docs/archive/native-file-manager-plan.md:4-5`, `docs/walkthroughs/source-control-versioning-walkthrough.md:28`, `docs/space_agent_files_filing_guide.md:18-19`, `docs/space_unified_versioning_policy.md:129` | "100% Native", "Zero Iframe", "Zero Horizontal Overflow", "Zero ... Dumps/Trapping", "Zero Placeholder Rule" | Kept | Plan goals, CSS change descriptions and policy rule names, not product performance claims |

## Summary

| Category | Found | Reworded | Corrected | Linked to evidence | Kept (qualified or not a claim) | External |
| --- | --- | --- | --- | --- | --- | --- |
| Latency and performance | 23 | 15 | 1 | 0 | 6 | 1 |
| Isolation and trust | 11 | 4 | 4 | 0 | 2 | 1 |
| Continuity and recovery | 9 | 2 | 1 | 1 | 4 | 1 |
| Security | 8 | 1 | 4 | 0 | 3 | 0 |
| Other absolute or factual | 13 | 4 | 8 | 0 | 1 | 0 |
| **Total** | **64** | **26** | **18** | **1** | **16** | **3** |

Rows with two dispositions (for example "Reworded, Linked") are counted once,
under the first disposition, so evidence was also added in L01, L03 and C01
beyond the one row counted as Linked. External rows that are also kept (L23) are
counted as external.

## Not verifiable in this repository

- Installer facts in the README: hardware minimums, profiles, the five-service
  compose stack, platform support (Linux, macOS, Windows 11), pinned image
  digests, masked credential input, update checkpoints and rollback. They belong
  to the `run-spaceapp` package and its release evidence.
- README links to `docs/getting-started.md`, `docs/cli-providers.md`,
  `docs/operations.md`, `docs/clean-room-testing.md`, `docs/public-release.md`,
  `docs/decisions/ADR-010-public-distribution.md`, `SUPPORT.md`, `SECURITY.md`
  and `THIRD_PARTY_NOTICES.md` resolve only in the public export; this
  repository's own ADR-010 is the capability-first tools decision.
