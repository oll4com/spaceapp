# API configuration reference

For a first local contribution, follow [CONTRIBUTING](../CONTRIBUTING.md).
Production installation and provider login belong to the supported installer;
the API reference is for developers and operators reviewing advanced settings.

After installing workspace dependencies and building the internal packages:

```sh
npm run config:reference -w @space/api -- --defaults
npm run config:reference -w @space/api -- --check
```

The first command describes every field of `SpaceApiConfig` (the count grows as settings are added): API scope,
environment sources, exposure classification, validation category, deprecated
sources and defaults. It calls the existing parser with an empty environment;
it never describes the current process's secret values. Paths, service addresses
and secret defaults are redacted. The canonical memory month and optional helper
availability remain date/filesystem dependent, as they are in the API parser.

Sources are ordered as used by the parser. Some are fallback aliases (for example
`SPACE_GEMINI_VOICE_KEY_FILE` after `SPACE_GOOGLE_VOICE_KEY_FILE`); others are
dependencies (`SPACE_ARTIFACT_ROOT` for generated storage paths). CLI command,
credential and login keys come directly from the runtime descriptor registry.
No existing alias has been newly deprecated or removed. There is no second
default table to keep synchronized.

`--check` performs an advisory preflight of the supplied process environment:
literal boolean flags, positive integer syntax, API port and demo port range,
and the existing MCP/live-model structured parsers. It prints only field names,
source names and error codes, never submitted values or parser exceptions. Exit
codes are 0 for no detected issues, 1 for detected issues and 2 for invalid command
usage. Existing fallback/clamping behavior remains in `config.ts`; this command
does not start a service, change settings, enable a runtime or contact a provider.

This is a bounded configuration check, not installation readiness. It does not
verify URLs, credentials, file permissions, network reachability, provider
capabilities or cross-service compatibility. Authentication/server bootstrap,
worker, web build and installer environment fields outside `SpaceApiConfig` are
outside this registry. Full cross-service configuration coverage remains open.

## Optional OTLP trace export

`SPACE_OTEL_EXPORTER_OTLP_ENDPOINT` is read directly by the API and worker
tracing factories; it is outside the `SpaceApiConfig` registry above. Set it in
each process that should export, for example:

```sh
SPACE_OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

This is a collector **base URL**. The shared exporter appends `/v1/traces` and
sends OTLP/HTTP JSON. HTTP and HTTPS are accepted, including a path prefix;
embedded credentials, query strings and fragments are rejected. An unset,
empty or invalid URL disables export. Disabled workers install no tracing
workflow module or export timer and retain their existing activity logs and
metrics.

The setting applies to `space-api`, `space-worker`,
`space-memory-maintenance-worker` and `space-memory-mutation-worker`. Memory
workers still require their existing feature flags. API spans have kind SERVER;
workflow runs and activity attempts have kind INTERNAL. Propagation links the
actual API span to its workflow and activity attempts. Ordinary children inherit
the workflow parent; continue-as-new links consecutive runs, and background
turns start a fresh trace linked to their source when available. Replay suppresses
the export sink.

Production defaults are 256 spans per batch, 4096 queued spans, a 5-second flush
interval and a 3-second timeout per POST. There are no additional environment
settings for these limits. Full queues drop new spans; failures are counted and
never awaited on a request, workflow or activity's execution path. Worker
shutdown drains the closed queue using the same per-request deadlines.

API attributes contain method, route template, status and request ID. Worker
attributes are restricted to bounded IDs, types, attempt numbers, outcomes,
safe reason codes and categories. Prompts, outputs, error text, stack traces,
paths and arbitrary attributes are excluded. This enables traces only; it adds
no OTLP metrics exporter, sampling configuration, CLI Host or Browser Host spans.
See [observability and error semantics](quality/observability.md#traces-w3c-trace-context)
for implementation boundaries and the real Temporal/API validation commands.

## Optional modules

`SPACE_OPTIONAL_MODULES` turns on modules beyond the coding workspace:
`games` (chess and Asteroids benchmarks), `job-copilot`, `mail-copilot`,
`marketing-copilot`, `channels` (Slack and Teams), `telegram`, `waitlist` and
`desktop-updates` (desktop client release and update routes). Use `all`, `none`
or a comma-separated list. Without it, a public install
(`SPACE_PUBLIC_DISTRIBUTION=true`) starts with none of them and any other
install with all of them. A module that is off registers no routes, starts no
background work, and is hidden in the web app. Public installs upgraded from
1.1.x that used Job Copilot, the games, channels, Telegram or the desktop
routes set the modules they keep, for example
`SPACE_OPTIONAL_MODULES=job-copilot,games`.
