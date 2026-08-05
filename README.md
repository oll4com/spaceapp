# Space

Standalone Agent Room control plane for Space.

This repository is intentionally independent from any operator workstation or editor runtime. The initial slice provides typed contracts, a secured Fastify API, an in-memory runtime store for local vertical testing, a dense React room shell, a PostgreSQL migration foundation, and a Temporal worker skeleton. Provider, MCP, browser, memory, and swarm integrations are visible only as fail-closed capability surfaces until real credentials and smoke tests are configured.

## Current Space Readiness

- Canonical live URL is `http://127.0.0.1:4911/`; browser proof should
  target the hostname.
- Live MCP bridge is enabled only through authenticated internal Space routes.
  The current live catalog is the allowlisted `space-readonly` MCP server; tools
  that require approval return `APPROVAL_REQUIRED` to agents rather than
  executing from model output.
- Space-managed CLI sessions write a per-session `AGENTS.md` and export
  non-secret identity env vars (`SPACE_ROOM_ID`, `SPACE_PANE_ID`,
  `SPACE_CLI_SESSION_ID`, and runtime ids) so CLI agents know their room,
  pane, session, and runtime without receiving Space internal auth tokens.
- Root disk was reduced from 91% to 72% by deleting the generated Go build cache at `/var/lib/spaceapp-user/.cache/go-build`.
- `/opt/spaceapp` still lives on the 160GB root disk. Production/browser-heavy launch still needs a dedicated larger app volume or disk expansion to meet the 150-250GB target.
- Package manager default is `npm workspaces` because the current Corepack/pnpm path fails under Node 22.23.0.

## Local Development

```bash
npm ci
npm run dev:api
npm run dev:web
npm run dev:worker
```

For local network access after building the SPA, serve the web app with its same-origin API proxy:

```bash
npm run build -w @space/web
SPACE_WEB_HOST=0.0.0.0 SPACE_WEB_PORT=4911 SPACE_API_ORIGIN=http://127.0.0.1:4910 npm run start -w @space/web
```

For managed Space runtime, install the systemd unit templates after `/opt/spaceapp/.env` is present. CLI panes run in a separate host service so normal API/web/worker restarts do not replace their PTYs:

```bash
sudo cp deploy/codex-pane-host.service deploy/space-admin-pane-host.service deploy/space-api.service deploy/space-web.service deploy/space-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now codex-pane-host.service space-admin-pane-host.service space-api.service space-web.service space-worker.service
```

Production rollout must use `scripts/space-deploy-commit.sh`. The initial host cutover additionally requires a protected manifest from `scripts/space-cli-session-manifest.mjs` and explicit confirmation that current turns are idle, or explicit acceptance that the one-time cutover may interrupt them. Ordinary deploys restart only `space-web.service`, `space-api.service`, and `space-worker.service`. Restart the CLI host only with the separately guarded `scripts/restart-codex-pane-host.sh --confirm-host-restart` flow. See [ADR-002](docs/decisions/ADR-002-independent-cli-pane-host.md).

For local-only development without a configured operator password hash:

```bash
SPACE_DEV_LOGIN=true SPACE_SESSION_SECRET=dev-only-change-me npm run dev:api
```

Then log in with `space@space.local` / `space-dev`. Do not use dev login in production.

For production-style operator auth, generate the password hash without putting
the raw password in shell history or the process list:

```bash
read -rsp 'Space operator password: ' SPACE_OPERATOR_PASSWORD
printf '%s' "$SPACE_OPERATOR_PASSWORD" | node scripts/hash-password.mjs --stdin
unset SPACE_OPERATOR_PASSWORD
# or
node scripts/hash-password.mjs --password-file /root/space-operator-password
```

Set `SPACE_DEV_LOGIN=false`, `SPACE_OPERATOR_EMAIL`, and
`SPACE_OPERATOR_PASSWORD_HASH` before claiming production launch readiness.

## Temporal And Database Bootstrap

`docker-compose.yml` includes local-only Postgres, NATS, Temporal, and Temporal UI services. On this VM, Docker is present but the Compose plugin is not installed, so validate Compose tooling before relying on this file for runtime startup.

Apply the current SQL foundation after Postgres is running:

```bash
npm run db:migrate
```

The API defaults to the in-memory bootstrap store. Switch to the Postgres-backed room/pane/event store only after migrations are applied:

```bash
SPACE_RUNTIME_STORE=postgres npm run dev:api
```

Temporal is the durable workflow plane in the Master Blueprint. The current worker only exposes a dummy turn workflow so the app can prove task queue wiring before any real provider, Codex App Server, MCP, browser, or destructive tool execution is enabled.

Dummy turns remain fail-closed by default. Enable them only with a running Temporal service and worker:

```bash
SPACE_ENABLE_DUMMY_TURNS=true npm run dev:api
```

## Verification

```bash
npm test
npm run check
npm run build
```

Generate version-matched Codex App Server schemas into the ignored local `var/` tree before enabling a real adapter smoke:

```bash
npm run codex:schemas
```

This only generates protocol artifacts and `manifest.json`; it does not spawn a Space-managed Codex session or connect Space to the existing Space Codex runtime.

Codex App Server execution remains split into explicit gates:

- `SPACE_CODEX_APP_SERVER_ENABLED=true` allows the adapter status to move beyond disabled.
- `SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN=true` allows an isolated stdio initialize handshake smoke.
- `SPACE_CODEX_APP_SERVER_ALLOW_TURN_SMOKE=true` is additionally required before any real `thread/start` + `turn/start` smoke can run.

The live Space service should leave the turn-smoke gate disabled until a deliberate real-execution smoke is approved and evidence is captured.

## MCP Discovery And Execution Gate

MCP discovery and execution remain disabled by default. The gateway can run stdio discovery metadata smoke when explicitly enabled:

```bash
SPACE_MCP_DISCOVERY_SMOKE_ENABLED=true
SPACE_MCP_SERVERS_JSON='[{"id":"example","displayName":"Example MCP","transport":"stdio","command":"/absolute/or/path-command","args":[],"enabled":true}]'
```

Discovery sends MCP `initialize`, `notifications/initialized`, and `tools/list` only. It never calls `tools/call`, never enables HTTP MCP discovery, and persists discovered schema hashes with gateway `approvalMode: DISABLED`.

The repository includes a bounded read-only smoke server at `scripts/space-readonly-mcp.mjs`. A real execution smoke requires a verified discovery catalog, the discovered schema hash in `SPACE_MCP_ALLOWLISTED_SCHEMA_HASHES`, `SPACE_MCP_TOOL_EXECUTION_ENABLED=true`, and an operator approval reason on the execution request. Results are persisted as `MCP_RESULT` artifacts.

## Semantic Memory Gate

Keyword memory search is active. Semantic memory remains disabled until both vector storage and an embedding provider pass smoke validation.

The vector storage gate requires Postgres, pgvector, the `memory_records.embedding` vector column, and the HNSW index from the migrations. The provider gate is disabled by default and currently supports direct OpenAI embeddings or an OpenAI-compatible Codex-LB embeddings endpoint.

Direct OpenAI:

```bash
SPACE_MEMORY_EMBEDDING_SMOKE_ENABLED=true
SPACE_MEMORY_EMBEDDING_PROVIDER=openai
SPACE_MEMORY_EMBEDDING_MODEL=text-embedding-3-small
SPACE_MEMORY_EMBEDDING_DIMENSIONS=1536
SPACE_MEMORY_EMBEDDING_BASE_URL=https://api.openai.com/v1
SPACE_MEMORY_EMBEDDING_KEY_FILE=/opt/spaceapp/secrets/space-openai-embedding.key
SPACE_MEMORY_EMBEDDING_KEY_NAME=space-openai-embedding
```

Codex-LB gateway:

```bash
SPACE_MEMORY_EMBEDDING_SMOKE_ENABLED=true
SPACE_MEMORY_EMBEDDING_PROVIDER=codex-lb
SPACE_MEMORY_EMBEDDING_MODEL=text-embedding-3-small
SPACE_MEMORY_EMBEDDING_DIMENSIONS=1536
SPACE_MEMORY_EMBEDDING_BASE_URL=http://codex-lb.example/v1
SPACE_MEMORY_EMBEDDING_KEY_FILE=/opt/spaceapp/secrets/space-codex-lb-provider.key
SPACE_MEMORY_EMBEDDING_KEY_NAME=space-codex-lb-provider
```

The key label must start with `space-`. Raw keys must stay only in the configured secret file and must not be copied into chat, docs, git, logs, or artifacts. A passing embedding smoke proves one provider `/v1/embeddings` call and dimension match only; semantic ranking is still a separate implementation gate. If Codex-LB returns HTTP 404/405 for `/v1/embeddings`, keep semantic memory gated until the real gateway endpoint exists or use a dedicated direct OpenAI embedding key.

Browser-facing completion requires real browser proof across mobile, tablet, desktop, wide, and ultrawide viewports before any production-ready claim.
