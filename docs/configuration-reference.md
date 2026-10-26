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


## Optional OTLP trace export (API and Temporal workers)

`SPACE_OTEL_EXPORTER_OTLP_ENDPOINT` is read directly by the API and each enabled
Temporal worker, outside `SpaceApiConfig`. It is unset/off by default. Set the
same HTTP(S) collector **base URL**, for example `http://127.0.0.1:4318`, in the
API, main worker, memory-maintenance worker and memory-mutation worker process
environments. The exporter appends `/v1/traces`; do not include that suffix.
Invalid URLs and URLs containing credentials, query strings or fragments disable
export. This setting does not enable an otherwise disabled memory worker.

The dependency-free shared `@space/telemetry` exporter sends OTLP/HTTP JSON:
API SERVER spans followed by connected workflow and activity-attempt spans.
Child workflows nest; continue-as-new and background continuations carry links.
Workflow replay does not export spans. Only allowlisted identifiers, types,
outcomes, stable error codes/categories and timings are recorded. Prompts,
model responses, file paths, URLs and exception messages are excluded.

Defaults are a 4096-span queue, 256-span batches, 5-second periodic flush and
3-second timeout per POST. Slow/failing collectors do not await or fail workflow
or activity work; overflow drops spans and counts the drops. Failed batches are
counted, not retried. Counters are available from `exporter.stats()`; they are
not a new metrics endpoint. Shutdown drains pending batches subject to the
per-request timeout. Active workflow runs export their span when the run ends.
There is no sampling or telemetry persistence setting.

See [observability](quality/observability.md#traces-w3c-trace-context) for
coverage, replay tests, limitations and the optional local Jaeger check.
