# Observability and error semantics

Plan package 5. This page covers the shared ID that leads from a failed task to
its causal error, the local metrics, the lightweight trace context, the error
categories, and the gaps that are still open. Nothing here needs an external
collector: logs go to journald, metrics are Prometheus text over HTTP, and
traces are IDs in logs and in Temporal memos.

Earlier work that this page builds on: `/livez`, the database check in
`/readyz` (`?strict=1` returns 503), the `x-request-id` header, nested log
redaction (`apps/api/src/request-logging.ts`) and the rate-limit coverage test
(OBS-010..012).

**Probe contract.** `/livez` answers whether the API process is up. `/readyz` without
parameters always returns HTTP 200 and reports readiness in its JSON `ok` field, because
the web proxy's recovery loop reads that field. A load balancer, orchestrator or uptime
check that looks only at the status code must call `/readyz?strict=1`, which returns 503
while any required dependency is unavailable.

## The shared ID

**The Space request ID is the correlation ID.** It has the form
`req:<12 characters>` and is created by the API for each HTTP request. The API
ignores any client-supplied `x-request-id`. In contracts and the database the
same value is called `traceId`.

| Where | Field |
| --- | --- |
| HTTP response | `x-request-id` header; `error.requestId` in every error envelope, including file errors |
| API logs (pino, journald) | `reqId`, with `w3cTraceId` on the same line |
| Turn input and workflow ID | `traceId`; the turn workflow ID ends with it: `workflow:codex-app-server:<roomId>:<paneId>:<traceId>` |
| Temporal memo (turns started by the API) | `spaceTraceId`, `traceparent`, `w3cTraceId` |
| Worker logs (journald) | `traceId` on `activity.started`, `activity.finished` and `turn.activity` lines |
| Database | `events.trace_id` (`TURN_STARTED`, `TURN_FAILED` with `payload.reasonCode`), `audit_events.trace_id`, `workflows.trace_id` |
| Admin API | `GET /api/admin/traces/<traceId>` |

Other IDs travel with it. They are recorded where they already existed and
are never invented:
- `missionId` (Room Agent mission), `agentRunId`, `agentSessionId` and `actionId`.
- The Temporal `workflowId` and run ID (`temporalRunId` in worker logs).
- `parentTraceId`: internal worker-to-API room-action calls get their own request
  ID. The originating ID travels in the request body as `requestId`. The API logs
  it as `parentTraceId` (`room_action.bridge`), stores it in the audit metadata,
  and puts it in the action workflow's memo as `parentSpaceTraceId`.

What changed in this package:
- Agent-run failures (`TURN_FAILED` from `updateSpaceAgentRun*`) used a random
  `trace:...` ID. The worker now passes the turn's `traceId`.
- A failed Temporal start is recorded as `TEMPORAL_UNAVAILABLE` or
  `TEMPORAL_START_TIMEOUT` when the error shows it. Other start errors still get
  `TURN_START_FAILED`.

## Following a failed task to its causal error

1. **Get the ID.** Use one of these:
   - The failed run's workflow ID ends with the ID
     (`workflow:codex-app-server:room:...:pane:...:req:AbC123dEf456`).
   - The failed request's `x-request-id` header or `error.requestId`.
   - The `traceId` of a `TURN_FAILED` event in the room event stream.
2. **Durable records and the causal error.** Signed in as ADMIN or OPERATOR,
   open `https://<space-host>/api/admin/traces/req:AbC123dEf456`. The response
   holds:
   - `causalError`: the newest event with a reason code, for example
     `{ "code": "CODEX_APP_SERVER_COMMAND_UNAVAILABLE", "category": "TOOL_UNAVAILABLE", "source": "event:TURN_FAILED", "workflowId": "workflow:codex-app-server:..." }`.
   - The events, audit entries and workflow rows for that ID.
   - Ready-made log queries.

   It returns only IDs, codes, statuses and times. Event messages, payload
   metadata and audit metadata are not returned.
3. **Worker execution.** On the host:

   ```sh
   journalctl -u space-worker.service --since -6h -o cat \
     | grep -F '"traceId":"req:AbC123dEf456"' \
     | jq -c '{ts,event,phase,activityType,attempt,outcome,reasonCode,category,queueMs,durationMs,workflowId,temporalRunId,w3cTraceId}'
   ```

   `activity.finished` lines show:
   - `outcome`: COMPLETED, FAILED_RESULT, FAILED or CANCELLED.
   - The reason code and category.
   - `attempt` (above 1 means a retry).
   - `queueMs`: time spent in the Temporal task queue.
4. **API side.** Use either query:

   ```sh
   journalctl -u space-api.service --since -6h -o cat | grep -F 'req:AbC123dEf456'
   ```

   To see every service that took part, including internal room-action calls,
   search both units for the W3C trace ID from step 3:

   ```sh
   journalctl -u space-api.service -u space-worker.service --since -6h -o cat | grep -F '<w3cTraceId>'
   ```
5. **Temporal.** Run:

   ```sh
   temporal workflow describe --workflow-id 'workflow:codex-app-server:...:req:AbC123dEf456'
   ```

   The memo shows `spaceTraceId`, `w3cTraceId` and `traceparent`. Use
   `temporal workflow show` for the history. Agent sandboxes on public-host must use the
   container address; see `failure-matrix.md`.
6. **SQL, for operators with database access:**

   ```sql
   SELECT event_type, payload->>'reasonCode', created_at FROM events
   WHERE trace_id = 'req:AbC123dEf456' AND created_at > now() - interval '14 days';
   ```

The same path is tested end to end in
`apps/api/tests/observability-fault-injection.test.ts`:
1. An HTTP request with a `traceparent` starts a Codex turn through a mocked
   Temporal client.
2. The captured workflow input runs through the real `runCodexAppServerTurn`
   activity with an injected executor fault.
3. The same request ID then finds the causal error in the worker log, the worker
   metrics and `/api/admin/traces`.

## Error categories

`categorizeFailureCode` (`packages/contracts/src/observability.ts`) maps any
stable error code to one bounded category. The categories are:
- `TIMEOUT`, `TOOL_UNAVAILABLE`, `PERMISSION_DENIED`, `NOT_FOUND`, `INVALID_INPUT`.
- `CONFLICT`, `RATE_LIMITED`, `DISABLED`, `CONFIGURATION`, `STATE_UNAVAILABLE`.
- `PROTOCOL_ERROR`, `PROVIDER_ERROR`, `UPSTREAM_UNAVAILABLE`, `CANCELLED`, `INTERNAL`.

Specific codes stay specific: `CODEX_APP_SERVER_TURN_TIMEOUT` remains the code
and `TIMEOUT` is its category. Unknown or unsafe values map to `INTERNAL` and
are never used as labels.

**File search** (`GET /api/files/search`) states its outcome:
- **Success:** `code: "OK"` (matches) or `code: "EMPTY_RESULT"` (the search ran
  and matched nothing). It also returns `truncated`.
- **Failure:** an error response with `TOOL_UNAVAILABLE` (503), `TIMEOUT` (504),
  `PERMISSION_DENIED` (403) or `SEARCH_FAILED` (502).
- **Error envelope:** adds `category` and `requestId`.
- **Unexpected errors:** return a fixed message. The underlying error is logged
  under the request ID instead of being echoed, because it can contain host paths.

All additions are optional fields, so earlier clients still parse the response.
Memory search already reports semantic unavailability as
`MEMORY_SEMANTIC_DISABLED` or `MEMORY_SEMANTIC_UNAVAILABLE`. The canonical
reader treats only a missing file as empty.

## Metrics

### API: `GET /metrics`

Prometheus text. It is served to loopback clients and to signed-in ADMIN and
OPERATOR sessions (private-network clients were allowed until review F12,
2026-10-14). Every other client gets 403
`METRICS_FORBIDDEN`, including those that come through the trusted proxy (their
forwarded address is used). Before this change the endpoint was open to everyone.

| Metric | Labels |
| --- | --- |
| `space_http_requests_total`, `space_http_request_errors_total`, `space_http_request_duration_seconds` (histogram) | `method`, `route` (registered template or `unmatched`), `status_class` |
| `space_http_error_responses_total` | `code` (error code or `UNSPECIFIED`), `category`, `status_class` |
| `space_process_cpu_seconds_total` | `mode` (`user`, `system`) |
| `space_process_memory_bytes` | `type` (`rss`, `heap_used`, `heap_total`, `external`, `array_buffers`) |
| `space_process_event_loop_lag_seconds` | `stat` (`p50`, `p90`, `p99`, `max`, `mean`) |
| `space_process_uptime_seconds` | none |
| `space_temporal_task_queue_backlog`, `space_temporal_task_queue_backlog_age_seconds`, `space_temporal_task_queue_pollers` | `queue_type` (`workflow`, `activity`) |
| `space_temporal_reachable`, `space_temporal_readiness_observed_timestamp_seconds` | none |
| `space_temporal_readiness_checks_total` | `status` |
| `space_temporal_workflow_starts_total` | `workflow_type`, `outcome` (`STARTED`, `SIGNALED`, `ALREADY_STARTED`, `FAILED`, `DISABLED`), `category` |
| `space_recovery_events_total` | `kind` (`plan_model_retry`), `outcome` |
| `space_cli_terminal_events_total` | `source`, `event`, `outcome`, `reason` |
| `space_cli_terminal_disconnects_total` | `source` |
| `space_cli_terminal_reconnects_total` | `source`, `outcome` (`SCHEDULED`, `GRACE_STARTED`, `SUCCEEDED`, `SESSION_RECOVERED`, `STOPPED`, `REATTACHED`) |
| `space_metrics_series_dropped_total` | `metric` |

Notes on these metrics:
- **Temporal queue gauges:** taken from the latest worker readiness check (`/readyz`,
  `/api/admin/worker`, system status). `/metrics` itself never calls Temporal;
  `space_temporal_readiness_observed_timestamp_seconds` shows how fresh the values are.
- **Event-loop delay:** each value covers the time since the previous scrape, so
  use a single scraper.

### Worker: optional loopback endpoint

The worker exposes the same process metrics plus the activity metrics below.

| Metric | Labels |
| --- | --- |
| `space_worker_activity_executions_total` | `activity_type`, `outcome` |
| `space_worker_activity_failures_total` | `activity_type`, `category`, `code` |
| `space_worker_activity_retries_total` | `activity_type` (attempt > 1) |
| `space_worker_activity_duration_seconds` (histogram) | `activity_type` |
| `space_worker_activity_schedule_to_start_seconds` (histogram, the Temporal queue age per attempt) | `activity_type` |
| `space_worker_activities_in_flight` | `activity_type` |

Configuration follows the worker's existing `process.env` style. There are no
new API configuration keys.
- **`SPACE_WORKER_METRICS_PORT`:** enables `http://127.0.0.1:<port>/metrics`. It
  is unset by default, so the endpoint is off; `0` or an invalid value also
  disables it. A bind failure is logged as `worker.metrics_endpoint` with status
  `UNAVAILABLE` and never stops the worker.
- **`SPACE_WORKER_METRICS_HOST`:** only `127.0.0.1` (the default) or `::1`. Any
  other value disables the endpoint.
- **`SPACE_WORKER_TEMPORAL_METRICS_BIND`:** for example `127.0.0.1:9464`, loopback
  only and unset by default. It installs the Temporal SDK's own Prometheus
  exporter (`Runtime.install`), which adds workflow-task schedule-to-start and
  execution latency, poll and slot metrics.

The worker endpoint was chosen instead of pushing to the API because it needs
no credentials, no new API route and no shared state between processes.

Without the endpoint, every activity still writes `activity.started` and
`activity.finished` records to journald.

## Traces (W3C trace context)

The trace context is local by default. An optional OTLP/HTTP (JSON) exporter sends spans
when `SPACE_OTEL_EXPORTER_OTLP_ENDPOINT` is set (no OpenTelemetry dependency; shared
via `packages/runtime/src/otlp-span-exporter.ts`). When configured, spans are exported
across the API server and all Temporal workers (`worker.ts`, `memory-maintenance-worker.ts`,
and `memory-mutation-worker.ts`).

- **Span Tree:**
  - **API Request Span (kind: SERVER):** continued from an inbound `traceparent` or started fresh.
  - **Workflow Span (kind: INTERNAL):** parented by the API request span via `traceparent` in the
    workflow memo or input arguments. Child workflows (e.g. `memoryConsolidationWorkflow` started
    by `memoryMaintenanceWorkflow`) are properly nested under their parent workflow span.
  - **Activity Spans (kind: INTERNAL):** parented by their enclosing workflow span. Emitted per
    activity execution attempt with attempt count, duration, status, and stable reason/category codes.
- **Determinism and Sinks:**
  Workflow code performs zero network I/O. Workflow spans are exported via Temporal sinks
  configured with `callDuringReplay: false`. During replay of execution history, the Temporal SDK
  skips sink invocation, guaranteeing zero duplicate spans emitted on replay.
- **Span Links:**
  Asynchronous workflow transitions carry W3C span links:
  - `continue-as-new` links to the previous execution run ID (`info.continuedFromExecutionRunId`).
  - Durable background continuations (`room-background-continuation.ts`) link to the originating
    source run ID.
- **Strict Attribute Allowlist:**
  Only safe identifiers (`space.*`, `temporal.*`), attempt counts, durations, status codes,
  and categorized error codes are exported. Prompts, operator requests, response text,
  URLs with query parameters, credentials, and filesystem paths are strictly excluded.

### Replay compatibility

No file under `apps/worker/src` that the workflow bundle imports was changed
(`workflows.ts`, `room-supervisor-state.ts`, `turn-runtime-policy.ts`,
`dot-goal-loop.ts`). The `agent-turns` workflow bundle was built for the base
commit and for this change and compared after normalizing paths and webpack
module numbers. The only differences are in `@space/contracts`:
- the new `observability` module;
- the optional `traceparent` turn-input field;
- the optional file search and readiness fields.

A history without `traceparent` parses exactly as before. Activity inputs are
not part of Temporal's determinism check.

The read-only live replay (`node scripts/temporal-replay-check.mjs --limit 30`)
could not be run from the agent sandbox that made this change. Its network
namespace has no route to the Temporal container (`172.18.0.5:7233`), and
`127.0.0.1:7233` refuses connections. Run it before deploying this change.

## Redaction policy

Worker log records are built from allowlisted fields:
- String values must be identifiers (`[A-Za-z0-9:._-]`); other strings are dropped.
- Error messages, prompts, responses and payloads are never logged. A thrown
  error contributes only a stable code and its class name.

Metric labels pass an allowlist and a per-metric series cap. Values that fail
become `other` or are counted in `space_metrics_series_dropped_total`.

Tests that prove these properties:

| Test file | What it shows |
| --- | --- |
| `packages/runtime/tests/metrics-registry.test.ts` | Unsafe label values never appear |
| `apps/api/tests/observability-metrics.test.ts` | Secrets, prompts, paths and user IDs sent in URLs, headers and bodies never reach `/metrics` |
| `apps/worker/tests/activity-observability.test.ts` | Prompts and thrown messages never reach worker logs or metrics |
| `apps/api/tests/trace-correlation.test.ts` | The trace lookup omits messages and metadata |
| `apps/api/tests/observability-fault-injection.test.ts` | Checks all of the above end to end |

No credential or transcript export was added.

## Tests

| File | Covers |
| --- | --- |
| `packages/contracts/tests/observability.test.ts` | Categories, `traceparent` parsing, additive contract fields |
| `packages/runtime/tests/metrics-registry.test.ts` | Registry format, label safety, series cap, process metrics |
| `packages/db/tests/trace-records.test.ts` | Bounded, parameterized PostgreSQL trace lookup |
| `apps/api/tests/trace-correlation.test.ts` | W3C context, log bindings, starter memo and input, Room Agent propagation, start-failure category, lookup projection |
| `apps/api/tests/observability-metrics.test.ts` | New API metrics, `/metrics` access rule, redaction, CLI disconnect and reconnect counters |
| `apps/api/src/__tests__/files-search-errors.test.ts` | `EMPTY_RESULT`/`OK` and each failure code |
| `apps/api/tests/files-search-routes.test.ts` | The HTTP error envelope |
| `apps/worker/tests/activity-observability.test.ts` | Interceptor records, outcomes, categories, metrics, loopback endpoint |
| `apps/api/tests/observability-fault-injection.test.ts` | Four injected executor faults and one Temporal start failure, end to end |

## Not covered

- **Supervisor failures lose their cause.** When `roomAgentSupervisorWorkflow`
  catches a failed child or activity, it records only generic text. Changing that
  is workflow code and would need `patched()`. The activity-level cause is in the
  worker log under the same `traceId`.
- **Some records still lack the request ID.** Room Agent missions and task runs
  have no `trace_id` or error-code column, and the store ignores the `traceId`
  argument of those methods. Adding them needs a migration. Today the link is
  `TURN_FAILED` (with the run ID) plus the workflow ID suffix.
- **Background continuations start a new trace.** They create
  `trace:bg-<uuid>`, linked only through `roomAgentContinuation.sourceRunId`.
  Chat-pane sends from room actions use `<actionId>:chat`.
- **CLI terminal task IDs are not linked.** `cliTaskId` and `revisionId` are not
  tied to request IDs.
- **Hosts are observed from the API, not instrumented.** Since 2026-10-12 the
  API's `/metrics` carries `space_host_up`, `space_host_start_time_seconds`,
  `space_host_observed_timestamp_seconds`, `space_host_resident_memory_bytes` and
  `space_host_cpu_seconds` for `host="cli-main"`, `"cli-admin"` and `"browser"`,
  plus `space_cli_host_sessions{status}`, `space_cli_host_attachments` and the
  Browser Host's session and live-workload capacity (`apps/api/src/host-metrics.ts`).
  The CLI hosts are checked every 30 s by the terminal manager; the Browser Host
  at each `/readyz`. Memory and CPU come from `/proc` only when the PID's command
  line is that host. The hosts themselves still have no metrics endpoint or
  spans (a normal deploy never restarts them), and the memory-maintenance and
  memory-mutation workers have no activity interceptor or metrics.
- **Some workflow-level faults are not in the trace lookup.** Workflow-task
  failures and nondeterminism appear only in Temporal history. The lookup returns
  events, audit entries and workflow rows, not `space_agent_runs` rows.
- **Span export covers API requests, workflows, and activities.** When `SPACE_OTEL_EXPORTER_OTLP_ENDPOINT`
  is configured, API server spans, workflow spans (via deterministic sinks), and activity spans are exported
  as a unified trace tree. Host processes (browser-host, cli-host) emit no spans directly.
- **Recovery counters are partial.** Recovery counters exist for plan model
  retries, CLI terminal reconnects and worker activity retries only.
- **Worker endpoints are not scraped yet.** Since 2026-10-14 stable's
  `deploy/space-worker.service` enables `127.0.0.1:9469/metrics` (worker
  activities) and `127.0.0.1:9464` (Temporal SDK); they take effect at the next
  promote. Dev and public installs keep them off (off by default). No collector
  scrapes them yet.
- **`/metrics` access on live, checked 2026-10-12 (d5af82d2d2).** Through the web
  origin that the public proxy forwards to (`127.0.0.1:4911`), `/metrics` is not
  proxied (it returns the app's HTML shell) and `/api/metrics` returns 401, also
  with a public `X-Forwarded-For`. The Prometheus text is served only by the API
  listener on loopback (`127.0.0.1:4910/metrics`, 200).
