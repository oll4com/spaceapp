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

## Optional API and worker tracing

`SPACE_OTEL_EXPORTER_OTLP_ENDPOINT` is a collector **base URL**, for example
`http://127.0.0.1:4318`. Set it separately in the environment of the API, main
Temporal worker, memory-maintenance worker, and memory-mutation worker. Each
posts OTLP/HTTP JSON to `<base>/v1/traces` under its own service name. In containers,
use a collector address reachable from that container; its loopback is not the
host loopback. This setting is outside `SpaceApiConfig` and its registry.

Export is off by default. Empty/invalid URLs or URLs with credentials, query
parameters, or fragments disable it. No tracing SDK, provider credential, or
paid backend is required. API spans parent workflow spans, which parent activity
attempts and child workflows; continuations include span links. Only allowlisted
identifiers, status/error codes, and durations are exported, never prompt/output
text, paths, full URLs, or exception messages.

The shared exporter bounds each queue at 4,096 spans, batches up to 256, flushes
every 5 seconds, and times out each POST after 3 seconds. It drops/counts excess
spans and counts failed batches. Collection never blocks workflow or activity
execution. Workflow spans appear at completion, failure, cancellation or
continue-as-new; an open supervisor has not emitted its final span yet.
See [observability](quality/observability.md#traces-w3c-trace-context) for replay
behavior, limits, and integration-test coverage.
