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
   - The agent runs of those workflows, then their background continuations
     (`continuationOf` names the run each one continues), and the Room Agent
     missions and task runs created under the ID.
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

The trace context is local by default. Set `SPACE_OTEL_EXPORTER_OTLP_ENDPOINT`
to an HTTP(S) collector base URL (for example `http://127.0.0.1:4318`) to enable
OTLP/HTTP JSON export. The shared runtime exporter always appends `/v1/traces`, so
the setting is the base URL, not the full traces path.
There is no OpenTelemetry runtime dependency and no export when the setting is absent
or invalid. Enable it separately for the API and each worker process.

- **API:** every request exports a SERVER span. A valid inbound `traceparent`
  continues the same trace with a new span. Missing or invalid context starts a
  new trace. Starters propagate the actual recorded API span in inputs/memo;
  Room Agent turns persist that context before enqueue so retries and recovery
  do not depend on the bounded in-memory request registry.
- **Workers:** `space-worker`, `space-memory-maintenance-worker`, and
  `space-memory-mutation-worker` share `createWorkerTracing`. Workflow execution,
  child workflows and every activity attempt export INTERNAL spans. Temporal
  headers carry the current workflow scope to activities (including those
  without arguments), local activities, child workflows and signals sent by a
  workflow. An activity's outbound API call uses its actual recorded span as the
  parent. The tracing modules that run in the workflow sandbox import only the
  small `@space/contracts/observability` and `@space/contracts/workflows` entry
  points, so enabling export does not bring the `@space/contracts` barrel into a
  workflow bundle that otherwise avoids it.
- **Long-lived supervisors:** each queued Room Agent mission has its own scope
  under its originating API span, with a link to the supervisor run. The
  supervisor run serves many requests, so it roots its own trace and only links
  to the request that started it. Work that belongs to no single request (the
  monitoring polls for background pane work, a stop signal, which carries no
  trace context, or a mission queued without context) stays in that supervisor
  trace and never joins an earlier request's trace. A paused mission is
  re-checked every second. Each check of an ordinary mission is a short mission
  span; a background continuation keeps one stable span identity, so it is
  exported once, from its first check until it finishes. The run span
  itself is exported only when the run ends (completion or continue-as-new), so
  while a supervisor is active or idle its mission and poll spans reference a
  parent the collector has not received yet.
- **Background continuations** begin a new trace with no parent and carry an
  OTLP link that is persisted in `continuedTraceparent`. The first continuation
  links to the request span of the operator turn it continues; each later one
  links to the preceding background mission span. An item queued by an earlier
  version still carries its source request context; it is kept as a link, never
  as a parent from another trace.
- **Continue-as-new:** each run has a distinct deterministic span ID, while its
  trace remains connected to the preceding run by a parent and an explicit link.
- **Failures:** a Temporal failure other than a cancellation (for example an
  `ApplicationFailure`) ends a workflow, signal or update span as `FAILED` with
  its safe code (a failed update is rejected and the workflow continues). A
  cancellation ends it as `CANCELLED`, and continue-as-new ends a run span as
  `CONTINUED_AS_NEW`. Any other error thrown from the workflow
  function or a signal or update handler only fails the workflow task, which
  Temporal retries while the execution keeps running, so no span is exported for
  it. This follows Temporal's default failure policy; Space configures no
  `workflowFailureErrorTypes` or `failureExceptionTypes`, which would make such
  an error terminal. A mission scope's caller can catch its errors, so an error
  leaving a mission callback is exported as a `FAILED` mission span. When a
  signal handler's Temporal failure ends the workflow, the signal span is
  exported but the run span is not, because the workflow function never returns.
- **Attributes:** bounded workflow/activity IDs and types, Space correlation IDs,
  attempt, outcome, duration, activity queue time and allowlisted failure codes.
  `space.trace_id` is the application's correlation ID; a distinct request ID uses
  `space.request_id`. Only named identifier fields are read. On export a Space
  correlation value must match a bounded `<kind>:<token>` identifier syntax (for
  example `room:V1StGXR8_Z5j`); other or oversized values, such as text with
  spaces, file names, paths and URLs, are dropped. The syntax cannot establish
  where a value came from, and it cannot remove private content that itself fits
  the syntax, so producers must supply generated identifiers. Prompts,
  responses, error messages, credentials and arbitrary headers are never read.
  Timestamps outside the OTLP range are dropped, and an invalid attempt number
  is omitted. API spans retain their existing shape.
- **Rollout:** deploy the API with or before the workers. Turns queued by an
  earlier API version keep the parent that version minted without exporting it,
  so those missions can show a missing parent in the collector.

### Replay compatibility and delivery

The workflow interceptor uses deterministic IDs derived from stable workflow/run
or mission identities and the Temporal workflow clock. It consumes no application
randomness and adds no activities, timers or markers. It sends primitive records
through a host-side sink configured with `callDuringReplay: false`; HTTP, batching
and error handling remain outside the workflow sandbox. No schema migration is
required: old inputs without either optional trace field still parse.

The integration suite executes real Temporal workflows against a local collector
and replays their captured histories, including an untraced history whose activity
ID was generated with `uuid4()`, and a committed Room Agent supervisor history
recorded by the 1.1.6 workflow code. Replay emits no spans. This proves those histories;
it does not retroactively repair missing context in older runs or replace a
read-only deployment replay against the histories of the target installation.

Export is best effort: a queue is bounded to 4,096 spans, batches contain up to
256 spans, the flush interval is five seconds, and a POST times out after three
seconds. Full queues and failed exports increment counters without blocking or
retrying business work. Workflow spans export when their execution scope finishes;
a still-running supervisor, process loss or external termination can leave an
unfinished scope. Workflow-task retries can emit the same deterministic span
identity again; replay suppression is not an exactly-once delivery guarantee.

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
| `packages/db/tests/room-agent-trace-postgres.test.ts` | Migration 0206 on a disposable PostgreSQL: mission trace and first error code, a continuation found from its source run |
| `apps/api/tests/trace-correlation.test.ts` | W3C context, log bindings, starter memo and input, Room Agent propagation, start-failure category, lookup projection |
| `apps/api/tests/observability-metrics.test.ts` | New API metrics, `/metrics` access rule, redaction, CLI disconnect and reconnect counters |
| `apps/api/src/__tests__/files-search-errors.test.ts` | `EMPTY_RESULT`/`OK` and each failure code |
| `apps/api/tests/files-search-routes.test.ts` | The HTTP error envelope |
| `apps/worker/tests/activity-observability.test.ts` | Interceptor records, headers, outbound parentage, attempt spans, privacy and failure containment |
| `apps/worker/tests/workflow-tracing.test.ts` | Deterministic IDs, concurrent scopes, invalid context, bounded metadata and replay-disabled sink |
| `apps/worker/tests/otlp-worker-integration.test.ts` | Real API, Temporal, child/local/remote activities, retries, both memory queues, continuations, replay, disabled export and slow/failing collectors |
| `apps/worker/tests/otlp-supervisor-integration.test.ts` | The production Room Agent supervisor through the API coordinator: two requests in one W3C trace keep their own API parents, and monitoring polls stay in the supervisor trace |
| `apps/worker/tests/otlp-supervisor-replay.test.ts` | A supervisor history recorded by the 1.1.6 workflow code (completed, stopped and failed missions, background polls) replays on the current code, traced and untraced, without exporting |
| `apps/worker/tests/otlp-task-failure.test.ts` | A non-Temporal error from the workflow function, a signal handler or an update handler fails a task that Temporal retries, with no span exported; Temporal failures export `FAILED` run, signal and update spans |
| `packages/runtime/tests/otlp-span-exporter.test.ts` | Optional valid OTLP links and export after an empty idle flush |
| `apps/api/tests/observability-fault-injection.test.ts` | Four injected executor faults and one Temporal start failure, end to end |

## Not covered

- **Supervisor failures lose their cause.** When `roomAgentSupervisorWorkflow`
  catches a failed child or activity, it records only generic text. Changing that
  is workflow code and would need `patched()`. The activity-level cause is in the
  worker log under the same `traceId`.
- **Room Agent missions and task runs: covered since 2026-10-16.** Migration
  0206 adds `trace_id` and `error_code` to `room_agent_missions` and
  `room_agent_task_runs`. The store writes the request trace on mission
  creation and on the first task-run write, and keeps the first error code.
  The continuation and token budgets record `ROOM_AGENT_CONTINUATION_LIMIT` and
  `ROOM_AGENT_TOKEN_LIMIT`. The trace lookup returns the trace's missions and
  task runs (ids, status, error code and times; never instructions). A failed
  mission's code is the cause when no event or agent run carries one. Still
  open: other mission failures (the supervisor workflow) record text, not a
  code, so they have no `error_code`.
- **Background continuations keep their own trace (followed since
  2026-10-16).** A continuation still runs as `trace:bg-<uuid>`, because the
  turn's workflow ID embeds its trace ID. The trace lookup now follows each
  continuation from the run it continues (`roomAgentContinuation.sourceRunId`,
  indexed by migration 0206, at most 50 generations and the row limit) and
  marks it with `continuationOf`. Its events and logs remain under its own
  trace ID. Chat-pane sends from room actions use `<actionId>:chat`.
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
  spans (a normal deploy never restarts them). Since 2026-10-16 the
  memory-maintenance and memory-mutation workers write the same `activity.started`
  and `activity.finished` records as the main worker; their counters stay
  in-process (no metrics endpoint of their own).
- **Some workflow-level faults are not in the trace lookup.** Workflow-task
  failures and nondeterminism appear only in Temporal history. Since 2026-10-16
  the lookup also returns the Space-native agent runs (`space_agent_runs`) of the
  trace's workflows, joined by workflow id, with their status and error code, and
  names a failed run's code as the cause when no event carries one.
- **Hosts emit no spans.** Since 2026-10-16 the OTLP exporter sends API SERVER
  spans and worker workflow, mission and activity spans (the worker and both
  memory workers); the CLI and Browser Hosts still join traces through log lines only.
- **Recovery counters are partial.** Recovery counters exist for plan model
  retries, CLI terminal reconnects and worker activity retries only.
- **Worker endpoints are not scraped yet.** Stable's `deploy/space-worker.service`
  enables `127.0.0.1:9469/metrics` (worker activities) and `127.0.0.1:9464`
  (Temporal SDK); on 2026-10-16 both answered on stable (`space_process_*` series,
  and 53 `temporal_*` lines). Dev and public installs keep them off (off by
  default). No collector scrapes them yet.
- **`/metrics` access on live, checked 2026-10-12 (d5af82d2d2).** Through the web
  origin that the public proxy forwards to (`127.0.0.1:4911`), `/metrics` is not
  proxied (it returns the app's HTML shell) and `/api/metrics` returns 401, also
  with a public `X-Forwarded-For`. The Prometheus text is served only by the API
  listener on loopback (`127.0.0.1:4910/metrics`, 200).
